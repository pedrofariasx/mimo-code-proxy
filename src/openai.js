import crypto from "node:crypto";
import { mimoModels } from "./config.js";

/**
 * Gera um ID de chat aleatório compatível com a API da OpenAI.
 * @returns {string}
 */
export function genId() {
  return "chatcmpl-" + crypto.randomBytes(12).toString("hex");
}

/**
 * Escreve um evento SSE no formato OpenAI no stream da resposta.
 * @param {import("node:http").ServerResponse} res
 * @param {object} obj
 */
export function sse(res, obj) {
  res.write("data: " + JSON.stringify(obj) + "\n\n");
}

/**
 * Retorna a lista de modelos suportados no formato de resposta da OpenAI GET /v1/models.
 * @returns {object}
 */
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

/**
 * Extrai e concatena todas as partes de texto da resposta JSON do MiMo.
 * @param {object} mimoJson
 * @returns {string}
 */
export function extractText(mimoJson) {
  if (!mimoJson || !Array.isArray(mimoJson.parts)) return "";
  return mimoJson.parts
    .filter((p) => p.type === "text" && typeof p.text === "string")
    .map((p) => p.text)
    .join("");
}

/**
 * Estima a quantidade de tokens para um texto ou contagem de caracteres.
 * @param {string|number} input
 * @returns {number}
 */
export function estimateTokens(input) {
  if (!input) return 0;
  if (typeof input === "number") return Math.ceil(input / 3.8);
  if (typeof input === "string") return Math.ceil(input.length / 3.8);
  return 0;
}

export function calculateUsage(promptMessages, completionText, toolCalls) {
  let promptChars = 0;
  for (const m of promptMessages || []) {
    if (typeof m.content === "string") {
      promptChars += m.content.length;
    } else if (Array.isArray(m.content)) {
      for (const c of m.content) {
        if (c.type === "text" && typeof c.text === "string") {
          promptChars += c.text.length;
        }
      }
    }
  }

  const promptTokens = Math.max(1, estimateTokens(promptChars));

  let completionTokens = estimateTokens(completionText || "");
  if (toolCalls && toolCalls.length) {
    for (const tc of toolCalls) {
      if (tc.function?.arguments) {
        completionTokens += estimateTokens(tc.function.arguments);
      }
      completionTokens += 20; // overhead por chamada de ferramenta
    }
  }

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

export function openAICompletion(id, model, created, text, toolCalls, usage) {
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
    usage: usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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

export function openAIStreamUsage(id, model, created, usage) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [],
    usage,
  };
}
