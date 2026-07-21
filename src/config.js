import { URL } from "node:url";
import { readFileSync } from "node:fs";

// Carrega .env (se existir) antes de ler as variáveis de ambiente.
try {
  const envPath = new URL("../.env", import.meta.url).pathname;
  const text = readFileSync(envPath, "utf8");
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2].replace(/^["']|["']$/g, "");
    if (process.env[key] === undefined) process.env[key] = val;
  }
} catch {
  // sem .env: usa apenas variáveis do shell
}

export const SERVER_URL = process.env.MIMO_SERVER_URL || "http://127.0.0.1:4096";
export const SERVER_PASSWORD = process.env.MIMO_SERVER_PASSWORD || "";
export const PORT = Number(process.env.MIMO_PROXY_PORT || 8787);
export const HOST = process.env.MIMO_PROXY_HOST || "0.0.0.0";
export const DEFAULT_MODEL = process.env.MIMO_PROXY_MODEL || "mimo-auto";
export const REQUIRE_AUTH = process.env.MIMO_PROXY_REQUIRE_AUTH !== "false";
export const MODE = (process.env.MIMO_PROXY_MODE || "raw").toLowerCase();
export const RAW = MODE !== "agent";
export const WATCHDOG_MS = Number(process.env.MIMO_PROXY_WATCHDOG_MS || 600_000);
export const MAX_POOL_SIZE = Number(process.env.MIMO_PROXY_POOL_SIZE || 2);
export const BODY_MAX_BYTES = 4 * 1024 * 1024; // ~1M tokens (~4 chars/token)
export const FALLBACK_MS = Number(process.env.MIMO_PROXY_FALLBACK_MS || 500);

const TOKEN = process.env.MIMO_PROXY_TOKEN;
if (REQUIRE_AUTH && !TOKEN) {
  console.error("Erro: defina MIMO_PROXY_TOKEN");
  process.exit(1);
}

export const upstream = new URL(SERVER_URL);
export const SERVER_AUTH = SERVER_PASSWORD
  ? "Basic " + Buffer.from("mimocode:" + SERVER_PASSWORD).toString("base64")
  : "";

export const mimoModels = [
  "mimo-auto",
  "xiaomi/mimo-v2.5",
  "xiaomi/mimo-v2.5-pro",
  "xiaomi/mimo-v2.5-pro-ultraspeed",
];

export { TOKEN };
