import { jsonrepair } from "jsonrepair";

export function messageText(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) {
    return m.content
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text)
      .join("");
  }
  return "";
}

export function buildConversation(messages, raw) {
  const systemParts = [];
  const turns = [];
  const callName = {};
  for (const m of messages || []) {
    const text = messageText(m);
    if (m.role === "system") {
      if (text) systemParts.push(text);
    } else if (m.role === "assistant") {
      const calls = Array.isArray(m.tool_calls) ? m.tool_calls : [];
      let block = text || "";
      for (const c of calls) {
        const fn = c.function?.name || "function";
        callName[c.id] = fn;
        const args = c.function?.arguments || "{}";
        block += `${block ? "\n" : ""}[Called ${fn} with ${args}]`;
      }
      if (block) turns.push(raw ? `Assistant:\n${block}` : block);
    } else if (m.role === "tool") {
      if (!text) continue;
      const fn = callName[m.tool_call_id] || "function";
      turns.push(raw ? `Result of ${fn}:\n${text}` : text);
    } else {
      if (text) turns.push(raw ? `Human:\n${text}` : text);
    }
  }
  const system = systemParts.join("\n\n") || undefined;
  const transcript = turns.join("\n\n");
  return { system, parts: [{ type: "text", text: transcript }] };
}

export function normalizeToolXML(text) {
  if (!text || text.indexOf("<") === -1) return text;
  let t = text;
  t = t.replace(
    /<function=([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/function>/g,
    (m, name, inner) => {
      const body = inner.replace(
        /<parameter=([a-zA-Z0-9_]+)\s*>([\s\S]*?)<\/parameter>/g,
        (mm, p, v) => `<${p}>${v}</${p}>`,
      );
      return `<${name}>${body}</${name}>`;
    },
  );
  t = t.replace(
    /<function_name>\s*([a-zA-Z0-9_]+)\s*<\/function_name>([\s\S]*?)(?=<\/tool_call>|$)/g,
    (m, name, inner) => {
      const body = inner.replace(
        /<param\s+name=["']([a-zA-Z0-9_]+)["']\s*>([\s\S]*?)<\/param>/g,
        (mm, p, v) => `<${p}>${v}</${p}>`,
      );
      return `<${name}>${body}</${name}>`;
    },
  );
  t = t.replace(/<tool_call>\s*/g, "").replace(/\s*<\/tool_call>/g, "");
  return t;
}

export function buildToolsSystemPrompt(tools, toolChoice) {
  const defs = tools
    .filter((t) => t && t.type === "function" && t.function)
    .map((t) => JSON.stringify(t.function));
  let choice = "";
  if (toolChoice === "required") {
    choice = "\nYou MUST call at least one function in your reply.";
  } else if (
    toolChoice &&
    typeof toolChoice === "object" &&
    toolChoice.function?.name
  ) {
    choice = `\nYou MUST call the function "${toolChoice.function.name}".`;
  }
  return [
    "# Function calling",
    "You can call functions. To call one, output EXACTLY this format (and nothing else for that call):",
    "<tool_call>",
    "<function=FUNCTION_NAME>",
    "<parameter=PARAM_NAME>VALUE</parameter>",
    "</function>",
    "</tool_call>",
    "Call multiple functions with multiple <tool_call> blocks. Put each parameter value as raw text (no quotes).",
    choice,
    "",
    "Available functions (JSON schema):",
    ...defs,
  ].join("\n");
}

function coerceParam(value, schema, paramName) {
  let v = value;
  v = v.replace(/^\r?\n/, "").replace(/\r?\n$/, "");

  const type = schema?.type;
  if (type === "boolean") {
    const s = v.trim().toLowerCase();
    return s === "true" || s === "1" || s === "yes";
  }
  if (type === "number" || type === "integer") {
    const n = Number(v.trim());
    return Number.isNaN(n) ? v : n;
  }
  if (type === "object" || type === "array") {
    try {
      return JSON.parse(v);
    } catch {
      const stripped = v.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/, "").trim();
      try {
        return JSON.parse(stripped);
      } catch {
        try {
          return JSON.parse(jsonrepair(stripped));
        } catch {
          return v;
        }
      }
    }
  }

  const preserveWhitespaceParams = ["content", "text", "code", "newstring", "oldstring", "patch", "diff"];
  const nameLower = (paramName || "").toLowerCase();
  if (!preserveWhitespaceParams.includes(nameLower)) {
    v = v.trim();
  }
  return v;
}

export function parseHermesToolCalls(text, tools) {
  const schemaByName = {};
  for (const t of tools || []) {
    if (t?.function?.name) schemaByName[t.function.name] = t.function.parameters;
  }
  const toolCalls = [];
  const blockRe = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let m;
  while ((m = blockRe.exec(text)) !== null) {
    const inner = m[1];
    const fn = inner.match(/<function=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/function>/);
    if (!fn) continue;
    const name = fn[1];
    const params = schemaByName[name]?.properties || {};
    const args = {};
    const paramRe = /<parameter=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/g;
    let pm;
    while ((pm = paramRe.exec(fn[2])) !== null) {
      const pName = pm[1];
      args[pName] = coerceParam(pm[2], params[pName], pName);
    }
    toolCalls.push({
      id: "call_" + Math.random().toString(36).slice(2, 12),
      type: "function",
      function: { name, arguments: JSON.stringify(args) },
    });
  }

  let content = text.replace(blockRe, "").trim();

  // Fallback: if no <tool_call> tags found, try parsing Hermes-style without wrappers
  if (!toolCalls.length && content.includes("<function=")) {
    const fnRe = /<function=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/function>/g;
    let fnMatch;
    while ((fnMatch = fnRe.exec(content)) !== null) {
      const name = fnMatch[1];
      if (!schemaByName[name]) continue;
      const params = schemaByName[name].properties || {};
      const args = {};
      const pRe = /<parameter=([a-zA-Z0-9_.-]+)\s*>([\s\S]*?)<\/parameter>/g;
      let pm;
      while ((pm = pRe.exec(fnMatch[2])) !== null) {
        args[pm[1]] = coerceParam(pm[2], params[pm[1]], pm[1]);
      }
      toolCalls.push({
        id: "call_" + Math.random().toString(36).slice(2, 12),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    if (toolCalls.length) content = content.replace(fnRe, "").trim();
  }

  // Fallback: parse [Called name with {json}] format
  if (!toolCalls.length && content.includes("[Called ")) {
    const calledRe = /\[Called\s+([a-zA-Z0-9_.-]+)\s+with\s+(\{[^}]*\})\]/g;
    let cm;
    while ((cm = calledRe.exec(content)) !== null) {
      const name = cm[1];
      if (!schemaByName[name]) continue;
      let args;
      try { args = JSON.parse(cm[2]); }
      catch {
        try { args = JSON.parse(jsonrepair(cm[2])); }
        catch { continue; }
      }
      toolCalls.push({
        id: "call_" + Math.random().toString(36).slice(2, 12),
        type: "function",
        function: { name, arguments: JSON.stringify(args) },
      });
    }
    if (toolCalls.length) content = content.replace(calledRe, "").trim();
  }

  return { content, toolCalls };
}

export function formatToolPart(part) {
  const name = part.tool || "tool";
  const input = part.state?.input;
  let arg = "";
  if (input && typeof input === "object") {
    const key =
      input.file_path ??
      input.filePath ??
      input.path ??
      input.command ??
      input.pattern ??
      input.query ??
      input.url;
    if (key != null) arg = String(key);
    else arg = JSON.stringify(input);
    if (arg.length > 120) arg = arg.slice(0, 117) + "...";
  }
  return arg ? `${name}(${arg})` : name;
}
