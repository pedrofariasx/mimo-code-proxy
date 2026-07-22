import test from "node:test";
import assert from "node:assert/strict";
import {
  genId,
  openAIModels,
  extractText,
  estimateTokens,
  calculateUsage,
  openAICompletion,
  openAIDelta,
  openAIDeltaRaw,
  openAIStreamUsage,
} from "../src/openai.js";

test("genId generates chatcmpl- prefixed string", () => {
  const id1 = genId();
  const id2 = genId();
  assert.ok(id1.startsWith("chatcmpl-"));
  assert.ok(id2.startsWith("chatcmpl-"));
  assert.notEqual(id1, id2);
});

test("openAIModels returns list of mimo models", () => {
  const models = openAIModels();
  assert.equal(models.object, "list");
  assert.ok(Array.isArray(models.data));
  assert.ok(models.data.length > 0);
  assert.equal(models.data[0].owned_by, "xiaomi");
});

test("extractText extracts text parts from mimo JSON", () => {
  const mimoJson = {
    parts: [
      { type: "text", text: "Hello " },
      { type: "reasoning", text: "thinking..." },
      { type: "text", text: "world!" },
    ],
  };
  assert.equal(extractText(mimoJson), "Hello world!");
  assert.equal(extractText(null), "");
  assert.equal(extractText({}), "");
});

test("estimateTokens calculates approximate tokens", () => {
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.ok(estimateTokens("Hello world") > 0);
});

test("calculateUsage computes prompt and completion tokens", () => {
  const promptMessages = [
    { role: "user", content: "What is the capital of France?" },
  ];
  const completionText = "The capital of France is Paris.";
  const usage = calculateUsage(promptMessages, completionText, null);

  assert.ok(usage.prompt_tokens > 0);
  assert.ok(usage.completion_tokens > 0);
  assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens);
});

test("openAICompletion constructs valid chat completion object", () => {
  const comp = openAICompletion(
    "chatcmpl-123",
    "mimo-auto",
    1700000000,
    "Hello there!",
    null,
    { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }
  );

  assert.equal(comp.id, "chatcmpl-123");
  assert.equal(comp.object, "chat.completion");
  assert.equal(comp.model, "mimo-auto");
  assert.equal(comp.choices[0].message.content, "Hello there!");
  assert.equal(comp.choices[0].finish_reason, "stop");
});

test("openAICompletion sets finish_reason tool_calls when tools exist", () => {
  const toolCalls = [
    {
      id: "call_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"location":"Paris"}' },
    },
  ];
  const comp = openAICompletion(
    "chatcmpl-123",
    "mimo-auto",
    1700000000,
    "",
    toolCalls,
    null
  );

  assert.equal(comp.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(comp.choices[0].message.tool_calls, toolCalls);
});

test("openAIDelta constructs SSE chunk object", () => {
  const deltaRole = openAIDelta("chatcmpl-123", "mimo-auto", 1700000000, null, "role");
  assert.equal(deltaRole.choices[0].delta.role, "assistant");

  const deltaText = openAIDelta("chatcmpl-123", "mimo-auto", 1700000000, "Hello");
  assert.equal(deltaText.choices[0].delta.content, "Hello");

  const deltaFinish = openAIDelta("chatcmpl-123", "mimo-auto", 1700000000, null, "stop");
  assert.equal(deltaFinish.choices[0].finish_reason, "stop");
});

test("openAIStreamUsage constructs usage chunk object", () => {
  const usageObj = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
  const chunk = openAIStreamUsage("chatcmpl-123", "mimo-auto", 1700000000, usageObj);
  assert.equal(chunk.object, "chat.completion.chunk");
  assert.deepEqual(chunk.usage, usageObj);
});
