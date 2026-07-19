import { URL } from "node:url";
import { TOKEN, REQUIRE_AUTH, BODY_MAX_BYTES } from "./config.js";

function safeCompare(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  return (
    a.split("").reduce((acc, c, i) => acc | (c.charCodeAt(0) ^ b.charCodeAt(i)), 0) === 0
  );
}

export function isAuthorized(req) {
  if (!REQUIRE_AUTH) return true;
  const key = req.headers["x-api-key"];
  if (key && safeCompare(key, TOKEN)) return true;
  const q = new URL(req.url, "http://x").searchParams.get("api_key");
  return q && safeCompare(q, TOKEN);
}

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

export function deny(res) {
  res.writeHead(401, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Unauthorized" }));
}

export function bad(res, msg, code = 400) {
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: msg }));
}
