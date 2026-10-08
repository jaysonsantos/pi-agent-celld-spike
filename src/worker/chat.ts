// The chat view of one conversation: the entries of its transcript and its live state, as small JSON for the page.
// The functions here change no state, so the unit tests run them on plain Node.js.
import type { Message } from "@earendil-works/pi-ai";
import { CompactionEntry, type EntryRecord, type LiveState, ResetEntry } from "@earendil-works/pi-durable";
import { followUpRequest, isVerdictReminder, parseUserMessage, promptStep } from "./pipeline/roles.ts";

// region: constants
export const CHAT_ITEM = { prompt: "prompt", assistant: "assistant", tool: "tool", note: "note" } as const;
export const CHAT_SOURCE = { user: "user", pipeline: "pipeline" } as const;
/** The step name of the request for a verdict line. */
const VERDICT_STEP = "verdict";

const MAX_TEXT_CHARS = 24_000;
const MAX_THINKING_CHARS = 8000;
const MAX_TOOL_RESULT_CHARS = 8000;
const MAX_CALL_ARGUMENT_CHARS = 4000;
const MAX_CALL_TITLE_CHARS = 160;
/** Of running output, the page shows the end. */
const MAX_LIVE_OUTPUT_CHARS = 4000;
const IMAGE_PLACEHOLDER = "[image]";
/** The argument that names a tool call best: the command of `bash`, the path of a file tool. */
const TITLE_ARGUMENTS = ["command", "path", "file_path", "pattern", "query"] as const;
// endregion: constants

// region: shapes
export interface ChatCall {
  id: string;
  name: string;
  /** One line that tells what the call does. */
  title: string;
  /** The arguments as JSON text. */
  args: string;
}

export interface ChatPrompt {
  type: typeof CHAT_ITEM.prompt;
  id: number;
  at: number;
  source: (typeof CHAT_SOURCE)[keyof typeof CHAT_SOURCE];
  /** The step of a pipeline prompt, for example `implement-2`. */
  step: string | null;
  /** The change that the user asked for, when the prompt starts a new round. */
  request: string | null;
  text: string;
}

export interface ChatAnswer {
  type: typeof CHAT_ITEM.assistant;
  id: number;
  at: number;
  text: string;
  thinking: string;
  calls: ChatCall[];
  stop: string;
  error: string | null;
}

export interface ChatToolResult {
  type: typeof CHAT_ITEM.tool;
  id: number;
  at: number;
  callId: string;
  name: string;
  text: string;
  isError: boolean;
}

export interface ChatNote {
  type: typeof CHAT_ITEM.note;
  id: number;
  text: string;
}

export type ChatItem = ChatPrompt | ChatAnswer | ChatToolResult | ChatNote;

export interface ChatLiveTool {
  callId: string;
  name: string;
  status: string;
  output: string;
}

/** What the agent does at this moment. The page replaces it at each read. */
export interface ChatLive {
  busy: boolean;
  text: string;
  thinking: string;
  calls: ChatCall[];
  tools: ChatLiveTool[];
  /** The model request failed, and the Harness sends it again at this time. */
  retry: { at: number; error: string } | null;
}
// endregion: shapes

function clip(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n[... ${text.length - limit} more characters]`;
}

function clipStart(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `[${text.length - limit} characters before this ...]\n${text.slice(-limit)}`;
}

function firstLine(text: string): string {
  return text.trim().split("\n", 1)[0] ?? "";
}

function callOf(part: object): ChatCall {
  const call = part as { id?: unknown; name?: unknown; arguments?: unknown };
  const args = typeof call.arguments === "object" && call.arguments !== null ? call.arguments : {};
  const named = TITLE_ARGUMENTS.map((key) => (args as Record<string, unknown>)[key]).find(
    (value) => typeof value === "string" && value !== "",
  );
  const title = typeof named === "string" ? firstLine(named) : JSON.stringify(args);
  return {
    id: String(call.id ?? ""),
    name: String(call.name ?? ""),
    title: clip(title, MAX_CALL_TITLE_CHARS),
    args: clip(JSON.stringify(args, null, 2), MAX_CALL_ARGUMENT_CHARS),
  };
}

/** The text, the thinking, and the tool calls of the content of one message. A partial message can lack each part. */
function readContent(content: unknown): { text: string; thinking: string; calls: ChatCall[] } {
  if (typeof content === "string") return { text: content, thinking: "", calls: [] };
  const text: string[] = [];
  const thinking: string[] = [];
  const calls: ChatCall[] = [];
  for (const part of Array.isArray(content) ? (content as unknown[]) : []) {
    if (typeof part !== "object" || part === null || !("type" in part)) continue;
    if (part.type === "text" && "text" in part && typeof part.text === "string") text.push(part.text);
    if (part.type === "thinking" && "thinking" in part && typeof part.thinking === "string") {
      thinking.push(part.thinking);
    }
    if (part.type === "image") text.push(IMAGE_PLACEHOLDER);
    if (part.type === "toolCall") calls.push(callOf(part));
  }
  return { text: text.join(""), thinking: thinking.join("\n\n"), calls };
}

function promptItem(id: number, at: number, text: string): ChatPrompt {
  const fromUser = parseUserMessage(text);
  if (fromUser !== undefined) {
    return { type: CHAT_ITEM.prompt, id, at, source: CHAT_SOURCE.user, step: null, request: null, text: fromUser };
  }
  const step = isVerdictReminder(text) ? VERDICT_STEP : (promptStep(text) ?? null);
  const request = followUpRequest(text) ?? null;
  return {
    type: CHAT_ITEM.prompt,
    id,
    at,
    source: CHAT_SOURCE.pipeline,
    step,
    request,
    text: clip(text, MAX_TEXT_CHARS),
  };
}

function messageItem(id: number, message: Message): ChatItem | undefined {
  if (message.role === "user") return promptItem(id, message.timestamp, readContent(message.content).text);
  if (message.role === "assistant") {
    const { text, thinking, calls } = readContent(message.content);
    return {
      type: CHAT_ITEM.assistant,
      id,
      at: message.timestamp,
      text: clip(text, MAX_TEXT_CHARS),
      thinking: clip(thinking, MAX_THINKING_CHARS),
      calls,
      stop: message.stopReason,
      error: message.errorMessage ?? null,
    };
  }
  if (message.role === "toolResult") {
    return {
      type: CHAT_ITEM.tool,
      id,
      at: message.timestamp,
      callId: message.toolCallId,
      name: message.toolName,
      text: clip(readContent(message.content).text, MAX_TOOL_RESULT_CHARS),
      isError: message.isError,
    };
  }
  return undefined;
}

/** The chat items of one transcript entry, in order. An entry without a part for the page gives no item. */
export function chatItems(entry: EntryRecord): ChatItem[] {
  if (CompactionEntry.is(entry)) {
    return [{ type: CHAT_ITEM.note, id: entry.id, text: "The Harness replaced the earlier messages with a summary." }];
  }
  if (ResetEntry.is(entry)) {
    return [{ type: CHAT_ITEM.note, id: entry.id, text: "A new context starts here." }];
  }
  const items: ChatItem[] = [];
  for (const message of entry.model ?? []) {
    const item = messageItem(entry.id, message);
    if (item !== undefined) items.push(item);
  }
  return items;
}

/** The live state of a conversation for the page. */
export function liveView(live: LiveState | undefined): ChatLive {
  const partial = readContent(live?.generation?.message?.content);
  const retry = live?.generation?.retry;
  return {
    busy: live?.run !== undefined,
    text: clip(partial.text, MAX_TEXT_CHARS),
    thinking: clipStart(partial.thinking, MAX_THINKING_CHARS),
    calls: partial.calls,
    tools: (live?.tools ?? []).map((tool) => ({
      callId: tool.callId,
      name: tool.name,
      status: tool.status,
      output: clipStart(tool.output ?? "", MAX_LIVE_OUTPUT_CHARS),
    })),
    retry: retry === undefined ? null : { at: retry.at, error: retry.error },
  };
}
