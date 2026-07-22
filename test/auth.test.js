import test from "node:test";
import assert from "node:assert/strict";
import { safeCompare, isAuthorized, readBody, deny, bad } from "../src/auth.js";
import { EventEmitter } from "node:events";

test("safeCompare returns true for matching strings", () => {
  assert.equal(safeCompare("secret-token-123", "secret-token-123"), true);
});

test("safeCompare returns false for non-matching strings", () => {
  assert.equal(safeCompare("secret-token-123", "wrong-token-456"), false);
});

test("safeCompare returns false for different lengths", () => {
  assert.equal(safeCompare("short", "longer-string"), false);
});

test("safeCompare returns false for invalid input types", () => {
  assert.equal(safeCompare(null, "token"), false);
  assert.equal(safeCompare(undefined, "token"), false);
  assert.equal(safeCompare(123, "123"), false);
});

test("isAuthorized returns boolean based on request headers", () => {
  const mockReq = {
    headers: { "x-api-key": process.env.MIMO_PROXY_TOKEN || "" },
    url: "/v1/models",
  };
  assert.equal(typeof isAuthorized(mockReq), "boolean");
});

test("readBody parses valid JSON body", async () => {
  const mockReq = new EventEmitter();
  mockReq.destroy = () => {};

  const promise = readBody(mockReq);
  mockReq.emit("data", Buffer.from(JSON.stringify({ model: "mimo-auto" })));
  mockReq.emit("end");

  const body = await promise;
  assert.equal(body.model, "mimo-auto");
});

test("readBody rejects when payload exceeds limit", async () => {
  const mockReq = new EventEmitter();
  let destroyed = false;
  mockReq.destroy = () => { destroyed = true; };

  const promise = readBody(mockReq, 10);
  mockReq.emit("data", Buffer.from("12345678901234567890"));

  await assert.rejects(promise, { message: "Body too large" });
  assert.equal(destroyed, true);
});

test("deny writes 401 response", () => {
  let statusCode, headers, body;
  const res = {
    writeHead(code, h) {
      statusCode = code;
      headers = h;
    },
    end(b) {
      body = b;
    },
  };
  deny(res);
  assert.equal(statusCode, 401);
  assert.deepEqual(headers, { "Content-Type": "application/json" });
  assert.equal(JSON.parse(body).error, "Unauthorized");
});

test("bad writes custom status code response", () => {
  let statusCode, headers, body;
  const res = {
    writeHead(code, h) {
      statusCode = code;
      headers = h;
    },
    end(b) {
      body = b;
    },
  };
  bad(res, "Custom Error", 400);
  assert.equal(statusCode, 400);
  assert.deepEqual(headers, { "Content-Type": "application/json" });
  assert.equal(JSON.parse(body).error, "Custom Error");
});
