import http from "node:http";
import { upstream, SERVER_AUTH } from "./config.js";

const agent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 10000,
  noDelay: true,
  maxSockets: 64,
  maxFreeSockets: 16,
});

/**
 * Constrói os cabeçalhos padrão para autenticação e envio de requisições ao servidor MiMo.
 * @param {Record<string, string>} [extra={}]
 * @returns {Record<string, string>}
 */
export function serverHeaders(extra = {}) {
  const h = { ...extra, host: upstream.host };
  if (SERVER_AUTH) h["authorization"] = SERVER_AUTH;
  return h;
}

/**
 * Envia uma requisição HTTP para o servidor MiMo upstream e retorna a resposta analisada.
 * @param {string} method
 * @param {string} path
 * @param {any} [body]
 * @param {Record<string, string>} [headers]
 * @returns {Promise<{status: number, json: any, raw: string}>}
 */
export function serverReq(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: upstream.hostname,
        port: upstream.port,
        path,
        agent,
        headers: serverHeaders({
          "content-type": "application/json",
          ...(data ? { "content-length": Buffer.byteLength(data) } : {}),
          ...headers,
        }),
        timeout: 120000,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch {
            json = null;
          }
          resolve({ status: res.statusCode, json, raw });
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

/**
 * Abre uma conexão SSE com o endpoint `/event` do MiMo com suporte a reconexão automática (backoff).
 * @param {(evt: any) => void} onEvent
 * @param {(err: Error) => void} [onError]
 * @returns {{close: () => void}}
 */
export function openMiMoEvents(onEvent, onError) {
  let activeReq = null;
  let closed = false;
  let attempt = 0;
  let reconnectTimeout = null;

  function connect() {
    if (closed) return;

    activeReq = http.request(
      {
        method: "GET",
        hostname: upstream.hostname,
        port: upstream.port,
        path: "/event",
        agent,
        headers: serverHeaders({ accept: "text/event-stream" }),
        timeout: 0,
      },
      (res) => {
        attempt = 0; // Conectado com sucesso, reseta tentativas
        let buf = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          buf += chunk;
          let idx;
          while ((idx = buf.indexOf("\n\n")) >= 0) {
            const raw = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = raw
              .split("\n")
              .find((l) => l.startsWith("data:"));
            if (!dataLine) continue;
            try {
              onEvent(JSON.parse(dataLine.slice(5).trim()));
            } catch {
              // ignora linhas que não são JSON válido
            }
          }
        });
        res.on("end", () => handleFailure(new Error("event stream ended")));
        res.on("error", (e) => handleFailure(e));
      },
    );
    activeReq.on("error", (e) => handleFailure(e));
    activeReq.end();
  }

  function handleFailure(err) {
    if (closed) return;
    activeReq = null;
    attempt++;
    if (attempt > 5) {
      if (onError) onError(err);
      return;
    }
    // Backoff rápido: 100ms, 200ms, 400ms, 800ms, 1600ms
    const delay = 100 * Math.pow(2, attempt - 1);
    reconnectTimeout = setTimeout(connect, delay);
  }

  connect();

  return {
    close() {
      closed = true;
      if (reconnectTimeout) clearTimeout(reconnectTimeout);
      if (activeReq) activeReq.destroy();
    },
  };
}
