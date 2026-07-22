import { URL } from "node:url";
import crypto from "node:crypto";
import { TOKEN, REQUIRE_AUTH, BODY_MAX_BYTES } from "./config.js";

/**
 * Realiza comparação em tempo constante de duas strings para evitar timing attacks.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
export function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const maxLen = Math.max(a.length, b.length);
  if (maxLen === 0) return true;
  const bufA = Buffer.alloc(maxLen, 0);
  const bufB = Buffer.alloc(maxLen, 0);
  bufA.write(a);
  bufB.write(b);
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verifica se a requisição HTTP contém credenciais válidas.
 * @param {import("node:http").IncomingMessage} req
 * @returns {boolean}
 */
export function isAuthorized(req) {
  if (!REQUIRE_AUTH) return true;
  const key = req.headers["x-api-key"];
  if (key && safeCompare(key, TOKEN)) return true;
  const q = new URL(req.url, "http://x").searchParams.get("api_key");
  if (q && safeCompare(q, TOKEN)) return true;
  const auth = req.headers["authorization"];
  if (auth && auth.startsWith("Bearer ")) {
    const bearerKey = auth.slice(7).trim();
    if (safeCompare(bearerKey, TOKEN)) return true;
  }
  return false;
}

/**
 * Lê e analisa o corpo JSON de uma requisição HTTP respeitando o limite máximo em bytes.
 * @param {import("node:http").IncomingMessage} req
 * @param {number} [maxSize=BODY_MAX_BYTES]
 * @returns {Promise<any>}
 */
export function readBody(req, maxSize = BODY_MAX_BYTES) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxSize) {
        req.destroy();
        return reject(new Error("Body too large"));
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

/**
 * Responde com 401 Unauthorized.
 * @param {import("node:http").ServerResponse} res
 */
export function deny(res) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

/**
 * Responde com erro customizado (padrão 400 Bad Request).
 * @param {import("node:http").ServerResponse} res
 * @param {string} msg
 * @param {number} [code=400]
 */
export function bad(res, msg, code = 400) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}
