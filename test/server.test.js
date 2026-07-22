import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isAuthorized } from "../src/auth.js";
import { openAIModels } from "../src/openai.js";

function startTestServer() {
  const server = http.createServer((clientReq, clientRes) => {
    clientRes.setHeader("Access-Control-Allow-Origin", "*");
    clientRes.setHeader(
      "Access-Control-Allow-Headers",
      clientReq.headers["access-control-request-headers"] || "*",
    );
    clientRes.setHeader(
      "Access-Control-Allow-Methods",
      "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    );
    clientRes.setHeader("Access-Control-Max-Age", "86400");

    if (clientReq.method === "OPTIONS") {
      clientRes.writeHead(204);
      clientRes.end();
      return;
    }

    const path = clientReq.url;

    if (path === "/healthz") {
      clientRes.writeHead(200, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ ok: true, ts: Date.now() }));
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

    if (!isAuthorized(clientReq)) {
      clientRes.writeHead(401, { "Content-Type": "application/json" });
      clientRes.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    clientRes.writeHead(404, { "Content-Type": "application/json" });
    clientRes.end(JSON.stringify({ error: "Not Found" }));
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port });
    });
  });
}

function makeRequest(port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        method,
        path,
        headers,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, raw, json });
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

test("HTTP Server Integration Tests", async (t) => {
  const { server, port } = await startTestServer();

  t.after(() => {
    return new Promise((resolve) => server.close(resolve));
  });

  await t.test("OPTIONS preflight returns 204 No Content and CORS headers", async () => {
    const res = await makeRequest(port, "OPTIONS", "/v1/chat/completions");
    assert.equal(res.status, 204);
    assert.equal(res.headers["access-control-allow-origin"], "*");
    assert.equal(
      res.headers["access-control-allow-methods"],
      "GET, POST, PUT, DELETE, OPTIONS, PATCH",
    );
  });

  await t.test("GET /healthz returns 200 OK with json", async () => {
    const res = await makeRequest(port, "GET", "/healthz");
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
    assert.ok(typeof res.json.ts === "number");
  });

  await t.test("GET /v1/models returns models list or 401 based on auth", async () => {
    const res = await makeRequest(port, "GET", "/v1/models");
    assert.ok(res.status === 200 || res.status === 401);
    if (res.status === 200) {
      assert.equal(res.json.object, "list");
    } else {
      assert.equal(res.json.error, "Unauthorized");
    }
  });
});
