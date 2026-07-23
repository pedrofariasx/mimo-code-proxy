import test from "node:test";
import assert from "node:assert/strict";
import {
  messageText,
  buildConversation,
  normalizeToolXML,
  buildToolsSystemPrompt,
  parseHermesToolCalls,
  formatToolPart,
  extractBalancedJSON,
  parseCalledBlocks,
  findCompleteToolBlocks,
  hasIncompleteToolBlock,
} from "../src/tools.js";

test("messageText handles string and array content", () => {
  assert.equal(messageText({ content: "Simple text" }), "Simple text");
  assert.equal(
    messageText({
      content: [
        { type: "text", text: "Part 1 " },
        { type: "image_url", image_url: { url: "http://example.com" } },
        { type: "text", text: "Part 2" },
      ],
    }),
    "Part 1 Part 2"
  );
  assert.equal(messageText({ content: null }), "");
});

test("buildConversation builds system prompt and transcript turns", () => {
  const messages = [
    { role: "system", content: "You are a helpful assistant." },
    { role: "user", content: "Hello!" },
    { role: "assistant", content: "Hi there!" },
  ];

  const resRaw = buildConversation(messages, true);
  assert.equal(resRaw.system, "You are a helpful assistant.");
  assert.equal(resRaw.parts[0].text, "Human:\nHello!\n\nAssistant:\nHi there!");

  const resAgent = buildConversation(messages, false);
  assert.equal(resAgent.parts[0].text, "Hello!\nHi there!");
});

test("buildConversation handles tool_calls in assistant messages", () => {
  const messages = [
    { role: "user", content: "Read the file" },
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id: "call_123",
          type: "function",
          function: { name: "read_file", arguments: '{"path":"/tmp/x.js"}' },
        },
      ],
    },
    { role: "tool", tool_call_id: "call_123", content: "file contents here" },
  ];
  const res = buildConversation(messages, true);
  assert.ok(res.parts[0].text.includes('[Called read_file with {"path":"/tmp/x.js"}]'));
  assert.ok(res.parts[0].text.includes("Result of read_file:"));
  assert.ok(res.parts[0].text.includes("file contents here"));
});

test("normalizeToolXML converts tool tags to normalized XML", () => {
  const xml = "<function=search><parameter=query>node.js</parameter></function>";
  const norm = normalizeToolXML(xml);
  assert.equal(norm, "<search><query>node.js</query></search>");
});

test("normalizeToolXML handles function_name format", () => {
  const xml = '<tool_call><function_name>search</function_name><param name="query">test</param></tool_call>';
  const norm = normalizeToolXML(xml);
  assert.equal(norm, "<search><query>test</query></search>");
});

test("normalizeToolXML returns text without tags unchanged", () => {
  assert.equal(normalizeToolXML("plain text"), "plain text");
  assert.equal(normalizeToolXML(""), "");
  assert.equal(normalizeToolXML(null), null);
});

test("buildToolsSystemPrompt builds function definitions prompt", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        description: "Get current weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      },
    },
  ];
  const prompt = buildToolsSystemPrompt(tools, "auto");
  assert.ok(prompt.includes("# Function calling"));
  assert.ok(prompt.includes("get_weather"));
});

test("buildToolsSystemPrompt handles required tool_choice", () => {
  const tools = [{ type: "function", function: { name: "fn", parameters: {} } }];
  const prompt = buildToolsSystemPrompt(tools, "required");
  assert.ok(prompt.includes("MUST call at least one function"));
});

test("buildToolsSystemPrompt handles named tool_choice", () => {
  const tools = [{ type: "function", function: { name: "my_fn", parameters: {} } }];
  const prompt = buildToolsSystemPrompt(tools, { function: { name: "my_fn" } });
  assert.ok(prompt.includes('MUST call the function "my_fn"'));
});

test("extractBalancedJSON handles simple object", () => {
  assert.equal(extractBalancedJSON('{"a":1}', 0), '{"a":1}');
});

test("extractBalancedJSON handles nested objects", () => {
  const input = '{"config":{"nested":{"deep":true}},"x":1}';
  assert.equal(extractBalancedJSON(input, 0), input);
});

test("extractBalancedJSON handles arrays", () => {
  const input = '{"arr":[1,2,{"b":3}]}';
  assert.equal(extractBalancedJSON(input, 0), input);
});

test("extractBalancedJSON handles strings with braces", () => {
  const input = '{"text":"hello {world} [test]"}';
  assert.equal(extractBalancedJSON(input, 0), input);
});

test("extractBalancedJSON handles escaped quotes in strings", () => {
  const input = '{"text":"say \\"hi\\""}';
  assert.equal(extractBalancedJSON(input, 0), input);
});

test("extractBalancedJSON returns null for incomplete JSON", () => {
  assert.equal(extractBalancedJSON('{"a":1', 0), null);
  assert.equal(extractBalancedJSON('{"a":{"b":1}', 0), null);
});

test("extractBalancedJSON works with offset", () => {
  const input = 'prefix {"key":"val"} suffix';
  assert.equal(extractBalancedJSON(input, 7), '{"key":"val"}');
});

test("parseHermesToolCalls parses XML tool calls correctly", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_weather",
        parameters: {
          properties: {
            city: { type: "string" },
            units: { type: "string" },
          },
        },
      },
    },
  ];
  const input = `<tool_call>
<function=get_weather>
<parameter=city>São Paulo</parameter>
<parameter=units>metric</parameter>
</function>
</tool_call>`;

  const { content, toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(content, "");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "get_weather");
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.city, "São Paulo");
  assert.equal(args.units, "metric");
});

test("parseHermesToolCalls handles multiple tool calls", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "read_file",
        parameters: { properties: { path: { type: "string" } } },
      },
    },
    {
      type: "function",
      function: {
        name: "write_file",
        parameters: { properties: { path: { type: "string" }, content: { type: "string" } } },
      },
    },
  ];
  const input = `Some text before
<tool_call>
<function=read_file>
<parameter=path>/tmp/a.js</parameter>
</function>
</tool_call>
Middle text
<tool_call>
<function=write_file>
<parameter=path>/tmp/b.js</parameter>
<parameter=content>hello world</parameter>
</function>
</tool_call>
Trailing text`;
  const { content, toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(toolCalls.length, 2);
  assert.equal(toolCalls[0].function.name, "read_file");
  assert.equal(toolCalls[1].function.name, "write_file");
  assert.ok(content.includes("Some text before"));
  assert.ok(content.includes("Middle text"));
  assert.ok(content.includes("Trailing text"));
});

test("parseHermesToolCalls handles nested JSON in parameters", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "configure",
        parameters: { properties: { options: { type: "object" } } },
      },
    },
  ];
  const input = `<tool_call>
<function=configure>
<parameter=options>{"theme":"dark","nested":{"a":1}}</parameter>
</function>
</tool_call>`;
  const { toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.deepEqual(args.options, { theme: "dark", nested: { a: 1 } });
});

test("parseHermesToolCalls handles [Called] format with nested JSON", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "edit_file",
        parameters: {
          properties: {
            path: { type: "string" },
            config: { type: "object" },
          },
        },
      },
    },
  ];
  const input = '[Called edit_file with {"path":"/tmp/x.js","config":{"indent":2,"wrap":true}}]';
  const { content, toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(content, "");
  assert.equal(toolCalls.length, 1);
  assert.equal(toolCalls[0].function.name, "edit_file");
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.path, "/tmp/x.js");
  assert.deepEqual(args.config, { indent: 2, wrap: true });
});

test("parseHermesToolCalls handles [Called] with braces in string values", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "write_file",
        parameters: { properties: { content: { type: "string" } } },
      },
    },
  ];
  const input = '[Called write_file with {"content":"function() { return {a: 1}; }"}]';
  const { toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(toolCalls.length, 1);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.content, "function() { return {a: 1}; }");
});

test("parseHermesToolCalls ignores unknown tool names in [Called] format", () => {
  const tools = [
    {
      type: "function",
      function: { name: "known_tool", parameters: { properties: {} } },
    },
  ];
  const input = '[Called unknown_tool with {"x":1}]';
  const { content, toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(toolCalls.length, 0);
  assert.equal(content, input);
});

test("parseHermesToolCalls handles malformed XML gracefully", () => {
  const tools = [
    {
      type: "function",
      function: { name: "test", parameters: { properties: {} } },
    },
  ];
  const input = "<tool_call><function=test><parameter=x>val</function></tool_call>";
  const { toolCalls } = parseHermesToolCalls(input, tools);
  assert.equal(toolCalls.length, 0);
});

test("parseHermesToolCalls handles empty input", () => {
  const tools = [
    { type: "function", function: { name: "test", parameters: { properties: {} } } },
  ];
  const { content, toolCalls } = parseHermesToolCalls("", tools);
  assert.equal(toolCalls.length, 0);
  assert.equal(content, "");
});

test("parseHermesToolCalls coerces boolean and number params", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "configure",
        parameters: {
          properties: {
            enabled: { type: "boolean" },
            count: { type: "integer" },
            ratio: { type: "number" },
          },
        },
      },
    },
  ];
  const input = `<tool_call>
<function=configure>
<parameter=enabled>true</parameter>
<parameter=count>42</parameter>
<parameter=ratio>3.14</parameter>
</function>
</tool_call>`;
  const { toolCalls } = parseHermesToolCalls(input, tools);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.enabled, true);
  assert.equal(args.count, 42);
  assert.equal(args.ratio, 3.14);
});

test("parseHermesToolCalls preserves whitespace in content params", () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "write_file",
        parameters: {
          properties: {
            content: { type: "string" },
            path: { type: "string" },
          },
        },
      },
    },
  ];
  const input = `<tool_call>
<function=write_file>
<parameter=path>  /tmp/file.js  </parameter>
<parameter=content>  indented code
more code  </parameter>
</function>
</tool_call>`;
  const { toolCalls } = parseHermesToolCalls(input, tools);
  const args = JSON.parse(toolCalls[0].function.arguments);
  assert.equal(args.path, "/tmp/file.js");
  assert.ok(args.content.includes("indented code"));
});

test("parseCalledBlocks extracts multiple blocks", () => {
  const schema = {
    read_file: { properties: { path: { type: "string" } } },
    list_dir: { properties: { dir: { type: "string" } } },
  };
  const text = 'Before [Called read_file with {"path":"/a.js"}] middle [Called list_dir with {"dir":"/tmp"}] after';
  const blocks = parseCalledBlocks(text, schema);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].toolCall.function.name, "read_file");
  assert.equal(blocks[1].toolCall.function.name, "list_dir");
  assert.ok(blocks[0].start < blocks[1].start);
});

test("parseCalledBlocks handles JSON with nested braces", () => {
  const schema = {
    configure: { properties: { opts: { type: "object" } } },
  };
  const text = '[Called configure with {"opts":{"a":{"b":1},"c":[1,2]}}]';
  const blocks = parseCalledBlocks(text, schema);
  assert.equal(blocks.length, 1);
  const args = JSON.parse(blocks[0].toolCall.function.arguments);
  assert.deepEqual(args.opts, { a: { b: 1 }, c: [1, 2] });
});

test("parseCalledBlocks skips incomplete blocks", () => {
  const schema = { fn: { properties: {} } };
  const text = '[Called fn with {"a":1';
  const blocks = parseCalledBlocks(text, schema);
  assert.equal(blocks.length, 0);
});

test("findCompleteToolBlocks finds both XML and Called blocks", () => {
  const schema = {
    search: { properties: { q: { type: "string" } } },
    read: { properties: { path: { type: "string" } } },
  };
  const text = `Text
<tool_call>
<function=search>
<parameter=q>hello</parameter>
</function>
</tool_call>
More text [Called read with {"path":"/x.js"}] end`;
  const blocks = findCompleteToolBlocks(text, schema);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].type, "xml");
  assert.equal(blocks[0].toolCall.function.name, "search");
  assert.equal(blocks[1].type, "called");
  assert.equal(blocks[1].toolCall.function.name, "read");
});

test("findCompleteToolBlocks ignores incomplete XML blocks", () => {
  const schema = { fn: { properties: {} } };
  const text = '<tool_call>\n<function=fn>\n<parameter=x>val</parameter>\n</function>';
  const blocks = findCompleteToolBlocks(text, schema);
  assert.equal(blocks.length, 0);
});

test("hasIncompleteToolBlock detects open tool_call tag", () => {
  assert.equal(hasIncompleteToolBlock("text <tool_call> partial"), true);
  assert.equal(hasIncompleteToolBlock("<tool_call><function=x></function></tool_call>"), false);
});

test("hasIncompleteToolBlock detects open Called block", () => {
  assert.equal(hasIncompleteToolBlock('[Called fn with {"a":'), true);
  assert.equal(hasIncompleteToolBlock('[Called fn with {"a":1}]'), false);
});

test("hasIncompleteToolBlock returns false for no tool markers", () => {
  assert.equal(hasIncompleteToolBlock("plain text without tools"), false);
  assert.equal(hasIncompleteToolBlock(""), false);
});

test("hasIncompleteToolBlock handles completed XML followed by incomplete Called", () => {
  const text = '</tool_call> text [Called fn with {"x":1';
  assert.equal(hasIncompleteToolBlock(text), true);
});

test("formatToolPart formats part state accurately", () => {
  const part = {
    tool: "read_file",
    state: { input: { filePath: "/path/to/file.js" } },
  };
  assert.equal(formatToolPart(part), "read_file(/path/to/file.js)");

  const partNoInput = { tool: "list_files", state: {} };
  assert.equal(formatToolPart(partNoInput), "list_files");
});

test("formatToolPart truncates long arguments", () => {
  const part = {
    tool: "write_file",
    state: { input: { content: "x".repeat(200) } },
  };
  const result = formatToolPart(part);
  assert.ok(result.length <= 135);
  assert.ok(result.endsWith("...)"));
});

test("formatToolPart handles missing state", () => {
  assert.equal(formatToolPart({ tool: "test" }), "test");
  assert.equal(formatToolPart({}), "tool");
});
