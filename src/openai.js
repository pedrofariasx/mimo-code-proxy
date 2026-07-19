import { mimoModels } from "./config.js";

export function genId() {
  return "chatcmpl-" + Math.random().toString(36).slice(2, 12);
}

export function sse(res, obj) {
  res.write("data: " + JSON.stringify(obj) + "\n\n");
}

export function openAIModels() {
  return {
    object: "list",
    data: mimoModels.map((id) => ({
      id,
      object: "model",
      created: 0,
      owned_by: "xiaomi",
      _mimo_model: id,
    })),
  };
}

export function extractText(mimoJson) {
  if (!mimoJson || !Array.isArray(mimoJson.parts)) return "";
  return mimoJson.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

export function openAICompletion(id, model, created, text, toolCalls) {
  const message = { role: "assistant", content: text || null };
  let finish_reason = "stop";
  if (toolCalls && toolCalls.length) {
    message.tool_calls = toolCalls;
    finish_reason = "tool_calls";
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
}

export function openAIDelta(id, model, created, content, finish) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta:
          content != null
            ? { content }
            : finish === "role"
              ? { role: "assistant" }
              : {},
        finish_reason:
          finish === "stop" || finish === "tool_calls" ? finish : null,
      },
    ],
  };
}

export function openAIDeltaRaw(id, model, created, delta, finish = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
}
