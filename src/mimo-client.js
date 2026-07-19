import http from "node:http";
import { upstream, SERVER_AUTH } from "./config.js";

export function serverHeaders(extra = {}) {
  const h = { ...extra, host: upstream.host };
  if (SERVER_AUTH) h["authorization"] = SERVER_AUTH;
  return h;
}

export function serverReq(method, path, body, headers) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request(
      {
        method,
        hostname: upstream.hostname,
        port: upstream.port,
        path,
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

export function openMiMoEvents(onEvent, onError) {
  const req = http.request(
    {
      method: "GET",
      hostname: upstream.hostname,
      port: upstream.port,
      path: "/event",
      headers: serverHeaders({ accept: "text/event-stream" }),
      timeout: 0,
    },
    (res) => {
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
      res.on("end", () => onError && onError(new Error("event stream ended")));
      res.on("error", (e) => onError && onError(e));
    },
  );
  req.on("error", (e) => onError && onError(e));
  req.end();
  return {
    close() {
      req.destroy();
    },
  };
}
