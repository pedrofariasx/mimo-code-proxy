import crypto from 'node:crypto'
import { jsonrepair } from 'jsonrepair'
import { ToolStream } from '@pedrofariasx/toolstream'
import { XmlAdapter, FunctionTagAdapter } from '@pedrofariasx/toolstream/adapters'

export function messageText(m) {
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content)) {
    return m.content
      .filter(c => c.type === 'text' && typeof c.text === 'string')
      .map(c => c.text)
      .join('')
  }
  return ''
}

export function buildConversation(messages, raw) {
  const systemParts = []
  const turns = []
  const callName = {}
  for (const m of messages || []) {
    const text = messageText(m)
    if (m.role === 'system') {
      if (text) systemParts.push(text)
    } else if (m.role === 'assistant') {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : []
      let block = text || ''
      for (const c of calls) {
        const fn = c.function?.name || 'function'
        callName[c.id] = fn
        const args = c.function?.arguments || '{}'
        block += `${block ? '\n' : ''}[Called ${fn} with ${args}]`
      }
      if (block) turns.push(raw ? `Assistant:\n${block}` : block)
    } else if (m.role === 'tool') {
      if (!text) continue
      const fn = callName[m.tool_call_id] || 'function'
      turns.push(raw ? `Result of ${fn}:\n${text}` : text)
    } else {
      if (text) turns.push(raw ? `Human:\n${text}` : text)
    }
  }
  const system = systemParts.join('\n') || undefined
  const transcript = turns.join(raw ? '\n\n' : '\n')
  return { system, parts: [{ type: 'text', text: transcript }] }
}

export function normalizeToolXML(text) {
  if (!text || text.indexOf('<') === -1) return text
  let t = text
  t = t.replace(
    /<function=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/function>/g,
    (m, name, inner) => {
      const body = inner.replace(
        /<parameter=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/g,
        (mm, p, v) => `<${p}>${v}</${p}>`,
      )
      return `<${name}>${body}</${name}>`
    },
  )
  t = t.replace(
    /<function_name>\s*([a-zA-Z0-9_.-]+)\s*<\/function_name>([\s\S]*?)(?=<\/tool_call>|$)/g,
    (m, name, inner) => {
      const body = inner.replace(
        /<param\s+name=["']([a-zA-Z0-9_.-]+)["']\s*>([\s\S]*?)<\/param>/g,
        (mm, p, v) => `<${p}>${v}</${p}>`,
      )
      return `<${name}>${body}</${name}>`
    },
  )
  t = t.replace(/<tool_call>\s*/g, '').replace(/\s*<\/tool_call>/g, '')
  return t
}

export function buildToolsSystemPrompt(tools, toolChoice) {
  const defs = tools
    .filter(t => t && t.type === 'function' && t.function)
    .map(t => JSON.stringify(t.function))
  let choice = ''
  if (toolChoice === 'required') {
    choice = '\nYou MUST call at least one function in your reply.'
  } else if (
    toolChoice &&
    typeof toolChoice === 'object' &&
    toolChoice.function?.name
  ) {
    choice = `\nYou MUST call the function "${toolChoice.function.name}".`
  }
  return [
    '# Function calling',
    'You can call functions. To call one, output EXACTLY this format (and nothing else for that call):',
    '<tool_call>',
    '<function=FUNCTION_NAME>',
    '<parameter=PARAM_NAME>VALUE</parameter>',
    '</function>',
    '</tool_call>',
    'Call multiple functions with multiple <tool_call> blocks. Put each parameter value as raw text (no quotes).',
    choice,
    '',
    'Available functions (JSON schema):',
    ...defs,
  ].join('\n')
}

function coerceToolCallArgs(name, args, schemaByName) {
  const schema = schemaByName[name]
  if (!schema?.properties) return args
  const coerced = { ...args }
  for (const [key, value] of Object.entries(coerced)) {
    if (typeof value === 'string') {
      const propSchema = schema.properties[key]
      if (propSchema?.type) {
        coerced[key] = coerceParam(value, propSchema, key)
      }
    }
  }
  return coerced
}

function coerceParam(value, schema, paramName) {
  let v = value
  v = v.replace(/^\r?\n/, '').replace(/\r?\n$/, '')

  const type = schema?.type
  if (type === 'boolean') {
    const s = v.trim().toLowerCase()
    return s === 'true' || s === '1' || s === 'yes'
  }
  if (type === 'number' || type === 'integer') {
    const n = Number(v.trim())
    return Number.isNaN(n) ? v : n
  }
  if (type === 'object' || type === 'array') {
    try {
      return JSON.parse(v)
    } catch {
      const stripped = v.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '').trim()
      try {
        return JSON.parse(stripped)
      } catch {
        try {
          return JSON.parse(jsonrepair(stripped))
        } catch {
          return v
        }
      }
    }
  }

  const preserveWhitespaceParams = [
    'content', 'text', 'code', 'newstring', 'oldstring',
    'patch', 'diff', 'file_text', 'new_string', 'old_string',
    'new_str', 'old_str', 'replacement', 'search',
  ]
  const nameLower = (paramName || '').toLowerCase()
  if (!preserveWhitespaceParams.includes(nameLower)) {
    v = v.trim()
  }
  return v
}

function preprocessForXml(chunk) {
  return chunk
    .replace(/<function=([a-zA-Z0-9_.-]+)>/g, '<tool_name>$1</tool_name>')
    .replace(/<\/function>/g, '')
}

function parseXMLText(text, schemaByName) {
  const xmlAdapter = new XmlAdapter()
  const stream = new ToolStream({ provider: 'custom' })
  stream.setCustomAdapter(xmlAdapter)
  const prepared = preprocessForXml(text)
  stream.push(prepared)
  const results = stream.finalize()
  return results
    .filter(tc => !schemaByName || Object.keys(schemaByName).length === 0 || schemaByName[tc.name])
    .map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(
          schemaByName && schemaByName[tc.name]
            ? coerceToolCallArgs(tc.name, tc.arguments, schemaByName)
            : tc.arguments
        ),
      },
    }))
}

function parseCalledText(text, schemaByName) {
  if (!text.includes('[Called ')) return []
  const ftAdapter = new FunctionTagAdapter()
  const stream = new ToolStream({ provider: 'custom' })
  stream.setCustomAdapter(ftAdapter)
  stream.push(text)
  return stream.finalize()
    .filter(tc => !schemaByName || Object.keys(schemaByName).length === 0 || schemaByName[tc.name])
    .map(tc => ({
      id: tc.id,
      type: 'function',
      function: {
        name: tc.name,
        arguments: JSON.stringify(
          schemaByName && schemaByName[tc.name]
            ? coerceToolCallArgs(tc.name, tc.arguments, schemaByName)
            : tc.arguments
        ),
      },
    }))
}

function parseWithAdapters(text, schemaByName) {
  const results = []
  const seen = new Set()

  const xml = parseXMLText(text, schemaByName)
  for (const tc of xml) {
    const key = JSON.stringify(tc.function)
    if (!seen.has(key)) {
      results.push(tc)
      seen.add(key)
    }
  }

  const called = parseCalledText(text, schemaByName)
  for (const tc of called) {
    const key = JSON.stringify(tc.function)
    if (!seen.has(key)) {
      results.push(tc)
      seen.add(key)
    }
  }

  return results
}

export function parseHermesToolCalls(text, tools) {
  if (!text) return { content: '', toolCalls: [] }

  const schemaByName = {}
  const knownNames = []
  for (const t of tools || []) {
    if (t?.function?.name) {
      schemaByName[t.function.name] = t.function.parameters
      knownNames.push(t.function.name)
    }
  }

  const hasSchema = knownNames.length > 0
  const seen = new Set()
  const toolCalls = []

  const parsed = parseWithAdapters(text, schemaByName)
  for (const tc of parsed) {
    const key = JSON.stringify(tc.function)
    if (!seen.has(key)) {
      toolCalls.push(tc)
      seen.add(key)
    }
  }

  let content = text
  const xmlRe = /<tool_call>[\s\S]*?<\/tool_call>/g
  content = content.replace(xmlRe, '').trim()
  if (hasSchema) {
    const nameRe = knownNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    content = content.replace(new RegExp(`\\[Called (${nameRe}) with [^\\]]+\\]`, 'g'), '').trim()
  } else {
    content = content.replace(/\[Called [^\]]+\]/g, '').trim()
  }
  content = content.replace(/<function=[\s\S]*?<\/function>/g, '').trim()

  return { content, toolCalls }
}

export function parseCalledBlocks(text, schemaByName) {
  const results = []
  const marker = '[Called '
  let searchFrom = 0
  while (true) {
    const idx = text.indexOf(marker, searchFrom)
    if (idx === -1) break
    const nameStart = idx + marker.length
    const nameMatch = text.slice(nameStart).match(/^([a-zA-Z0-9_.-]+)\s+with\s+/)
    if (!nameMatch) {
      searchFrom = idx + 1
      continue
    }
    const name = nameMatch[1]
    const jsonStart = nameStart + nameMatch[0].length
    if (text[jsonStart] !== '{') {
      searchFrom = idx + 1
      continue
    }
    const jsonStr = extractBalancedJSON(text, jsonStart)
    if (!jsonStr) {
      searchFrom = idx + 1
      continue
    }
    const endBracket = text.indexOf(']', jsonStart + jsonStr.length)
    if (endBracket === -1) {
      searchFrom = idx + 1
      continue
    }
    const fullEnd = endBracket + 1
    if (schemaByName && Object.keys(schemaByName).length > 0 && !schemaByName[name]) {
      searchFrom = fullEnd
      continue
    }
    let args
    try {
      args = JSON.parse(jsonStr)
    } catch {
      try {
        args = JSON.parse(jsonrepair(jsonStr))
      } catch {
        searchFrom = fullEnd
        continue
      }
    }
    results.push({
      start: idx,
      end: fullEnd,
      toolCall: {
        id: 'call_' + crypto.randomBytes(8).toString('hex'),
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
      },
    })
    searchFrom = fullEnd
  }
  return results
}

export function extractBalancedJSON(str, startIdx) {
  let depth = 0
  let inString = false
  let escape = false
  for (let i = startIdx; i < str.length; i++) {
    const ch = str[i]
    if (escape) { escape = false; continue }
    if (ch === '\\' && inString) { escape = true; continue }
    if (ch === '"') { inString = !inString; continue }
    if (inString) continue
    if (ch === '{' || ch === '[') depth++
    else if (ch === '}' || ch === ']') {
      depth--
      if (depth === 0) return str.slice(startIdx, i + 1)
    }
  }
  return null
}

export function findCompleteToolBlocks(text, schemaByName) {
  const blocks = []

  const blockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g
  let m
  while ((m = blockRe.exec(text)) !== null) {
    const inner = m[1].trim()
    if (!inner) continue
    const toolCalls = parseWithAdapters(m[0], schemaByName)
    if (toolCalls.length > 0) {
      blocks.push({ start: m.index, end: blockRe.lastIndex, type: 'xml', toolCall: toolCalls[0] })
    }
  }

  const calledBlocks = parseCalledBlocks(text, schemaByName)
  for (const b of calledBlocks) {
    blocks.push({ start: b.start, end: b.end, type: 'called', toolCall: b.toolCall })
  }

  blocks.sort((a, b) => a.start - b.start)
  return blocks
}

export function hasIncompleteToolBlock(text) {
  if (!text) return false
  const lastOpen = text.lastIndexOf('<tool_call>')
  if (lastOpen !== -1) {
    const afterOpen = text.slice(lastOpen)
    if (!afterOpen.includes('</tool_call>')) return true
  }
  const lastCalled = text.lastIndexOf('[Called ')
  if (lastCalled !== -1) {
    const afterCalled = text.slice(lastCalled)
    if (!afterCalled.includes(']')) return true
    const jsonStart = afterCalled.indexOf('{')
    if (jsonStart !== -1) {
      const jsonStr = extractBalancedJSON(afterCalled, jsonStart)
      if (!jsonStr) return true
    }
  }
  return false
}

export function formatToolPart(part) {
  const name = part.tool || 'tool'
  const input = part.state?.input
  let arg = ''
  if (input && typeof input === 'object') {
    const key =
      input.file_path ??
      input.filePath ??
      input.path ??
      input.command ??
      input.pattern ??
      input.query ??
      input.url
    if (key != null) arg = String(key)
    else arg = JSON.stringify(input)
    if (arg.length > 120) arg = arg.slice(0, 117) + '...'
  }
  return arg ? `${name}(${arg})` : name
}
