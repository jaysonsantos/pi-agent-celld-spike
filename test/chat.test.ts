import assert from "node:assert/strict";
import { test } from "node:test";
import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord, LiveState } from "@earendil-works/pi-durable";
import { CHAT_ITEM, CHAT_SOURCE, chatItems, liveView } from "../src/worker/chat.ts";
import type { FeatureSpec } from "../src/worker/pipeline/docs.ts";
import { implementPrompt, userMessagePrompt, verdictReminder } from "../src/worker/pipeline/roles.ts";

const SPEC: FeatureSpec = {
  name: "demo",
  repo: "https://example.com/project.git",
  ref: "",
  task: "Add a thing.",
  rootSetup: "",
  userSetup: "",
  env: {},
};
const AT = 1_700_000_000_000;

function entry(id: number, kind: string, model?: unknown[], data?: unknown): EntryRecord {
  return { id, conversationId: 1, kind, model, data } as unknown as EntryRecord;
}

function user(content: string): Message {
  return { role: "user", content, timestamp: AT };
}

test("tells a prompt of the pipeline from a message of the user", () => {
  const [pipeline] = chatItems(entry(5, "pi.user", [user(implementPrompt(SPEC, 2, "A finding."))]));
  assert.ok(pipeline?.type === CHAT_ITEM.prompt);
  assert.equal(pipeline.source, CHAT_SOURCE.pipeline);
  assert.equal(pipeline.step, "implement-2");

  const [mine] = chatItems(entry(6, "pi.user", [user(userMessagePrompt("Use a short name.", true))]));
  assert.ok(mine?.type === CHAT_ITEM.prompt);
  assert.equal(mine.source, CHAT_SOURCE.user);
  assert.equal(mine.text, "Use a short name.");
  assert.equal(mine.at, AT);

  const [round] = chatItems(
    entry(12, "pi.user", [user(implementPrompt(SPEC, 3, "", "Add a default.\n\nKeep the old name."))]),
  );
  assert.ok(round?.type === CHAT_ITEM.prompt);
  assert.equal(round.source, CHAT_SOURCE.pipeline);
  assert.equal(round.request, "Add a default.\n\nKeep the old name.");
  assert.equal(pipeline.request, null);

  const [reminder] = chatItems(entry(7, "pi.user", [user(verdictReminder())]));
  assert.ok(reminder?.type === CHAT_ITEM.prompt);
  assert.equal(reminder.step, "verdict");
});

test("gives the text, the thinking, and the tool calls of an answer", () => {
  const message = {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "The file is small." },
      { type: "text", text: "I run the tests." },
      { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pytest -q\necho done", timeout: 60 } },
      { type: "toolCall", id: "call-2", name: "weather", arguments: { city: "Lisbon" } },
    ],
    stopReason: "toolUse",
    timestamp: AT,
  };
  const [item] = chatItems(entry(8, "pi.assistant", [message]));
  assert.ok(item?.type === CHAT_ITEM.assistant);
  assert.equal(item.text, "I run the tests.");
  assert.equal(item.thinking, "The file is small.");
  assert.equal(item.stop, "toolUse");
  assert.equal(item.error, null);
  assert.deepEqual(
    item.calls.map((call) => [call.id, call.name, call.title]),
    [
      ["call-1", "bash", "pytest -q"],
      ["call-2", "weather", '{"city":"Lisbon"}'],
    ],
  );
  assert.match(item.calls[0]?.args ?? "", /"timeout": 60/);
});

test("gives a tool result with its call id, and cuts a long output", () => {
  const long = "x".repeat(9000);
  const message = {
    role: "toolResult",
    toolCallId: "call-1",
    toolName: "bash",
    content: [{ type: "text", text: long }],
    isError: true,
    timestamp: AT,
  };
  const [item] = chatItems(entry(9, "pi.tool_result", [message], { diagnostics: [] }));
  assert.ok(item?.type === CHAT_ITEM.tool);
  assert.equal(item.callId, "call-1");
  assert.equal(item.isError, true);
  assert.ok(item.text.length < long.length);
  assert.match(item.text, /\[\.\.\. 1000 more characters\]$/);
});

test("gives no item for an entry without a message for the page", () => {
  assert.deepEqual(chatItems(entry(10, "pi.system", [{ role: "system", content: "" }])), []);
  assert.deepEqual(chatItems(entry(11, "app.bookkeeping")), []);
});

test("shows the live state of an agent", () => {
  assert.deepEqual(liveView(undefined), { busy: false, text: "", thinking: "", calls: [], tools: [], retry: null });

  const live = {
    run: { taskId: 3, inputs: [4] },
    generation: {
      attempt: 2,
      message: { role: "assistant", content: [{ type: "text", text: "I read the" }] },
      retry: { at: AT, error: "HTTP 529" },
    },
    tools: [{ callId: "call-1", name: "bash", status: "running", output: `${"a".repeat(5000)}END` }],
  } as unknown as LiveState;
  const view = liveView(live);
  assert.equal(view.busy, true);
  assert.equal(view.text, "I read the");
  assert.deepEqual(view.retry, { at: AT, error: "HTTP 529" });
  assert.equal(view.tools[0]?.status, "running");
  // Of running output, the page gets the end.
  assert.ok(view.tools[0]?.output.endsWith("END"));
  assert.ok((view.tools[0]?.output.length ?? 0) < 5000);
});
