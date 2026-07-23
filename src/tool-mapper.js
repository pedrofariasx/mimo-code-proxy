import { NATIVE_TOOL_MAP, NATIVE_TOOL_NAMES } from './native-tools.js'

export function mapClientToNativeTool(clientToolName) {
  const exact = NATIVE_TOOL_MAP[clientToolName]
  if (exact) return exact.function.name

  const lower = clientToolName.toLowerCase()
  for (const name of NATIVE_TOOL_NAMES) {
    if (name.toLowerCase() === lower) return name
  }

  const aliasMap = {
    'read_file': 'Read',
    'readfile': 'Read',
    'write_file': 'Write',
    'writefile': 'Write',
    'edit_file': 'Edit',
    'editfile': 'Edit',
    'list_dir': 'ListDir',
    'list': 'ListDir',
    'ls': 'ListDir',
    'search': 'Grep',
    'find': 'Grep',
    'glob': 'Glob',
    'web_fetch': 'WebFetch',
    'web_fetch': 'WebFetch',
    'web_search': 'WebSearch',
    'code_search': 'CodeSearch',
    'codesearch': 'CodeSearch',
  }

  const alias = aliasMap[clientToolName]
  if (alias) return alias

  return null
}

export function categorizeTools(clientTools) {
  const native = []
  const unknown = []

  for (const tool of clientTools || []) {
    if (tool?.type !== 'function' || !tool?.function?.name) continue
    const mapped = mapClientToNativeTool(tool.function.name)
    if (mapped) {
      native.push({ ...tool, _mappedName: mapped })
    } else {
      unknown.push(tool)
    }
  }

  return { native, unknown }
}

export function convertToolCallToNative(tc, mapping) {
  const nativeName = mapping?.[tc.function?.name] || tc.function?.name
  return {
    type: 'function',
    id: tc.id,
    function: {
      name: nativeName,
      arguments: tc.function?.arguments || '{}',
    },
  }
}

export function convertToolResultsToNative(messages) {
  if (!messages?.length) return messages
  const callName = {}
  for (const m of messages) {
    if (m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const nativeName = mapClientToNativeTool(tc.function?.name) || tc.function?.name
        callName[tc.id] = nativeName
      }
    }
  }
  return messages.map(m => {
    if (m.role === 'tool') {
      const nativeName = callName[m.tool_call_id] || 'function'
      return { ...m, _nativeName: nativeName }
    }
    return m
  })
}
