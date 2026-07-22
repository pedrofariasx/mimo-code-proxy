import { ToolStream } from '@pedrofariasx/toolstream'
import { XmlAdapter, FunctionTagAdapter } from '@pedrofariasx/toolstream/adapters'
import { jsonrepair } from 'jsonrepair'

function preprocessForXml(chunk) {
  return chunk
    .replace(/<function=([a-zA-Z0-9_.-]+)>/g, '<tool_name>$1</tool_name>')
    .replace(/<\/function>/g, '')
}

export function createToolStream() {
  const adapter = new XmlAdapter()
  const stream = new ToolStream({ provider: 'xml' })
  stream.setCustomAdapter(adapter)
  return stream
}

export function parseToolCalls(text) {
  if (!text) return []

  const xmlStream = createToolStream()
  xmlStream.push(preprocessForXml(text))
  const xmlCalls = xmlStream.finalize()

  if (xmlCalls.length > 0) {
    return xmlCalls.map(repairToolCallArgs)
  }

  if (text.includes('[Called ')) {
    const ftAdapter = new FunctionTagAdapter()
    const ftStream = new ToolStream({ provider: 'custom' })
    ftStream.setCustomAdapter(ftAdapter)
    ftStream.push(text)
    return ftStream.finalize().map(repairToolCallArgs)
  }

  return []
}

function repairToolCallArgs(call) {
  if (call.repaired && Object.keys(call.arguments).length) return call
  if (!call.raw || Object.keys(call.arguments).length) return call
  try {
    call.arguments = JSON.parse(call.raw)
  } catch {
    try {
      const repaired = jsonrepair(call.raw)
      call.arguments = JSON.parse(repaired)
      call.repaired = true
    } catch {
    }
  }
  return call
}

export function stripToolCalls(text, knownNames = null) {
  if (!text) return text
  if (knownNames && knownNames.length > 0) {
    const nameRe = knownNames.map(n => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
    let result = text
      .replace(new RegExp(`<tool_call>[\\s\\S]*?<function=(${nameRe})>[\\s\\S]*?<\\/tool_call>`, 'g'), '')
      .replace(new RegExp(`\\[Called (${nameRe}) with [^\\]]+\\]`, 'g'), '')
    return result.replace(/\n{3,}/g, '\n\n').trim()
  }
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '')
    .replace(/\[Called [^\]]+\]/g, '')
    .replace(/<function=[\s\S]*?<\/function>/g, '')
    .trim()
}

export function hasIncompleteToolCall(text) {
  if (!text) return false
  const lastOpen = text.lastIndexOf('<tool_call>')
  if (lastOpen !== -1) {
    const afterOpen = text.slice(lastOpen + 10)
    if (!afterOpen.includes('</tool_call>')) return true
  }
  const lastCalled = text.lastIndexOf('[Called ')
  if (lastCalled !== -1) {
    const afterCalled = text.slice(lastCalled + 8)
    if (!afterCalled.includes(']')) return true
    const jsonStart = afterCalled.indexOf('{')
    if (jsonStart !== -1) {
      let depth = 0; let inStr = false; let esc = false
      for (let i = jsonStart; i < afterCalled.length; i++) {
        const ch = afterCalled[i]
        if (esc) { esc = false; continue }
        if (ch === '\\' && inStr) { esc = true; continue }
        if (ch === '"') { inStr = !inStr; continue }
        if (inStr) continue
        if (ch === '{' || ch === '[') depth++
        else if (ch === '}' || ch === ']') depth--
      }
      if (depth > 0) return true
    }
  }
  return false
}

export function findCompleteToolCallBlocks(text) {
  if (!text) return []
  const blocks = []
  const re = /<tool_call>([\s\S]*?)<\/tool_call>/g
  let match
  while ((match = re.exec(text)) !== null) {
    const inner = match[1].trim()
    if (inner) blocks.push({ start: match.index, end: match.index + match[0].length })
  }
  const calledRe = /\[Called\s+([a-zA-Z0-9_.-]+)\s+with\s+(\{[^{}]*(\{[^{}]*\}[^{}]*)*\})\]/g
  while ((match = calledRe.exec(text)) !== null) {
    blocks.push({ start: match.index, end: match.index + match[0].length })
  }
  blocks.sort((a, b) => a.start - b.start)
  return blocks
}

export function toToolCallDelta(tc, index) {
  return [{
    index,
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  }]
}

export function toLegacyToolCall(tc) {
  return {
    id: tc.id,
    type: 'function',
    function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
  }
}
