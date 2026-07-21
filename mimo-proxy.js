#!/usr/bin/env node
/**
 * MiMo Code Remote Proxy
 *
 * Expõe o servidor headless do MiMo Code (`mimo serve`) para uso remoto,
 * roteando TUI, Web UI, WebSocket e chamadas de API de qualquer lugar.
 *
 * Arquitetura:
 *   cliente remoto ──HTTP/WS (X-API-Key)──> este proxy
 *        ──HTTP/WS (auth Basic do MiMo)──> mimo serve (127.0.0.1:PORTA)
 */

import http from "node:http";
import { URL } from "node:url";
import {
  TOKEN,
  SERVER_URL,
  SERVER_PASSWORD,
  PORT,
  HOST,
  RAW,
  REQUIRE_AUTH,
  upstream,
  SERVER_AUTH,
} from "./src/config.js";
import { isAuthorized } from "./src/auth.js";
import { openAIModels } from "./src/openai.js";
import { reverseProxy, handleChatCompletions } from "./src/routes.js";

const server = http.createServer(async (clientReq, clientRes) => {
  // CORS Headers para permitir requisições de clientes web locais (ex: interfaces no navegador)
  clientRes.setHeader("Access-Control-Allow-Origin", "*");
  clientRes.setHeader("Access-Control-Allow-Headers", "*");
  clientRes.setHeader("Access-Control-Allow-Methods", "*");

  if (clientReq.method === "OPTIONS") {
    clientRes.writeHead(200);
    clientRes.end();
    return;
  }

  const url = new URL(clientReq.url, "http://x");
  const path = url.pathname;

  if (path === "/healthz") {
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(
      JSON.stringify({ ok: true, upstream: SERVER_URL, ts: Date.now() }),
    );
    return;
  }

  if (path === "/v1/models" && clientReq.method === "GET") {
    if (!isAuthorized(clientReq)) {
      clientRes.writeHead(401, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    clientRes.writeHead(200, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify(openAIModels()));
    return;
  }

  if (path === "/v1/chat/completions" && clientReq.method === "POST") {
    return handleChatCompletions(clientReq, clientRes);
  }

  if (!isAuthorized(clientReq)) {
    clientRes.writeHead(401, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "Unauthorized" }));
    return;
  }
  reverseProxy(clientReq, clientRes);
});

server.on("upgrade", (clientReq, clientSocket) => {
  if (!isAuthorized(clientReq)) {
    clientSocket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    clientSocket.destroy();
    return;
  }
  const headers = { ...clientReq.headers, host: upstream.host };
  if (SERVER_AUTH) headers["authorization"] = SERVER_AUTH;
  const req = http.request({
    method: clientReq.method,
    hostname: upstream.hostname,
    port: upstream.port,
    path: clientReq.url,
    headers,
  });
  req.on("upgrade", (res, socket, head) => {
    clientSocket.write(
      `HTTP/1.1 ${res.statusCode} ${res.statusMessage}\r\n` +
        Object.entries(res.headers)
          .map(([k, v]) => `${k}: ${v}`)
          .join("\r\n") +
        "\r\n\r\n",
    );
    if (head && head.length) socket.write(head);
    socket.pipe(clientSocket);
    clientSocket.pipe(socket);
    socket.on("error", () => clientSocket.destroy());
    clientSocket.on("error", () => socket.destroy());
  });
  req.on("error", () => clientSocket.destroy());
  req.end();
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Erro: a porta ${PORT} já está em uso.`);
    process.exit(1);
  }
  console.error("Erro no servidor proxy:", err.message);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  console.log(`MiMo remote proxy ouvindo em http://${HOST}:${PORT}`);
  console.log(
    `Encaminhando para ${SERVER_URL} (auth do MiMo: ${SERVER_PASSWORD ? "sim" : "não"})`,
  );
  console.log(`Rotas OpenAI: POST /v1/chat/completions, GET /v1/models`);
  console.log(
    RAW
      ? `Modo: raw (LLM cru — ferramentas do MiMo desligadas; o cliente/Roo dirige as tools)`
      : `Modo: agent (o MiMo executa as próprias ferramentas)`,
  );
  console.log(
    REQUIRE_AUTH
      ? `Auth do proxy: ativada (use o header 'X-API-Key: ${TOKEN}')`
      : `Auth do proxy: DESATIVADA (MIMO_PROXY_REQUIRE_AUTH=false) — não exponha na internet`,
  );
});

function shutdown() {
  console.log("\nDesligando...");
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
