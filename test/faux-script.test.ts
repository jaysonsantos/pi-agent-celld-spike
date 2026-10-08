import assert from "node:assert/strict";
import { test } from "node:test";
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import type { FeatureSpec } from "../src/worker/pipeline/docs.ts";
import { fauxRoute } from "../src/worker/pipeline/faux-script.ts";
import {
  implementPrompt,
  researchPrompt,
  testPrompt,
  userMessagePrompt,
  VERDICT,
  verdictReminder,
} from "../src/worker/pipeline/roles.ts";

const SPEC: FeatureSpec = {
  name: "demo",
  repo: "https://example.com/project.git",
  ref: "",
  task: "Add a thing.",
  rootSetup: "",
  userSetup: "",
  env: {},
};

function user(content: string): Message {
  return { role: "user", content, timestamp: 0 };
}

function toolResult(isError: boolean): Message {
  return { role: "toolResult", toolCallId: "call", toolName: "bash", content: [], isError, timestamp: 0 };
}

function route(messages: Message[]): AssistantMessage {
  return fauxRoute({ messages } as TranscriptContext);
}

function toolCall(message: AssistantMessage): { name: string; arguments: Record<string, unknown> } {
  const call = message.content.find((part) => part.type === "toolCall");
  assert.ok(call !== undefined && call.type === "toolCall", "the answer must be a tool call");
  return { name: call.name, arguments: call.arguments };
}

function answer(message: AssistantMessage): string {
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

test("walks the script of a role by the number of tool results", () => {
  const prompt = user(researchPrompt(SPEC));
  assert.equal(toolCall(route([prompt])).name, "bash");
  const write = toolCall(route([prompt, toolResult(false)]));
  assert.equal(write.name, "write");
  assert.equal(write.arguments.path, "docs/features/demo/research.md");
  assert.match(answer(route([prompt, toolResult(false), toolResult(false)])), /research is in/);
});

test("sends a failed call again, so a restart in a tool call does not skip a step", () => {
  const prompt = user(researchPrompt(SPEC));
  assert.equal(toolCall(route([prompt, toolResult(true)])).name, "bash");
});

test("rejects the first test round and accepts the second", () => {
  const done = [toolResult(false), toolResult(false)];
  assert.match(answer(route([user(testPrompt(SPEC, 1)), ...done])), new RegExp(`VERDICT: ${VERDICT.fail}`));
  assert.match(answer(route([user(testPrompt(SPEC, 2)), ...done])), new RegExp(`VERDICT: ${VERDICT.pass}`));
});

test("uses the edit tool in a repair round", () => {
  const prompt = user(implementPrompt(SPEC, 2, "The function has no docstring."));
  assert.equal(toolCall(route([prompt])).name, "edit");
});

test("answers the request for a verdict line", () => {
  const messages = [user(testPrompt(SPEC, 2)), toolResult(false), user(verdictReminder())];
  assert.equal(answer(route(messages)), `VERDICT: ${VERDICT.pass}`);
});

test("has a fixed answer for a prompt without markers", () => {
  assert.match(answer(route([user("Hello")])), /no answer/);
});

function assistant(text: string): Message {
  return { ...route([user("Hello")]), content: [{ type: "text", text }], stopReason: "stop" };
}

test("continues the script when the user sends a message during a step", () => {
  const prompt = user(implementPrompt(SPEC, 1, ""));
  const steer = user(userMessagePrompt("Use a short name.", true));
  // The message arrives after the first tool result: the script sends its second call.
  assert.equal(toolCall(route([prompt, toolResult(false), steer])).name, "write");
  // The answer of the step tells that the message arrived.
  const done = [toolResult(false), steer, toolResult(false), toolResult(false)];
  assert.match(answer(route([prompt, ...done])), /Messages of the user in this step: 1\.\nChanged files:/);
});

test("answers a message of the user after the answer of a step", () => {
  const prompt = user(testPrompt(SPEC, 2));
  const done = [toolResult(false), toolResult(false), assistant("The tests pass.\nVERDICT: PASS")];
  const reply = answer(route([prompt, ...done, user(userMessagePrompt("Which tests ran?", false))]));
  assert.equal(reply, 'The scripted model read your message: "Which tests ran?".');
});

test("gives a follow-up round its own script", () => {
  const prompt = user(implementPrompt(SPEC, 3, "", "Add a comment."));
  const call = toolCall(route([prompt]));
  assert.equal(call.name, "bash");
  assert.match(String(call.arguments.command), /echo "# implement-3" >> faux_feature\.py/);
  assert.match(answer(route([prompt, toolResult(false)])), /one comment line for implement-3/);
  // The scripted tester rejects only the first round.
  const tested = [toolResult(false), toolResult(false)];
  assert.match(answer(route([user(testPrompt(SPEC, 3, "Add a comment.")), ...tested])), /VERDICT: PASS/);
});
