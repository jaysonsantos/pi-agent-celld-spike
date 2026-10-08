// A scripted model for the tests of the pipeline. It needs no key and gives the same answers each time, so a run in
// the cluster can prove the durable parts: the storage, the sandbox, the tools, and the recovery after a pod loss.
//
// The script keeps no state. It reads the role and the step from the prompt, and it counts the tool results that came
// after that prompt. So a new process continues the script at the correct step.
import type { AssistantMessage, Message, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import {
  DOCUMENT,
  isVerdictReminder,
  PROMPT_MARKER,
  parseUserMessage,
  ROLE,
  type Role,
  VERDICT,
  VERDICT_PREFIX,
} from "./roles.ts";

/** The implementer waits this long in one command, so a test can stop the pod while a tool runs. */
export const FAUX_SLOW_COMMAND_SECONDS = 45;
const FAUX_MODULE_PATH = "faux_feature.py";
const FAUX_TEST_PATH = "test/test_faux_feature.py";
/** The scripted tester rejects this round one time, so the run also covers the repair loop. */
const FAUX_REJECTED_STEP = "test-1";
const FAUX_FIRST_STEP = "implement-1";
/** The repair after the rejected round. Each later step is a follow-up of the user. */
const FAUX_REPAIR_STEP = "implement-2";
const USER_REPLY_MAX_CHARS = 200;
const STOP_REASON_DONE = "stop";

const TOOL = { bash: "bash", write: "write", edit: "edit" } as const;

type ScriptStep =
  | { tool: typeof TOOL.bash; command: string }
  | { tool: typeof TOOL.write; path: string; content: string }
  | { tool: typeof TOOL.edit; path: string; oldText: string; newText: string }
  | { answer: string };

interface PromptFacts {
  role: Role;
  feature: string;
  docs: string;
  step: string;
}

function messageText(message: Message): string {
  const content: unknown = message.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      typeof part === "object" && part !== null && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("");
}

function marker(prompt: string, name: string): string | undefined {
  for (const line of prompt.split("\n")) {
    if (line.startsWith(name)) return line.slice(name.length).trim();
  }
  return undefined;
}

function readFacts(prompt: string): PromptFacts | undefined {
  const role = marker(prompt, PROMPT_MARKER.role);
  const feature = marker(prompt, PROMPT_MARKER.feature);
  const docs = marker(prompt, PROMPT_MARKER.docs);
  const step = marker(prompt, PROMPT_MARKER.step);
  if (role === undefined || feature === undefined || docs === undefined || step === undefined) return undefined;
  if (!(Object.values(ROLE) as string[]).includes(role)) return undefined;
  return { role: role as Role, feature, docs, step };
}

function script(facts: PromptFacts): ScriptStep[] {
  const { feature, docs, step } = facts;
  const moduleV1 = `def faux_feature():\n    return "${feature}"\n`;
  const docstring = `    """Return the name of the feature that the scripted pipeline added."""\n`;
  const test = `from faux_feature import faux_feature\n\n\ndef test_faux_feature():\n    assert faux_feature() == "${feature}"\n`;
  switch (facts.role) {
    case ROLE.researcher:
      return [
        { tool: TOOL.bash, command: "ls && git log --oneline -3 && git status --short" },
        {
          tool: TOOL.write,
          path: `${docs}/${DOCUMENT.research}`,
          content: `# Research: ${feature}\n\n## Summary\n\nScripted research for ${feature}.\n`,
        },
        { answer: `The research is in ${docs}/${DOCUMENT.research}.` },
      ];
    case ROLE.architect:
      return [
        {
          tool: TOOL.write,
          path: `${docs}/${DOCUMENT.prd}`,
          content: `# PRD: ${feature}\n\n## Requirements\n\n1. \`faux_feature()\` returns the feature name.\n`,
        },
        {
          tool: TOOL.write,
          path: `${docs}/${DOCUMENT.adr}`,
          content: `# ADR: ${feature}\n\n## Status\n\nAccepted.\n\n## Decision\n\nAdd one module with one function.\n`,
        },
        { answer: `The requirements and the decision record are in ${docs}.` },
      ];
    case ROLE.implementer:
      if (step === FAUX_FIRST_STEP) {
        return [
          { tool: TOOL.write, path: FAUX_MODULE_PATH, content: moduleV1 },
          { tool: TOOL.write, path: FAUX_TEST_PATH, content: test },
          {
            tool: TOOL.bash,
            command: `for i in $(seq 1 ${FAUX_SLOW_COMMAND_SECONDS}); do echo "working $i"; sleep 1; done; python -m pytest -q -p no:cacheprovider ${FAUX_TEST_PATH}`,
          },
          { answer: `Changed files:\n- ${FAUX_MODULE_PATH}: the new function\n- ${FAUX_TEST_PATH}: its test` },
        ];
      }
      if (step === FAUX_REPAIR_STEP) {
        return [
          {
            tool: TOOL.edit,
            path: FAUX_MODULE_PATH,
            oldText: `def faux_feature():\n`,
            newText: `def faux_feature():\n${docstring}`,
          },
          { tool: TOOL.bash, command: `python -m pytest -q -p no:cacheprovider ${FAUX_TEST_PATH}` },
          { answer: `Changed files:\n- ${FAUX_MODULE_PATH}: added the docstring` },
        ];
      }
      return [
        {
          tool: TOOL.bash,
          command: `echo "# ${step}" >> ${FAUX_MODULE_PATH} && python -m pytest -q -p no:cacheprovider ${FAUX_TEST_PATH}`,
        },
        { answer: `Changed files:\n- ${FAUX_MODULE_PATH}: one comment line for ${step}` },
      ];
    case ROLE.tester: {
      const rejected = step === FAUX_REJECTED_STEP;
      return [
        { tool: TOOL.bash, command: `git status --short && python -m pytest -q -p no:cacheprovider ${FAUX_TEST_PATH}` },
        {
          tool: TOOL.write,
          path: `${docs}/${DOCUMENT.testReport}`,
          content: `# Test report: ${feature}\n\n- Step: ${step}\n- Command: pytest ${FAUX_TEST_PATH}\n- Result: ${rejected ? "the function has no docstring" : "passed"}\n`,
        },
        rejected
          ? { answer: `faux_feature() has no docstring. Add one.\n${VERDICT_PREFIX} ${VERDICT.fail}` }
          : { answer: `The tests pass.\n${VERDICT_PREFIX} ${VERDICT.pass}` },
      ];
    }
    case ROLE.reviewer:
      return [
        { tool: TOOL.bash, command: "git status --short && git diff --stat" },
        {
          tool: TOOL.write,
          path: `${docs}/${DOCUMENT.review}`,
          content: `# Review: ${feature}\n\nNo blocker and no major finding.\n`,
        },
        { answer: `The change is acceptable.\n${VERDICT_PREFIX} ${VERDICT.pass}` },
      ];
  }
}

function toMessage(step: ScriptStep): AssistantMessage {
  if ("answer" in step) return fauxAssistantMessage(step.answer);
  const { tool, ...args } = step;
  return fauxAssistantMessage([fauxToolCall(tool, args)], { stopReason: "toolUse" });
}

/** The answer of the scripted model to one request. */
export function fauxRoute(context: TranscriptContext): AssistantMessage {
  const messages = context.messages;
  let promptIndex = -1;
  let facts: PromptFacts | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "user") continue;
    facts = readFacts(messageText(message));
    if (facts !== undefined) {
      promptIndex = index;
      break;
    }
  }
  const last = messages.at(-1);
  const lastFromUser = last?.role === "user" ? parseUserMessage(messageText(last)) : undefined;
  if (facts === undefined) {
    if (lastFromUser !== undefined) return fauxAssistantMessage(userReply(lastFromUser));
    return fauxAssistantMessage("The scripted model has no answer for this prompt.");
  }

  const after = messages.slice(promptIndex + 1);
  const later = after.filter((message) => message.role === "user").map(messageText);
  if (later.some(isVerdictReminder)) return fauxAssistantMessage(`${VERDICT_PREFIX} ${VERDICT.pass}`);
  // A message of the user after the answer of the step: the script answers that message.
  const answered = after.some((message) => message.role === "assistant" && message.stopReason === STOP_REASON_DONE);
  if (answered && lastFromUser !== undefined) return fauxAssistantMessage(userReply(lastFromUser));

  // A failed or interrupted call does not count, so the script sends that call again.
  const done = after.filter((message) => message.role === "toolResult" && !message.isError).length;
  const steps = script(facts);
  const step = steps[Math.min(done, steps.length - 1)] ?? { answer: "Done." };
  // A message of the user during the step: the script continues, and its answer tells that the message arrived.
  const fromUser = later.filter((text) => parseUserMessage(text) !== undefined).length;
  if ("answer" in step && fromUser > 0 && !answered) {
    return fauxAssistantMessage(`Messages of the user in this step: ${fromUser}.\n${step.answer}`);
  }
  return toMessage(step);
}

function userReply(words: string): string {
  return `The scripted model read your message: "${words.slice(0, USER_REPLY_MAX_CHARS)}".`;
}
