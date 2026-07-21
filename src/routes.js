import http from "node:http";
import { URL } from "node:url";
import {
  upstream,
  SERVER_AUTH,
  SERVER_URL,
  DEFAULT_MODEL,
  RAW,
  WATCHDOG_MS,
} from "./config.js";
import { serverReq, openMiMoEvents } from "./mimo-client.js";
import { isAuthorized, readBody, deny, bad } from "./auth.js";
import {
  openAIModels,
  openAICompletion,
  openAIDelta,
  openAIDeltaRaw,
  extractText,
  genId,
  sse,
  calculateUsage,
  openAIStreamUsage,
} from "./openai.js";
import {
  buildConversation,
  buildToolsSystemPrompt,
  normalizeToolXML,
  parseHermesToolCalls,
  formatToolPart,
} from "./tools.js";

const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000 });

const MAX_MAP_ENTRIES = 500;

const sessionPool = [];
const MAX_POOL_SIZE = 2;
let isRefilling = false;

export async function refillPool() {
  if (isRefilling || sessionPool.length >= MAX_POOL_SIZE) return;
  isRefilling = true;
  try {
    while (sessionPool.length < MAX_POOL_SIZE) {
      const resp = await serverReq("POST", "/session", {
        directory: process.cwd(),
        name: "openai-bridge",
      });
      const sid = resp.json?.id;
      if (sid) {
        sessionPool.push(sid);
      } else {
        break;
      }
    }
  } catch (e) {
    console.error("Erro ao pre-criar sessão no pool:", e.message);
    // Tenta novamente em 2 segundos se falhar (ex: servidor MiMo ainda subindo)
    setTimeout(() => refillPool().catch(() => {}), 2000);
  } finally {
    isRefilling = false;
  }
}

async function acquireSession() {
  if (sessionPool.length > 0) {
    const sid = sessionPool.shift();
    refillPool().catch(() => {});
    return sid;
  }
  const resp = await serverReq("POST", "/session", {
    directory: process.cwd(),
    name: "openai-bridge",
  });
  const sid = resp.json?.id;
  if (!sid) throw new Error("Sessão não criada pelo MiMo");
  refillPool().catch(() => {});
  return sid;
}

async function releaseSession(sid, retries = 3) {
  if (!sid) return;
  if (sessionPool.length < MAX_POOL_SIZE) {
    sessionPool.push(sid);
    return;
  }
  for (let i = 0; i < retries; i++) {
    try {
      await serverReq("DELETE", `/session/${sid}`);
      return;
    } catch {
      if (i < retries - 1) await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  console.error(`Falha ao deletar sessão ${sid} após ${retries} tentativas`);
}

// Inicializa o pool de sessões
refillPool().catch(() => {});

export function reverseProxy(clientReq, clientRes) {
  const targetPath = clientReq.url;
  const headers = { ...clientReq.headers };
  headers["host"] = upstream.host;
  if (SERVER_AUTH) headers["authorization"] = SERVER_AUTH;

  const options = {
    method: clientReq.method,
    hostname: upstream.hostname,
    port: upstream.port,
    path: targetPath,
    agent,
    headers,
    timeout: 120000,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    const out = { ...proxyRes.headers };
    if (proxyRes.headers["transfer-encoding"]) delete out["content-length"];
    clientRes.writeHead(proxyRes.statusCode || 502, out);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    clientRes.writeHead(proxyRes.statusCode || 101, proxyRes.headers);
    if (proxyHead && proxyHead.length) proxySocket.write(proxyHead);
    proxySocket.pipe(clientReq.socket);
    clientReq.socket.pipe(proxySocket);
    proxySocket.on("error", () => clientReq.socket.destroy());
    clientReq.socket.on("error", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    console.error("Upstream error:", err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { "Content-Type": "application/json" });
      clientRes.end(
        JSON.stringify({ error: "Bad gateway", detail: err.message }),
      );
    }
  });

  clientReq.pipe(proxyReq, { end: true });
}

export function handleChatCompletions(clientReq, clientRes) {
  if (!isAuthorized(clientReq)) return deny(clientRes);

  readBody(clientReq)
    .then(async (body) => {
      const model = body.model || DEFAULT_MODEL;
      const stream = body.stream === true;
      const { system, parts } = buildConversation(body.messages, RAW);
      const clientTools =
        RAW && Array.isArray(body.tools) && body.tools.length ? body.tools : null;
      const msgBody = { parts };
      let sys = system || "";
      if (clientTools) {
        const toolsPrompt = buildToolsSystemPrompt(clientTools, body.tool_choice);
        sys = sys ? sys + "\n\n" + toolsPrompt : toolsPrompt;
      }
      if (RAW) {
        msgBody.tools = { "*": false };
        if (sys) msgBody.system = sys;
      } else if (sys) {
        msgBody.system = sys;
      }

      const genParams = [
        "temperature",
        "top_p",
        "max_tokens",
        "frequency_penalty",
        "presence_penalty",
        "stop",
        "seed",
      ];
      for (const p of genParams) {
        if (body[p] != null) msgBody[p] = body[p];
      }

      let sid;
      try {
        sid = await acquireSession();
      } catch (e) {
        return bad(clientRes, "Falha ao obter sessão do pool: " + e.message, 502);
      }

      const created = Math.floor(Date.now() / 1000);
      const chatId = genId();

      // ---------- Não-streaming ----------
      if (!stream) {
        let tokensIn = 0;
        let tokensOut = 0;
        const subEvents = openMiMoEvents(
          (evt) => {
            if (evt.type === "metrics.model_call" && evt.properties?.sessionID === sid) {
              tokensIn += evt.properties.total_tokens_in || 0;
              tokensOut += evt.properties.total_tokens_out || 0;
            }
          },
          () => {}
        );
        try {
          const resp = await serverReq("POST", `/session/${sid}/message`, msgBody);
          // Pequena pausa para garantir a entrega de eventos finais no stream
          await new Promise((resolve) => setTimeout(resolve, 50));
          subEvents.close();

          let text = extractText(resp.json);
          let out;

          let usage;
          if (tokensIn > 0 || tokensOut > 0) {
            usage = {
              prompt_tokens: tokensIn,
              completion_tokens: tokensOut,
              total_tokens: tokensIn + tokensOut,
            };
          } else {
            if (clientTools) {
              const { content, toolCalls } = parseHermesToolCalls(text, clientTools);
              usage = calculateUsage(body.messages, content, toolCalls);
            } else {
              const norm = RAW ? normalizeToolXML(text) : text;
              usage = calculateUsage(body.messages, norm, []);
            }
          }

          if (clientTools) {
            const { content, toolCalls } = parseHermesToolCalls(text, clientTools);
            out = openAICompletion(chatId, model, created, content, toolCalls, usage);
          } else {
            if (RAW) text = normalizeToolXML(text);
            out = openAICompletion(chatId, model, created, text, null, usage);
          }
          clientRes.writeHead(200, { "Content-Type": "application/json" });
          clientRes.end(JSON.stringify(out));
        } catch (e) {
          subEvents.close();
          return bad(clientRes, "Falha na chamada ao MiMo: " + e.message, 502);
        } finally {
          releaseSession(sid);
        }
        return;
      }

      // ---------- Streaming ----------
      clientRes.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Transfer-Encoding": "chunked",
        "X-Accel-Buffering": "no",
      });
      sse(clientRes, openAIDelta(chatId, model, created, null, "role"));

      let finished = false;
      const sentLen = new Map();
      const reasonLen = new Map();
      const reasonBuf = new Map();
      const partTypes = new Map();
      const toolAnnounced = new Set();
      const userMsgIds = new Set();
      const textBuf = new Map();
      let messageResponseText = null;
      let events = null;

      const streamState = {
        sentTextLength: 0,
        sentToolCallsCount: 0,
        totalToolCallsSent: 0,
        allToolCalls: [],
        cleanText: "",
        total_tokens_in: 0,
        total_tokens_out: 0,
      };

      const streamProgress = (fullText, isFinal = false) => {
        let lastTextEnd = 0;
        let cleanText = "";
        const matches = [];
        const blockRe = /<tool_call>([\s\S]*?)(?:<\/tool_call>|$)/g;
        let m;
        while ((m = blockRe.exec(fullText)) !== null) {
          const matchStart = m.index;
          const matchEnd = blockRe.lastIndex;
          const precedingText = fullText.slice(lastTextEnd, matchStart);
          cleanText += precedingText;
          matches.push({
            inner: m[1],
            isComplete: m[0].endsWith("</tool_call>") || isFinal,
          });
          lastTextEnd = matchEnd;
        }
        if (lastTextEnd < fullText.length) {
          cleanText += fullText.slice(lastTextEnd);
        }

        streamState.cleanText = cleanText;

        // 1. Stream new text content
        if (cleanText.length > streamState.sentTextLength) {
          const delta = cleanText.slice(streamState.sentTextLength);
          streamState.sentTextLength = cleanText.length;
          sse(clientRes, openAIDelta(chatId, model, created, delta));
        }

        // 2. Stream completed tool calls
        for (let i = 0; i < matches.length; i++) {
          const match = matches[i];
          if (match.isComplete && i >= streamState.sentToolCallsCount) {
            const parsed = parseHermesToolCalls("<tool_call>" + match.inner + "</tool_call>", clientTools);
            if (parsed.toolCalls && parsed.toolCalls.length) {
              const deltas = parsed.toolCalls.map((tc, idx) => {
                const item = {
                  index: streamState.totalToolCallsSent + idx,
                  ...tc,
                };
                streamState.allToolCalls.push(tc);
                return item;
              });
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, { tool_calls: deltas }),
              );
              streamState.totalToolCallsSent += parsed.toolCalls.length;
            }
            streamState.sentToolCallsCount = i + 1;
          }
        }
      };

      const finish = (reason = "stop") => {
        if (finished) return;
        finished = true;

        const textFromEvents = textBuf.size ? [...textBuf.values()].join("") : null;
        const full = textFromEvents || messageResponseText || "";
        textBuf.clear();

        let finalText = "";
        let finalToolCalls = [];

        if (RAW && full) {
          if (clientTools) {
            streamProgress(full, true);
            finalText = streamState.cleanText;
            finalToolCalls = streamState.allToolCalls;
            if (streamState.totalToolCallsSent > 0) {
              reason = "tool_calls";
            }
          } else {
            const norm = normalizeToolXML(full);
            const prev = sentLen.get("norm") || 0;
            if (norm.length > prev) {
              const delta = norm.slice(prev);
              sentLen.set("norm", norm.length);
              sse(clientRes, openAIDelta(chatId, model, created, delta));
            }
            finalText = norm;
          }
        } else if (messageResponseText) {
          const already = [...sentLen.values()].reduce((a, b) => a + b, 0);
          if (messageResponseText.length > already) {
            sse(clientRes, openAIDelta(chatId, model, created, messageResponseText.slice(already)));
          }
          finalText = messageResponseText;
        } else {
          finalText = full;
        }

        try {
          sse(clientRes, openAIDelta(chatId, model, created, null, reason));

          let usage;
          if (streamState.total_tokens_in > 0 || streamState.total_tokens_out > 0) {
            usage = {
              prompt_tokens: streamState.total_tokens_in,
              completion_tokens: streamState.total_tokens_out,
              total_tokens: streamState.total_tokens_in + streamState.total_tokens_out,
            };
          } else {
            usage = calculateUsage(body.messages, finalText, finalToolCalls);
          }
          sse(clientRes, openAIStreamUsage(chatId, model, created, usage));

          clientRes.write("data: [DONE]\n\n");
        } catch {}
        try {
          if (events) events.close();
        } catch {}
        clearTimeout(watchdog);
        releaseSession(sid);
        clientRes.end();
      };

      const handleEvent = (evt) => {
        if (finished) return;
        clearTimeout(watchdog);
        watchdog = setTimeout(() => finish("stop"), WATCHDOG_MS);
        const t = evt.type;
        if (t === "message.updated") {
          const info = evt.properties?.info;
          if (info && info.sessionID === sid && info.role === "user") {
            userMsgIds.add(info.id);
          }
        } else if (t === "metrics.model_call") {
          const props = evt.properties;
          if (props && props.sessionID === sid) {
            streamState.total_tokens_in += props.total_tokens_in || 0;
            streamState.total_tokens_out += props.total_tokens_out || 0;
          }
        } else if (t === "message.part.updated") {
          const part = evt.properties?.part;
          if (!part || part.sessionID !== sid) return;
          if (userMsgIds.has(part.messageID)) return;

          if (part.type === "text" && typeof part.text === "string") {
            partTypes.set(part.id, "text");
            textBuf.set(part.id, part.text);
            if (RAW && clientTools) {
              const fullText = [...textBuf.values()].join("");
              streamProgress(fullText, false);
            } else {
              const fullText = [...textBuf.values()].join("");
              const norm = RAW ? normalizeToolXML(fullText) : fullText;
              const prev = sentLen.get("norm") || 0;
              if (norm.length > prev) {
                const delta = norm.slice(prev);
                sentLen.set("norm", norm.length);
                sse(clientRes, openAIDelta(chatId, model, created, delta));
              }
            }
          } else if (part.type === "reasoning" && typeof part.text === "string") {
            partTypes.set(part.id, "reasoning");
            const buf = (reasonBuf.get(part.id) || "");
            const prev = Math.max(reasonLen.get(part.id) || 0, buf.length);
            if (part.text.length > prev) {
              const delta = part.text.slice(prev);
              reasonLen.set(part.id, part.text.length);
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: delta,
                }),
              );
            }
          } else if (part.type === "tool") {
            const status = part.state?.status;
            const key = part.callID + ":" + status;
            if (status === "running" && !toolAnnounced.has(key)) {
              toolAnnounced.add(key);
              evictSet(toolAnnounced);
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: "\n" + formatToolPart(part) + "\n",
                }),
              );
            } else if (status === "completed" && !toolAnnounced.has(key)) {
              toolAnnounced.add(key);
              evictSet(toolAnnounced);
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: "✓ " + (part.tool || "tool") + "\n",
                }),
              );
            } else if (status === "error" && !toolAnnounced.has(key)) {
              toolAnnounced.add(key);
              evictSet(toolAnnounced);
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: "✗ " + (part.tool || "tool") + "\n",
                }),
              );
            }
          }
        } else if (t === "message.part.delta") {
          const props = evt.properties;
          if (props?.sessionID !== sid || props?.field !== "text" || !props?.partID) return;
          const partID = props.partID;
          const deltaText = props.delta || "";
          if (!deltaText) return;

          const pType = partTypes.get(partID);

          if (pType === "text") {
            const prev = textBuf.get(partID) || "";
            textBuf.set(partID, prev + deltaText);
            const fullText = [...textBuf.values()].join("");
            if (RAW && clientTools) {
              streamProgress(fullText, false);
            } else {
              const norm = RAW ? normalizeToolXML(fullText) : fullText;
              const plen = sentLen.get("norm") || 0;
              if (norm.length > plen) {
                const d = norm.slice(plen);
                sentLen.set("norm", norm.length);
                sse(clientRes, openAIDelta(chatId, model, created, d));
              }
            }
          } else {
            const prev = reasonBuf.get(partID) || "";
            reasonBuf.set(partID, prev + deltaText);
            sse(
              clientRes,
              openAIDeltaRaw(chatId, model, created, {
                reasoning_content: deltaText,
              }),
            );
          }
        } else if (t === "session.idle") {
          if (evt.properties?.sessionID === sid) finish("stop");
        }
      };

      let aborted = false;
      clientRes.on("close", () => {
        aborted = true;
        if (!finished) finish("stop");
      });

      events = openMiMoEvents(handleEvent, () => {
        if (!finished && !aborted) finish("stop");
      });

      let watchdog = setTimeout(() => finish("stop"), WATCHDOG_MS);

      serverReq("POST", `/session/${sid}/message`, msgBody)
        .then((resp) => {
          if (finished) return;
          messageResponseText = extractText(resp.json);
          setTimeout(() => finish("stop"), 100);
        })
        .catch((e) => {
          if (!finished) {
            sse(
              clientRes,
              openAIDelta(chatId, model, created, "Erro: " + e.message),
            );
            finish("stop");
          }
        });
    })
    .catch((e) => {
      return bad(clientRes, "JSON inválido: " + e.message);
    });
}
