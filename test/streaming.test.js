import test from "node:test";
import assert from "node:assert/strict";
import {
  findCompleteToolBlocks,
  hasIncompleteToolBlock,
  extractBalancedJSON,
} from "../src/tools.js";

const schema = {
  read_file: { properties: { path: { type: "string" } } },
  write_file: { properties: { path: { type: "string" }, content: { type: "string" } } },
  bash: { properties: { command: { type: "string" } } },
  search: { properties: { query: { type: "string" }, limit: { type: "number" } } },
};

function simulateStreamProgress(fullText, clientTools, isFinal = false) {
  const hasToolTags = fullText.includes("<tool_call>") ||
    (clientTools && fullText.includes("[Called "));
  if (!hasToolTags) {
    return { cleanText: fullText, blocks: [], incomplete: false };
  }
  const blocks = findCompleteToolBlocks(fullText, clientTools);
  let cleanText = "";
  let lastEnd = 0;
  for (const b of blocks) {
    cleanText += fullText.slice(lastEnd, b.start);
    lastEnd = b.end;
  }
  const incomplete = !isFinal && hasIncompleteToolBlock(fullText);
  if (incomplete) {
    const lastOpen = Math.max(
      fullText.lastIndexOf("<tool_call>"),
      fullText.lastIndexOf("[Called ")
    );
    if (lastOpen > lastEnd) {
      cleanText += fullText.slice(lastEnd, lastOpen);
    }
  } else {
    cleanText += fullText.slice(lastEnd);
  }
  return { cleanText, blocks, incomplete };
}

test("streaming: XML tool_call arrives incrementally", () => {
  const full = "I'll read the file.<tool_call>\n<function=read_file>\n<parameter=path>/tmp/test.js</parameter>\n</function>\n</tool_call>";
  const toolCalls = [];
  const sentEnds = new Set();
  for (let i = 1; i <= full.length; i++) {
    const partial = full.slice(0, i);
    const { blocks } = simulateStreamProgress(partial, schema);
    for (const block of blocks) {
      if (!sentEnds.has(block.end)) {
        toolCalls.push(block.toolCall);
        sentEnds.add(block.end);
      }
    }
  }
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "read_file");
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.path, "/tmp/test.js");
});

test("streaming: two tool calls arriving incrementally", () => {
  const full = "Check.<tool_call>\n<function=read_file>\n<parameter=path>/a.js</parameter>\n</function>\n</tool_call>\nWrite.<tool_call>\n<function=write_file>\n<parameter=path>/b.js</parameter>\n<parameter=content>hi</parameter>\n</function>\n</tool_call>";
  const allToolCalls = [];
  const sentEnds = new Set();
  for (let i = 1; i <= full.length; i += 10) {
    const partial = full.slice(0, i);
    const { blocks } = simulateStreamProgress(partial, schema);
    for (const block of blocks) {
      if (!sentEnds.has(block.end)) {
        allToolCalls.push(block.toolCall);
        sentEnds.add(block.end);
      }
    }
  }
  const { blocks } = simulateStreamProgress(full, schema, true);
  for (const block of blocks) {
    if (!sentEnds.has(block.end)) {
      allToolCalls.push(block.toolCall);
      sentEnds.add(block.end);
    }
  }
  assert.equal(allToolCalls.length, 2);
  assert.equal(allToolCalls[0].function.name, "read_file");
  assert.equal(allToolCalls[1].function.name, "write_file");
});

test("streaming: incomplete tool_call suppresses output", () => {
  const full = "Thinking...<tool_call>\n<function=read_file>\n<parameter=path>/tmp/x.js</parameter>\n</function>";
  const { cleanText, incomplete } = simulateStreamProgress(full, schema);
  assert.equal(incomplete, true);
  assert.ok(cleanText.includes("Thinking..."));
  assert.ok(!cleanText.includes("<tool_call>"));
});

test("streaming: tool_call starting at position 0 does not leak raw markup", () => {
  const full = "<tool_call>\n<function=read_file>\n<parameter=path>/tmp/x.js</parameter>\n</function>";
  const { cleanText, incomplete } = simulateStreamProgress(full, schema);
  assert.equal(incomplete, true);
  assert.equal(cleanText, "", "raw tool_call markup should be suppressed, not leaked");
});

test("streaming: [Called] starting at position 0 does not leak", () => {
  const full = '[Called read_file with {"path":"/tmp/x.js"}';
  const { cleanText, incomplete } = simulateStreamProgress(full, schema);
  assert.equal(incomplete, true);
  assert.equal(cleanText, "", "raw Called markup should be suppressed, not leaked");
});

test("streaming: text between tool calls preserved", () => {
  const full = "A.<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>\nB.\nC.";
  const { cleanText } = simulateStreamProgress(full, schema, true);
  assert.ok(cleanText.includes("A."));
  assert.ok(cleanText.includes("B."));
  assert.ok(cleanText.includes("C."));
  assert.ok(!cleanText.includes("<tool_call>"));
});

test("streaming: [Called] format incrementally", () => {
  const full = 'Search.[Called search with {"query":"hello","limit":10}] Done.';
  const toolCalls = [];
  const sentEnds = new Set();
  for (let i = 1; i <= full.length; i += 5) {
    const partial = full.slice(0, i);
    const { blocks } = simulateStreamProgress(partial, schema);
    for (const block of blocks) {
      if (!sentEnds.has(block.end)) {
        toolCalls.push(block.toolCall);
        sentEnds.add(block.end);
      }
    }
  }
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "search");
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.query, "hello");
});

test("streaming: [Called] with braces in string value", () => {
  const full = '[Called write_file with {"content":"if (x) { return {a: 1}; }"}]';
  const toolCalls = [];
  const sentEnds = new Set();
  for (let i = 1; i <= full.length; i += 4) {
    const partial = full.slice(0, i);
    const { blocks } = simulateStreamProgress(partial, schema);
    for (const block of blocks) {
      if (!sentEnds.has(block.end)) {
        toolCalls.push(block.toolCall);
        sentEnds.add(block.end);
      }
    }
  }
  const { blocks } = simulateStreamProgress(full, schema, true);
  for (const block of blocks) {
    if (!sentEnds.has(block.end)) {
      toolCalls.push(block.toolCall);
      sentEnds.add(block.end);
    }
  }
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.content, "if (x) { return {a: 1}; }");
});

test("streaming: plain text without tool calls", () => {
  const res = simulateStreamProgress("Just a normal response.", schema, true);
  assert.equal(res.cleanText, "Just a normal response.");
  assert.equal(res.blocks.length, 0);
});

test("streaming: tool call with no surrounding text", () => {
  const full = "<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>";
  const { blocks } = simulateStreamProgress(full, schema, true);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].toolCall.function.name, "bash");
});

test("streaming: completed then incomplete tool call", () => {
  const full = "<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call>\nNext:<tool_call>\n<function=read_file>\n<parameter=path>/tmp/x";
  const { blocks, incomplete } = simulateStreamProgress(full, schema);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].toolCall.function.name, "bash");
  assert.equal(incomplete, true);
});

test("streaming: missing closing parameter tag", () => {
  const full = "<tool_call>\n<function=bash>\n<parameter=command>ls\n</function>\n</tool_call>";
  const { blocks, incomplete } = simulateStreamProgress(full, schema);
  assert.equal(blocks.length, 0);
  assert.equal(incomplete, false);
});

test("streaming: rapid 3 tool call sequence", () => {
  const full = "<tool_call>\n<function=bash>\n<parameter=command>echo a</parameter>\n</function>\n</tool_call><tool_call>\n<function=bash>\n<parameter=command>echo b</parameter>\n</function>\n</tool_call><tool_call>\n<function=bash>\n<parameter=command>echo c</parameter>\n</function>\n</tool_call>";
  const toolCalls = [];
  const sentEnds = new Set();
  for (let i = 1; i <= full.length; i += 7) {
    const partial = full.slice(0, i);
    const { blocks } = simulateStreamProgress(partial, schema);
    for (const block of blocks) {
      if (!sentEnds.has(block.end)) {
        toolCalls.push(block.toolCall);
        sentEnds.add(block.end);
      }
    }
  }
  const { blocks } = simulateStreamProgress(full, schema, true);
  for (const block of blocks) {
    if (!sentEnds.has(block.end)) {
      toolCalls.push(block.toolCall);
      sentEnds.add(block.end);
    }
  }
  assert.equal(toolCalls.length, 3);
});

test("streaming: large parameter value (10KB)", () => {
  const largeContent = "x".repeat(10000);
  const full = `<tool_call>\n<function=write_file>\n<parameter=path>/tmp/large.txt</parameter>\n<parameter=content>${largeContent}</parameter>\n</function>\n</tool_call>`;
  const toolCalls = [];
  const sentEnds = new Set();
  for (let i = 1; i <= full.length; i += 500) {
    const partial = full.slice(0, i);
    const { blocks } = simulateStreamProgress(partial, schema);
    for (const block of blocks) {
      if (!sentEnds.has(block.end)) {
        toolCalls.push(block.toolCall);
        sentEnds.add(block.end);
      }
    }
  }
  const { blocks } = simulateStreamProgress(full, schema, true);
  for (const block of blocks) {
    if (!sentEnds.has(block.end)) {
      toolCalls.push(block.toolCall);
      sentEnds.add(block.end);
    }
  }
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.content.length, 10000);
});

test("streaming: tool call with angle brackets in content", () => {
  const full = '<tool_call>\n<function=write_file>\n<parameter=path>/tmp/test.html</parameter>\n<parameter=content><div class="wrapper">\n<p>Hello</p>\n</div></parameter>\n</function>\n</tool_call>';
  const { blocks } = simulateStreamProgress(full, schema, true);
  assert.equal(blocks.length, 1);
  const args = JSON.parse(blocks[0].toolCall.function.arguments);
  assert.ok(args.content.includes("<div"));
  assert.ok(args.content.includes("</div>"));
});

test("findCompleteToolBlocks: ignores incomplete blocks", () => {
  const text = "<tool_call>\n<function=bash>\n<parameter=command>echo</parameter>\n</function>\n</tool_call>\nIncomplete:<tool_call>\n<function=read_file>\n<parameter=path>/tmp";
  const blocks = findCompleteToolBlocks(text, schema);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].toolCall.function.name, "bash");
});

test("findCompleteToolBlocks: adjacent tool calls", () => {
  const text = "<tool_call>\n<function=bash>\n<parameter=command>ls</parameter>\n</function>\n</tool_call><tool_call>\n<function=bash>\n<parameter=command>pwd</parameter>\n</function>\n</tool_call>";
  const blocks = findCompleteToolBlocks(text, schema);
  assert.equal(blocks.length, 2);
  assert.ok(blocks[0].start < blocks[1].start);
});

test("hasIncompleteToolBlock: detects open tool_call", () => {
  assert.equal(hasIncompleteToolBlock("<tool_call>\n<function=x>\n<parameter>val"), true);
  assert.equal(hasIncompleteToolBlock("<tool_call>\n<function=x>\n<parameter>v</parameter>\n</function>\n</tool_call>"), false);
});

test("hasIncompleteToolBlock: detects open [Called", () => {
  assert.equal(hasIncompleteToolBlock('[Called fn with {"a":'), true);
  assert.equal(hasIncompleteToolBlock('[Called fn with {"a":1}]'), false);
});

test("hasIncompleteToolBlock: no false positive on brackets", () => {
  assert.equal(hasIncompleteToolBlock("Use [brackets] and {braces}."), false);
});

test("extractBalancedJSON: nested JSON from mid-string", () => {
  const text = 'pre [Called fn with {"a":{"b":[1,2,3]}}] suf';
  const r = extractBalancedJSON(text, text.indexOf("{"));
  assert.equal(r, '{"a":{"b":[1,2,3]}}');
});

test("extractBalancedJSON: bracket chars inside strings", () => {
  const text = '{"text":"[hello] and {world}"}';
  assert.equal(extractBalancedJSON(text, 0), text);
});

test("extractBalancedJSON: null for incomplete", () => {
  assert.equal(extractBalancedJSON('{"a":{"b":', 0), null);
});
