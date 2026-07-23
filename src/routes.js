import http from 'node:http'
import { URL } from 'node:url'
import {
  upstream,
  SERVER_AUTH,
  SERVER_URL,
  DEFAULT_MODEL,
  RAW,
  WATCHDOG_MS,
  MAX_POOL_SIZE,
  FALLBACK_MS,
} from './config.js'
import { serverReq, openMiMoEvents, agent } from './mimo-client.js'
import { isAuthorized, readBody, deny, bad } from './auth.js'
import {
  openAICompletion,
  openAIDelta,
  openAIDeltaRaw,
  extractText,
  genId,
  sse,
  calculateUsage,
  openAIStreamUsage,
} from './openai.js'
import {
  buildConversation,
  buildToolsSystemPrompt,
  normalizeToolXML,
  parseHermesToolCalls,
  formatToolPart,
  findCompleteToolBlocks,
  hasIncompleteToolBlock,
} from './tools.js'
import { categorizeTools } from './tool-mapper.js'

const MAX_MAP_ENTRIES = 500

function evictSet(set, max = MAX_MAP_ENTRIES) {
  if (set.size > max) {
    const iter = set.values()
    for (let i = 0; i < max / 2; i++) set.delete(iter.next().value)
  }
}

const sessionPool = []
let isDraining = false
let poolLock = false
const poolQueue = []

async function withPoolLock(fn) {
  if (poolLock) {
    return new Promise((resolve, reject) => {
      poolQueue.push(async () => {
        try { resolve(await fn()) } catch (e) { reject(e) }
      })
    })
  }
  poolLock = true
  try {
    return await fn()
  } finally {
    poolLock = false
    if (poolQueue.length > 0) poolQueue.shift()()
  }
}

export async function refillPool(retries = 3) {
  await withPoolLock(async () => {
    if (isDraining || sessionPool.length >= MAX_POOL_SIZE) return
    try {
      while (sessionPool.length < MAX_POOL_SIZE) {
        const resp = await serverReq('POST', '/session', {
          directory: process.cwd(),
          name: 'openai-bridge',
        })
        const sid = resp.json?.id
        if (sid) {
          sessionPool.push(sid)
        } else {
          break
        }
      }
    } catch (e) {
      if (retries > 0) {
        console.error(`Erro ao pre-criar sessao (${retries} retries left):`, e.message)
        await new Promise((r) => setTimeout(r, 2000))
        if (!isDraining) refillPool(retries - 1).catch(() => {})
      }
    }
  })
}

async function acquireSession() {
  return await withPoolLock(async () => {
    if (sessionPool.length > 0) {
      const sid = sessionPool.shift()
      refillPool().catch(() => {})
      return sid
    }
    const resp = await serverReq('POST', '/session', {
      directory: process.cwd(),
      name: 'openai-bridge',
    })
    const sid = resp.json?.id
    if (!sid) throw new Error('Sessao nao criada pelo MiMo')
    refillPool().catch(() => {})
    return sid
  })
}

async function releaseSession(sid, retries = 3) {
  if (!sid) return
  for (let i = 0; i < retries; i++) {
    try {
      await serverReq('DELETE', `/session/${sid}`)
      return
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)))
    }
  }
  console.error(`Falha ao deletar sessao ${sid} apos ${retries} tentativas`)
}

refillPool().catch(() => {})

export async function drainPool() {
  isDraining = true
  const sids = sessionPool.splice(0)
  await Promise.allSettled(sids.map((sid) =>
    serverReq('DELETE', `/session/${sid}`)
  ))
  isDraining = false
}

export function reverseProxy(clientReq, clientRes) {
  const targetPath = clientReq.url
  const headers = { ...clientReq.headers }
  headers['host'] = upstream.host
  if (SERVER_AUTH) headers['authorization'] = SERVER_AUTH

  const options = {
    method: clientReq.method,
    hostname: upstream.hostname,
    port: upstream.port,
    path: targetPath,
    agent,
    headers,
    timeout: 120000,
  }

  const proxyReq = http.request(options, (proxyRes) => {
    const out = { ...proxyRes.headers }
    if (proxyRes.headers['transfer-encoding']) delete out['content-length']
    clientRes.writeHead(proxyRes.statusCode || 502, out)
    proxyRes.pipe(clientRes, { end: true })
  })

  proxyReq.on('upgrade', (proxyRes, proxySocket, proxyHead) => {
    clientRes.writeHead(proxyRes.statusCode || 101, proxyRes.headers)
    if (proxyHead && proxyHead.length) proxySocket.write(proxyHead)
    proxySocket.pipe(clientReq.socket)
    clientReq.socket.pipe(proxySocket)
    proxySocket.on('error', () => clientReq.socket.destroy())
    clientReq.socket.on('error', () => proxySocket.destroy())
  })

  proxyReq.on('error', (err) => {
    console.error('Upstream error:', err.message)
    if (!clientRes.headersSent) {
      console.error('Upstream error detail:', err.message)
      clientRes.writeHead(502, { 'Content-Type': 'application/json' })
      clientRes.end(
        JSON.stringify({ error: 'Bad gateway' }),
      )
    }
  })

  clientReq.pipe(proxyReq, { end: true })
}

export function handleChatCompletions(clientReq, clientRes) {
  if (!isAuthorized(clientReq)) return deny(clientRes)

  readBody(clientReq)
    .then(async (body) => {
      const model = body.model || DEFAULT_MODEL
      const stream = body.stream === true
      const { system, parts } = buildConversation(body.messages, RAW)
      const clientTools =
        RAW && Array.isArray(body.tools) && body.tools.length ? body.tools : null
      const msgBody = { parts }

      let sys = system || ''

      if (clientTools) {
        const { native, unknown } = categorizeTools(clientTools)
        const toolsPrompt = buildToolsSystemPrompt(unknown.length > 0 ? unknown : clientTools, body.tool_choice)
        sys = sys ? sys + '\n' + toolsPrompt : toolsPrompt
        if (RAW) {
          const nativeNames = native.map(t => t.function.name)
          sys += '\n\n# Native tools available\nThese Mimo native tools are available: ' +
            nativeNames.join(', ') +
            '. When asked to use a matching tool, prefer the native tool with the closest name.'
          msgBody.tools = { '*': false }
        } else {
          msgBody.tools = { '*': false }
        }
      } else if (RAW) {
        msgBody.tools = { '*': false }
      }

      if (sys) msgBody.system = sys

      const genParams = [
        'temperature',
        'top_p',
        'max_tokens',
        'frequency_penalty',
        'presence_penalty',
        'stop',
        'seed',
      ]
      for (const p of genParams) {
        if (body[p] != null) msgBody[p] = body[p]
      }

      let sid
      try {
        sid = await acquireSession()
      } catch (e) {
        return bad(clientRes, 'Falha ao obter sessão do pool: ' + e.message, 502)
      }

      const created = Math.floor(Date.now() / 1000)
      const chatId = genId()

      if (!stream) {
        let tokensIn = 0
        let tokensOut = 0
        const subEvents = openMiMoEvents(
          (evt) => {
            if (evt.type === 'metrics.model_call' && evt.properties?.sessionID === sid) {
              tokensIn += evt.properties.total_tokens_in || 0
              tokensOut += evt.properties.total_tokens_out || 0
            }
          },
          () => {}
        )
        try {
          const resp = await serverReq('POST', `/session/${sid}/message`, msgBody)
          subEvents.close()

          let text = extractText(resp.json)
          let out

          let usage
          let parsedTools = null
          if (clientTools) {
            parsedTools = parseHermesToolCalls(text, clientTools)
          }

          if (tokensIn > 0 || tokensOut > 0) {
            usage = {
              prompt_tokens: tokensIn,
              completion_tokens: tokensOut,
              total_tokens: tokensIn + tokensOut,
            }
          } else if (parsedTools) {
            usage = calculateUsage(body.messages, parsedTools.content, parsedTools.toolCalls)
          } else {
            const norm = RAW ? normalizeToolXML(text) : text
            usage = calculateUsage(body.messages, norm, [])
          }

          if (parsedTools) {
            out = openAICompletion(chatId, model, created, parsedTools.content, parsedTools.toolCalls, usage)
          } else {
            if (RAW) text = normalizeToolXML(text)
            out = openAICompletion(chatId, model, created, text, null, usage)
          }
          clientRes.writeHead(200, { 'Content-Type': 'application/json' })
          clientRes.end(JSON.stringify(out))
        } catch (e) {
          subEvents.close()
          return bad(clientRes, 'Falha na chamada ao MiMo: ' + e.message, 502)
        } finally {
          releaseSession(sid)
        }
        return
      }

      // ---------- Streaming ----------
      if (clientRes.socket) {
        clientRes.socket.setNoDelay(true)
      }
      clientRes.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-Accel-Buffering': 'no',
      })
      if (typeof clientRes.flushHeaders === 'function') {
        clientRes.flushHeaders()
      }
      sse(clientRes, openAIDelta(chatId, model, created, null, 'role'))

      let finished = false
      let sentNormLen = 0
      const reasonLen = new Map()
      const reasonBuf = new Map()
      const partTypes = new Map()
      const toolAnnounced = new Set()
      const userMsgIds = new Set()
      const textBuf = new Map()
      let cachedFullText = ''
      let fullTextStale = false
      let messageResponseText = null
      let events = null

      const schemaByName = {}
      if (clientTools) {
        for (const t of clientTools) {
          if (t?.function?.name) schemaByName[t.function.name] = t.function.parameters
        }
      }

      const streamState = {
        sentTextLength: 0,
        sentBlockEnds: new Set(),
        totalToolCallsSent: 0,
        allToolCalls: [],
        cleanText: '',
        total_tokens_in: 0,
        total_tokens_out: 0,
      }

      function getFullText() {
        if (fullTextStale) {
          cachedFullText = [...textBuf.values()].join('')
          fullTextStale = false
        }
        return cachedFullText
      }

      const streamProgress = (fullText, isFinal = false) => {
        const hasToolTags = fullText.includes('<tool_call>') ||
          (clientTools && fullText.includes('[Called '))

        if (!hasToolTags) {
          if (fullText.length > streamState.sentTextLength) {
            const delta = fullText.slice(streamState.sentTextLength)
            streamState.sentTextLength = fullText.length
            streamState.cleanText = fullText
            sse(clientRes, openAIDelta(chatId, model, created, delta))
          }
          return
        }

        const blocks = findCompleteToolBlocks(fullText, schemaByName)

        let cleanText = ''
        let lastEnd = 0
        for (const b of blocks) {
          cleanText += fullText.slice(lastEnd, b.start)
          lastEnd = b.end
        }

        const incomplete = !isFinal && hasIncompleteToolBlock(fullText)
        if (incomplete) {
          const lastOpen = Math.max(
            fullText.lastIndexOf('<tool_call>'),
            fullText.lastIndexOf('[Called ')
          )
          if (lastOpen > lastEnd) {
            cleanText += fullText.slice(lastEnd, lastOpen)
          }
        } else {
          cleanText += fullText.slice(lastEnd)
        }

        streamState.cleanText = cleanText

        if (cleanText.length > streamState.sentTextLength) {
          const delta = cleanText.slice(streamState.sentTextLength)
          streamState.sentTextLength = cleanText.length
          sse(clientRes, openAIDelta(chatId, model, created, delta))
        }

        const sentEnds = streamState.sentBlockEnds
        for (const block of blocks) {
          if (sentEnds.has(block.end)) continue

          const tc = block.toolCall
          if (!tc) continue

          const delta = [{
            index: streamState.totalToolCallsSent,
            id: tc.id,
            type: tc.type,
            function: tc.function,
          }]
          streamState.allToolCalls.push(tc)
          sse(clientRes, openAIDeltaRaw(chatId, model, created, { tool_calls: delta }))
          streamState.totalToolCallsSent++
          sentEnds.add(block.end)
        }
      }

      const finish = (reason = 'stop') => {
        if (finished) return
        finished = true

        const textFromEvents = textBuf.size ? getFullText() : null
        const full = textFromEvents || messageResponseText || ''
        textBuf.clear()

        let finalText = ''
        let finalToolCalls = []

        if (RAW && full) {
          if (clientTools) {
            streamProgress(full, true)
            finalText = streamState.cleanText
            finalToolCalls = streamState.allToolCalls
            if (streamState.totalToolCallsSent > 0) {
              reason = 'tool_calls'
            }
          } else {
            const norm = normalizeToolXML(full)
            if (norm.length > sentNormLen) {
              const delta = norm.slice(sentNormLen)
              sentNormLen = norm.length
              sse(clientRes, openAIDelta(chatId, model, created, delta))
            }
            finalText = norm
          }
        } else if (messageResponseText) {
          if (messageResponseText.length > sentNormLen) {
            sse(clientRes, openAIDelta(chatId, model, created, messageResponseText.slice(sentNormLen)))
          }
          finalText = messageResponseText
        } else {
          finalText = full
        }

        try {
          sse(clientRes, openAIDelta(chatId, model, created, null, reason))

          let usage
          if (streamState.total_tokens_in > 0 || streamState.total_tokens_out > 0) {
            usage = {
              prompt_tokens: streamState.total_tokens_in,
              completion_tokens: streamState.total_tokens_out,
              total_tokens: streamState.total_tokens_in + streamState.total_tokens_out,
            }
          } else {
            usage = calculateUsage(body.messages, finalText, finalToolCalls)
          }
          sse(clientRes, openAIStreamUsage(chatId, model, created, usage))

          clientRes.write('data: [DONE]\n\n')
        } catch (e) {
          console.error('Erro ao enviar finish SSE:', e.message)
        }
        try {
          if (events) events.close()
        } catch (e) {
          console.error('Erro ao fechar event stream:', e.message)
        }
        clearTimeout(watchdog)
        releaseSession(sid)
        clientRes.end()
      }

      const handleEvent = (evt) => {
        if (finished) return
        clearTimeout(watchdog)
        watchdog = setTimeout(() => finish('stop'), WATCHDOG_MS)
        const t = evt.type
        if (t === 'message.updated') {
          const info = evt.properties?.info
          if (info && info.sessionID === sid && info.role === 'user') {
            userMsgIds.add(info.id)
          }
        } else if (t === 'metrics.model_call') {
          const props = evt.properties
          if (props && props.sessionID === sid) {
            streamState.total_tokens_in += props.total_tokens_in || 0
            streamState.total_tokens_out += props.total_tokens_out || 0
          }
        } else if (t === 'message.part.updated') {
          const part = evt.properties?.part
          if (!part || part.sessionID !== sid) return
          if (userMsgIds.has(part.messageID)) return

          if (part.type === 'text' && typeof part.text === 'string') {
            partTypes.set(part.id, 'text')
            textBuf.set(part.id, part.text)
            fullTextStale = true
            if (RAW && clientTools) {
              streamProgress(getFullText(), false)
            } else {
              const norm = RAW ? normalizeToolXML(getFullText()) : getFullText()
              if (norm.length > sentNormLen) {
                const delta = norm.slice(sentNormLen)
                sentNormLen = norm.length
                sse(clientRes, openAIDelta(chatId, model, created, delta))
              }
            }
          } else if (part.type === 'reasoning' && typeof part.text === 'string') {
            partTypes.set(part.id, 'reasoning')
            const buf = (reasonBuf.get(part.id) || '')
            const prev = Math.max(reasonLen.get(part.id) || 0, buf.length)
            if (part.text.length > prev) {
              const delta = part.text.slice(prev)
              reasonLen.set(part.id, part.text.length)
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: delta,
                }),
              )
            }
          } else if (part.type === 'tool') {
            const status = part.state?.status
            const key = part.callID + ':' + status
            if (status === 'running' && !toolAnnounced.has(key)) {
              toolAnnounced.add(key)
              evictSet(toolAnnounced)
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: '\n' + formatToolPart(part) + '\n',
                }),
              )
            } else if (status === 'completed' && !toolAnnounced.has(key)) {
              toolAnnounced.add(key)
              evictSet(toolAnnounced)
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: '✓ ' + (part.tool || 'tool') + '\n',
                }),
              )
            } else if (status === 'error' && !toolAnnounced.has(key)) {
              toolAnnounced.add(key)
              evictSet(toolAnnounced)
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: '✗ ' + (part.tool || 'tool') + '\n',
                }),
              )
            }
          }
        } else if (t === 'message.part.delta') {
          const props = evt.properties
          if (props?.sessionID !== sid || props?.field !== 'text' || !props?.partID) return
          const partID = props.partID
          const deltaText = props.delta || ''
          if (!deltaText) return

          const pType = partTypes.get(partID)

          if (pType === 'text') {
            const prev = textBuf.get(partID) || ''
            textBuf.set(partID, prev + deltaText)
            fullTextStale = true
            if (RAW && clientTools) {
              streamProgress(getFullText(), false)
            } else {
              const norm = RAW ? normalizeToolXML(getFullText()) : getFullText()
              if (norm.length > sentNormLen) {
                const d = norm.slice(sentNormLen)
                sentNormLen = norm.length
                sse(clientRes, openAIDelta(chatId, model, created, d))
              }
            }
          } else {
            const prev = reasonBuf.get(partID) || ''
            reasonBuf.set(partID, prev + deltaText)
            sse(
              clientRes,
              openAIDeltaRaw(chatId, model, created, {
                reasoning_content: deltaText,
              }),
            )
          }
        } else if (t === 'session.idle') {
          if (evt.properties?.sessionID === sid) finish('stop')
        }
      }

      let aborted = false
      clientRes.on('close', () => {
        aborted = true
        if (!finished) finish('stop')
      })

      events = openMiMoEvents(handleEvent, () => {
        if (!finished && !aborted) finish('stop')
      })

      let watchdog = setTimeout(() => finish('stop'), WATCHDOG_MS)

      serverReq('POST', `/session/${sid}/message`, msgBody)
        .then((resp) => {
          if (finished) return
          messageResponseText = extractText(resp.json)
          setTimeout(() => {
            if (!finished) finish('stop')
          }, FALLBACK_MS)
        })
        .catch((e) => {
          console.error('Erro no streaming:', e.message)
          if (!finished) {
            sse(
              clientRes,
              openAIDelta(chatId, model, created, 'Erro ao processar solicitacao'),
            )
            finish('stop')
          }
        })
    })
    .catch((e) => {
      if (e.message === 'Body too large') {
        return bad(clientRes, 'Payload muito grande (máximo 4MB)', 413)
      }
      return bad(clientRes, 'JSON inválido: ' + e.message, 400)
    })
}
