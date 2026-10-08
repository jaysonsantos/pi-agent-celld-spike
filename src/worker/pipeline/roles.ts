// The agents of the pipeline. Each role is one conversation with its own instructions and transcript; all of them
// work in the same sandbox, on the same checkout.
import type { FeatureSpec } from "./docs.ts";

export const ROLE = {
  researcher: "researcher",
  architect: "architect",
  implementer: "implementer",
  tester: "tester",
  reviewer: "reviewer",
} as const;
export type Role = (typeof ROLE)[keyof typeof ROLE];
export const ROLES: readonly Role[] = Object.values(ROLE);

// region: sandbox layout
export const WORKSPACE_PATH = "/workspace";
export const REPO_PATH = `${WORKSPACE_PATH}/repo`;
export const SANDBOX_HOME_PATH = `${WORKSPACE_PATH}/home`;
export const SETUP_DIRECTORY = `${WORKSPACE_PATH}/.pi`;
/** On the container file system, so a new pod of the sandbox does not have it and gets the setup again. */
export const PREPARED_MARKER_PATH = "/var/run/pi-sandbox-prepared";
export const FEATURE_BRANCH_PREFIX = "feature/";
export const DOCS_ROOT = "docs/features";
// endregion: sandbox layout

export const DOCUMENT = {
  research: "research.md",
  prd: "prd.md",
  adr: "adr.md",
  testReport: "test-report.md",
  review: "review.md",
} as const;

// region: verdict
export const VERDICT = { pass: "PASS", fail: "FAIL" } as const;
export type Verdict = (typeof VERDICT)[keyof typeof VERDICT];
export const VERDICT_PREFIX = "VERDICT:";
/** A model often writes the line as a list item, a quote, or bold text, so Markdown marks can come before it. */
const VERDICT_PATTERN = new RegExp(
  `^[\\s>*_#\`-]*${VERDICT_PREFIX}[\\s*_\`]*(${VERDICT.pass}|${VERDICT.fail})\\b`,
  "i",
);

/** The last verdict line of an answer, or `undefined` when the answer has none. */
export function parseVerdict(answer: string): Verdict | undefined {
  let found: Verdict | undefined;
  for (const line of answer.split("\n")) {
    const match = VERDICT_PATTERN.exec(line);
    if (match !== null) found = match[1]?.toUpperCase() === VERDICT.pass ? VERDICT.pass : VERDICT.fail;
  }
  return found;
}
// endregion: verdict

// region: prompt markers
/** Lines that each prompt starts with. The scripted model of the tests reads them. */
export const PROMPT_MARKER = {
  role: "ROLE:",
  feature: "FEATURE:",
  docs: "DOCS:",
  step: "STEP:",
} as const;
/** The first line of a message that a person wrote. The page and the scripted model read it. */
export const USER_MESSAGE_MARKER = "USER:";
/** The first line of the request for a verdict line. */
const VERDICT_REMINDER_START = "Your answer has no verdict line.";
// endregion: prompt markers

export function docsDirectory(feature: string): string {
  return `${DOCS_ROOT}/${feature}`;
}

export function featureBranch(feature: string): string {
  return `${FEATURE_BRANCH_PREFIX}${feature}`;
}

const SHARED_RULES = `Rules for every agent of this pipeline:
- The project checkout is ${REPO_PATH}. It is on a feature branch. Work only inside that directory.
- Other agents work on the same checkout before and after you. Read their documents before you start.
- Use the tools: read, write, and edit for files, and bash for commands. Do not ask questions; there is no person to answer.
- A message that starts with "${USER_MESSAGE_MARKER}" is from the user of the pipeline. It has priority over the documents.
- Do not run git commit, git push, or git reset. The pipeline collects the diff at the end.
- Follow the conventions of the project. Read AGENTS.md, CONTRIBUTING.md, and the README of the project first, when they exist.
- Keep each document short and factual, in Markdown.`;

const ROLE_INSTRUCTIONS: Record<Role, string> = {
  researcher: `You are the researcher. You study the project and the requested feature before any code changes.
You read the code, the tests, and the documentation. You do not change source files or tests.
Your one output is a research document.`,
  architect: `You are the architect. You turn the research into requirements and a design decision.
You do not change source files or tests. Your outputs are a product requirements document and an architecture decision record.`,
  implementer: `You are the implementer. You write the code and the tests that the requirements and the design ask for.
Make the smallest change that satisfies them. Keep the public API of the project backward compatible.
When a tester or a reviewer sends findings, fix each finding.`,
  tester: `You are the tester. You do not trust the implementer. You run the test suite and the linters of the project,
you add tests for cases that are missing, and you write a test report. You change test files only, never source files.`,
  reviewer: `You are the reviewer. You review the diff of the feature branch against the requirements and the design.
You do not change source files or tests. Your one output is a review document.`,
};

export function roleInstructions(role: Role): string {
  return `${ROLE_INSTRUCTIONS[role]}\n\n${SHARED_RULES}`;
}

function header(role: Role, spec: FeatureSpec, step: string): string {
  return [
    `${PROMPT_MARKER.role} ${role}`,
    `${PROMPT_MARKER.feature} ${spec.name}`,
    `${PROMPT_MARKER.docs} ${docsDirectory(spec.name)}`,
    `${PROMPT_MARKER.step} ${step}`,
  ].join("\n");
}

function verdictRule(passMeaning: string, failMeaning: string): string {
  return `End your answer with one line: "${VERDICT_PREFIX} ${VERDICT.pass}" when ${passMeaning}, or "${VERDICT_PREFIX} ${VERDICT.fail}" when ${failMeaning}.`;
}

export function researchPrompt(spec: FeatureSpec): string {
  const docs = docsDirectory(spec.name);
  return `${header(ROLE.researcher, spec, "research")}

The feature to add to this project:

${spec.task}

Study the project: its structure, the modules that the feature touches, the tests, the tooling, and the conventions.
Write your findings to ${docs}/${DOCUMENT.research} with these sections: Summary, Relevant code (with file paths), How the tests run, Constraints and risks, Open questions.
When the file is written, answer with a summary of five lines or less.`;
}

export function designPrompt(spec: FeatureSpec): string {
  const docs = docsDirectory(spec.name);
  return `${header(ROLE.architect, spec, "design")}

The feature to add to this project:

${spec.task}

Read ${docs}/${DOCUMENT.research} first. Then write two documents:
1. ${docs}/${DOCUMENT.prd}: the product requirements. Sections: Problem, Goals, Non-goals, Requirements (numbered, each one testable), Acceptance criteria.
2. ${docs}/${DOCUMENT.adr}: the architecture decision record. Sections: Status, Context, Decision, Alternatives considered, Consequences.
When both files are written, answer with a summary of five lines or less.`;
}

/** The text before and after the request in the first prompt of a follow-up. The page reads the request back. */
const FOLLOW_UP_INTRO = "The earlier rounds are done. The user now asks for this change:\n\n";
const FOLLOW_UP_OUTRO = "\n\nMake the change with its tests and its user documentation.";

/** The request of a follow-up, as a part of a prompt. Empty when the pipeline has no follow-up request. */
function requestSection(request: string): string {
  return request === "" ? "" : `The user asked for this change after the earlier rounds:\n\n${request}\n\n`;
}

/**
 * `request` is the text of a follow-up: a change that the user asks for after the earlier rounds. It is empty in the
 * first pipeline of a feature.
 */
export function implementPrompt(spec: FeatureSpec, round: number, feedback: string, request = ""): string {
  const docs = docsDirectory(spec.name);
  let task: string;
  if (feedback !== "") {
    task = `${requestSection(request)}This is round ${round}. The previous round was not accepted. Fix each of these findings, then run the tests and the linters again:

${feedback}`;
  } else if (request !== "") {
    task = `This is round ${round}. ${FOLLOW_UP_INTRO}${request}${FOLLOW_UP_OUTRO} Update each document in ${docs} that the change makes wrong.
Run the tests and the linters of the project before you answer.`;
  } else {
    task = `Read ${docs}/${DOCUMENT.research}, ${docs}/${DOCUMENT.prd}, and ${docs}/${DOCUMENT.adr}. Implement the feature with its tests and its user documentation.
Run the tests that you added, and the linters of the project, before you answer.`;
  }
  return `${header(ROLE.implementer, spec, `implement-${round}`)}

The feature to add to this project:

${spec.task}

${task}
Answer with the list of the files that you changed and one line for each one.`;
}

export function testPrompt(spec: FeatureSpec, round: number, request = ""): string {
  const docs = docsDirectory(spec.name);
  return `${header(ROLE.tester, spec, `test-${round}`)}

The implementer finished round ${round} of this feature:

${spec.task}

${requestSection(request)}Read ${docs}/${DOCUMENT.prd}. Look at the change with "git status --short" and "git diff". Run the full test suite and the linters of the project.
Add tests for each requirement that has no test. Write ${docs}/${DOCUMENT.testReport}: the commands that you ran, the results, the tests that you added, and each failure with its cause.
${verdictRule("the test suite and the linters pass and each requirement has a test", "something fails or a requirement has no test; list the failures above that line")}`;
}

export function reviewPrompt(spec: FeatureSpec, round: number, request = ""): string {
  const docs = docsDirectory(spec.name);
  return `${header(ROLE.reviewer, spec, `review-${round}`)}

Round ${round} of this feature passed its tests:

${spec.task}

${requestSection(request)}Read ${docs}/${DOCUMENT.prd}, ${docs}/${DOCUMENT.adr}, and ${docs}/${DOCUMENT.testReport}. Review the full change with "git status --short" and "git diff".
Check correctness, backward compatibility, the conventions of the project, the tests, and the documentation.
Write ${docs}/${DOCUMENT.review}: a list of findings, each with a file path, a severity (blocker, major, minor), and a concrete fix.
${verdictRule("there is no blocker and no major finding", "there is a blocker or a major finding; list them above that line")}`;
}

/** A second request to an agent that gave an answer without a verdict line. */
export function verdictReminder(): string {
  return `${VERDICT_REMINDER_START} ${verdictRule("the work is acceptable", "it is not")}`;
}

export function isVerdictReminder(prompt: string): boolean {
  return prompt.startsWith(VERDICT_REMINDER_START);
}

// region: user messages
const USER_NOTE = {
  /** The pipeline runs: the agent has a step in work, or gets one later. */
  pipeline:
    "This message is from the user. If you have a step in work, apply the message to it and then finish the step as its prompt says. If you have no step in work, answer the message.",
  /** The pipeline is at its end: only a new round can change the project. */
  idle: "This message is from the user. The pipeline is at its end. Answer the message. Do not change a file of the project now: tell the user to start a new round for a change.",
} as const;
const USER_NOTE_SEPARATOR = "\n\n---\n";

/** A message of the user to one agent, with a rule for the agent after it. */
export function userMessagePrompt(content: string, pipelineRuns: boolean): string {
  const note = pipelineRuns ? USER_NOTE.pipeline : USER_NOTE.idle;
  return `${USER_MESSAGE_MARKER}\n${content.trim()}${USER_NOTE_SEPARATOR}${note}`;
}

/** The words of the user in a prompt that `userMessagePrompt()` made, or `undefined` for a different prompt. */
export function parseUserMessage(prompt: string): string | undefined {
  const start = `${USER_MESSAGE_MARKER}\n`;
  if (!prompt.startsWith(start)) return undefined;
  const end = prompt.lastIndexOf(USER_NOTE_SEPARATOR);
  return prompt.slice(start.length, end === -1 ? undefined : end);
}

/** The request of the user in the prompt that starts a follow-up, or `undefined` for a different prompt. */
export function followUpRequest(prompt: string): string | undefined {
  if (!prompt.startsWith(PROMPT_MARKER.role)) return undefined;
  const intro = prompt.indexOf(FOLLOW_UP_INTRO);
  const outro = prompt.lastIndexOf(FOLLOW_UP_OUTRO);
  if (intro === -1 || outro === -1) return undefined;
  return prompt.slice(intro + FOLLOW_UP_INTRO.length, outro);
}

/** The step of a prompt of the pipeline, for example `implement-2`, or `undefined` for a different prompt. */
export function promptStep(prompt: string): string | undefined {
  if (!prompt.startsWith(PROMPT_MARKER.role)) return undefined;
  for (const line of prompt.split("\n")) {
    if (line.startsWith(PROMPT_MARKER.step)) return line.slice(PROMPT_MARKER.step.length).trim();
    if (line === "") break;
  }
  return undefined;
}
// endregion: user messages
