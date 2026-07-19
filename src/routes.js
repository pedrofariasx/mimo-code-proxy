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
} from "./openai.js";
import {
  buildConversation,
  buildToolsSystemPrompt,
  normalizeToolXML,
  parseHermesToolCalls,
  formatToolPart,
} from "./tools.js";

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

      let session;
      try {
        session = await serverReq("POST", "/session", {
          directory: process.cwd(),
          name: "openai-bridge",
        });
      } catch (e) {
        return bad(clientRes, "Falha ao criar sessão no MiMo: " + e.message, 502);
      }
      const sid = session.json?.id;
      if (!sid) return bad(clientRes, "Sessão não criada pelo MiMo", 502);

      const created = Math.floor(Date.now() / 1000);
      const chatId = genId();

      // ---------- Não-streaming ----------
      if (!stream) {
        try {
          const resp = await serverReq("POST", `/session/${sid}/message`, msgBody);
          let text = extractText(resp.json);
          let out;
          if (clientTools) {
            const { content, toolCalls } = parseHermesToolCalls(text, clientTools);
            out = openAICompletion(chatId, model, created, content, toolCalls);
          } else {
            if (RAW) text = normalizeToolXML(text);
            out = openAICompletion(chatId, model, created, text);
          }
          clientRes.writeHead(200, { "Content-Type": "application/json" });
          clientRes.end(JSON.stringify(out));
        } catch (e) {
          return bad(clientRes, "Falha na chamada ao MiMo: " + e.message, 502);
        } finally {
          serverReq("DELETE", `/session/${sid}`).catch(() => {});
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
      const toolAnnounced = new Set();
      const userMsgIds = new Set();
      const textBuf = new Map();

      const finish = (reason = "stop") => {
        if (finished) return;
        finished = true;
        if (RAW && textBuf.size) {
          const full = [...textBuf.values()].join("");
          textBuf.clear();
          if (clientTools) {
            const { content, toolCalls } = parseHermesToolCalls(full, clientTools);
            if (content) {
              sse(clientRes, openAIDelta(chatId, model, created, content));
            }
            if (toolCalls.length) {
              const deltas = toolCalls.map((tc, i) => ({ index: i, ...tc }));
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, { tool_calls: deltas }),
              );
              reason = "tool_calls";
            }
          } else {
            const norm = normalizeToolXML(full);
            if (norm) sse(clientRes, openAIDelta(chatId, model, created, norm));
          }
        }
        try {
          sse(clientRes, openAIDelta(chatId, model, created, null, reason));
          clientRes.write("data: [DONE]\n\n");
        } catch {}
        try {
          events.close();
        } catch {}
        clearTimeout(watchdog);
        serverReq("DELETE", `/session/${sid}`).catch(() => {});
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
        } else if (t === "message.part.updated") {
          const part = evt.properties?.part;
          if (!part || part.sessionID !== sid) return;
          if (userMsgIds.has(part.messageID)) return;

          if (part.type === "text" && typeof part.text === "string") {
            if (RAW && clientTools) {
              textBuf.set(part.id, part.text);
            } else {
              const prev = sentLen.get(part.id) || 0;
              if (part.text.length > prev) {
                const delta = part.text.slice(prev);
                sentLen.set(part.id, part.text.length);
                sse(clientRes, openAIDelta(chatId, model, created, delta));
              }
            }
          } else if (part.type === "reasoning" && typeof part.text === "string") {
            const prev = reasonLen.get(part.id) || 0;
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
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: "\n" + formatToolPart(part) + "\n",
                }),
              );
            } else if (status === "completed" && !toolAnnounced.has(key)) {
              toolAnnounced.add(key);
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: "✓ " + (part.tool || "tool") + "\n",
                }),
              );
            } else if (status === "error" && !toolAnnounced.has(key)) {
              toolAnnounced.add(key);
              sse(
                clientRes,
                openAIDeltaRaw(chatId, model, created, {
                  reasoning_content: "✗ " + (part.tool || "tool") + "\n",
                }),
              );
            }
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

      const events = openMiMoEvents(handleEvent, () => {
        if (!finished && !aborted) finish("stop");
      });

      let watchdog = setTimeout(() => finish("stop"), WATCHDOG_MS);

      serverReq("POST", `/session/${sid}/message`, msgBody)
        .then((resp) => {
          if (finished) return;
          const full = extractText(resp.json);
          if (full) {
            if (RAW) {
              textBuf.clear();
              textBuf.set("final", full);
            } else {
              const already = [...sentLen.values()].reduce((a, b) => a + b, 0);
              if (full.length > already) {
                sse(
                  clientRes,
                  openAIDelta(chatId, model, created, full.slice(already)),
                );
              }
            }
          }
          setTimeout(() => finish("stop"), 800);
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
