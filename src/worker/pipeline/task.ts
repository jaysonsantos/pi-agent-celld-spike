// The pipeline of one feature as a durable task of Pi Durable. Each phase ends with a commit of the next checkpoint,
// so a new process continues at the phase that the old process left.
//
//   provision -> prepare -> research -> design -> implement -> test -> review -> finalize
//                                                    ^            |        |
//                                                    +--- FAIL ---+--------+
//
// An agent phase sends one prompt to the conversation of its role and waits for the answer. The request id of the
// prompt comes from the task id and the checkpoint, so a phase that runs again finds the submission that it made
// before.
//
// A follow-up is a second pipeline of the same feature: the user asks for a change after the first one ended. It
// starts at `implement`, it continues the round numbers, and it uses the conversations that the agents have, so
// each agent keeps its transcript.
import type { Context } from "@earendil-works/chord";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AssistantEntry,
  type ConversationId,
  configure,
  defineExtension,
  defineTask,
  type EntryId,
  type NextTaskState,
  type RunningTask,
  type TaskRuntime,
  type Tx,
} from "@earendil-works/pi-durable";
import { BYTES_PER_KIB, MS_PER_SECOND } from "../constants.ts";
import type { SandboxProvisioner } from "../sandbox/provision.ts";
import { ArtifactsDoc, type FeatureSpec, ProgressDoc, pushEvent, SandboxDoc } from "./docs.ts";
import {
  designPrompt,
  docsDirectory,
  implementPrompt,
  parseVerdict,
  REPO_PATH,
  ROLE,
  type Role,
  researchPrompt,
  reviewPrompt,
  roleInstructions,
  testPrompt,
  VERDICT,
  verdictReminder,
} from "./roles.ts";

// region: constants
export const PIPELINE_TASK_NAME = "app.feature-pipeline";
const PIPELINE_TASK_VERSION = 1;
const PIPELINE_EXTENSION_NAME = "feature-pipeline";

export const PHASE = {
  provision: "provision",
  prepare: "prepare",
  research: "research",
  design: "design",
  implement: "implement",
  test: "test",
  review: "review",
  finalize: "finalize",
} as const;

export const PIPELINE_VERDICT = {
  accepted: "accepted",
  needsAttention: "needs-attention",
} as const;
export type PipelineVerdict = (typeof PIPELINE_VERDICT)[keyof typeof PIPELINE_VERDICT];

const FIRST_ROUND = 1;
/** A phase that throws runs again after a pause, this many times. The cause is often a restart of another pod. */
const MAX_PHASE_ERRORS = 8;
const ERROR_BACKOFF_BASE_MS = 5 * MS_PER_SECOND;
const ERROR_BACKOFF_MAX_MS = 60 * MS_PER_SECOND;
/** A model answer that failed gets a new submission, this many times. */
const MAX_SUBMISSION_ATTEMPTS = 3;
const MAX_FEEDBACK_CHARS = 8 * BYTES_PER_KIB;
// celld refuses one stored value above 2.2 MB, and a refused commit breaks the open Harness. The artifacts are one
// document, so the limits below keep that document well under the limit, also after the escapes of JSON.
const MAX_ARTIFACT_FILE_BYTES = 64 * BYTES_PER_KIB;
const MAX_ARTIFACT_FILES_BYTES = 384 * BYTES_PER_KIB;
const MAX_PATCH_BYTES = 384 * BYTES_PER_KIB;
const TRUNCATED_NOTE = "\n[truncated]\n";
const VERDICT_REQUEST_SUFFIX = ":verdict";
// endregion: constants

// region: state
/** A change that the user asks for after an earlier pipeline of the feature. */
export type FollowUp = {
  request: string;
  /** The first round of this pipeline: one more than the last round of the earlier one. */
  firstRound: number;
};
export type PipelineInput = { spec: FeatureSpec; followUp?: FollowUp };

type Counters = {
  /** Round of implement, test, and review. */
  round: number;
  /** Number of the submission of this phase. A failed answer increases it, and the phase asks again. */
  attempt: number;
  /** Failures of this phase that were not an answer of the model. */
  errors: number;
  /** Findings that the implementer must fix in this round. */
  feedback: string;
  /** Set when the pipeline goes to the end: the result and the reason. */
  verdict: PipelineVerdict;
  note: string;
};

type WorkPhase =
  | typeof PHASE.research
  | typeof PHASE.design
  | typeof PHASE.implement
  | typeof PHASE.test
  | typeof PHASE.review
  | typeof PHASE.finalize;
type WorkState = { [P in WorkPhase]: { phase: P } & Counters }[WorkPhase];

type SetupPhase = typeof PHASE.provision | typeof PHASE.prepare;
/** `resume` is the checkpoint that the pipeline returns to when the sandbox is ready. */
type SetupState = { [P in SetupPhase]: { phase: P; errors: number; resume: WorkState } }[SetupPhase];

export type PipelineState = SetupState | WorkState;
export type PipelineResult = { verdict: PipelineVerdict; rounds: number; note: string };

type Runtime = TaskRuntime<PipelineInput, PipelineState, PipelineResult, object>;
type Running<S extends PipelineState = PipelineState> = RunningTask<PipelineInput, S, PipelineResult>;
type Next = NextTaskState<PipelineState, PipelineResult>;

function work(phase: WorkPhase, changes: Partial<Counters> = {}): WorkState {
  return {
    phase,
    round: FIRST_ROUND,
    attempt: 0,
    errors: 0,
    feedback: "",
    verdict: PIPELINE_VERDICT.accepted,
    note: "",
    ...changes,
  } as WorkState;
}

function running(checkpoint: PipelineState): Next {
  return { status: "running", checkpoint };
}

function failed(message: string): Next {
  return { status: "terminal", outcome: { status: "failed", error: { message } } };
}

function roundOf(state: PipelineState): number {
  return "resume" in state ? state.resume.round : state.round;
}
// endregion: state

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}${TRUNCATED_NOTE}`;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).byteLength;
}

/** Cuts a text to a UTF-8 size. A text with many non-ASCII characters has more bytes than characters. */
function clipToBytes(text: string, limit: number): string {
  if (limit <= TRUNCATED_NOTE.length) return "";
  let clipped = text;
  let size = byteLength(clipped);
  if (size <= limit) return clipped;
  while (size > limit - TRUNCATED_NOTE.length && clipped.length > 0) {
    clipped = clipped.slice(0, Math.floor((clipped.length * (limit - TRUNCATED_NOTE.length)) / size));
    size = byteLength(clipped);
  }
  return `${clipped}${TRUNCATED_NOTE}`;
}

function answerText(message: AssistantMessage | undefined): string {
  if (message === undefined) return "";
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
}

async function record(tx: Tx, now: number, state: PipelineState, phase: string, message: string): Promise<void> {
  const progress = await tx.doc(ProgressDoc);
  progress.phase = state.phase;
  progress.round = roundOf(state);
  pushEvent(progress, { at: now, phase, message });
}

/** Commits the next checkpoint with one line for the progress log. */
async function advance(runtime: Runtime, next: PipelineState, message: string, context: Context): Promise<void> {
  await runtime.commit(async (tx, current) => {
    await record(tx, runtime.now(), next, current.state.checkpoint.phase, message);
    return running(next);
  }, context);
}

export interface PipelineDependencies {
  provisioner: SandboxProvisioner;
  maxRounds: number;
}

export function createPipelineTask(deps: PipelineDependencies) {
  const { provisioner, maxRounds } = deps;

  // region: failure handling
  /**
   * Runs a phase. A throw that is not a stop of the invocation is recorded, and the same checkpoint runs again after
   * a pause. An uncaught throw would end the task for good, and most throws here come from a pod that restarts.
   */
  async function guarded(task: Running, runtime: Runtime, context: Context, phase: () => Promise<void>): Promise<void> {
    try {
      await phase();
    } catch (error) {
      if (runtime.signal.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      const current = task.state.checkpoint;
      const errors = current.errors + 1;
      if (errors > MAX_PHASE_ERRORS) {
        await runtime.commit(async (tx) => {
          await record(tx, runtime.now(), current, current.phase, `stopped after ${errors} failures: ${message}`);
          return failed(`${current.phase} failed ${errors} times: ${message}`);
        }, context);
        return;
      }
      const backoff = Math.min(ERROR_BACKOFF_BASE_MS * 2 ** (errors - 1), ERROR_BACKOFF_MAX_MS);
      await runtime.sleep(runtime.now() + backoff, context);
      await advance(
        runtime,
        { ...current, errors },
        `failed, try ${errors} of ${MAX_PHASE_ERRORS}: ${message}`,
        context,
      );
    }
  }

  /** Sends the pipeline to the sandbox setup when the sandbox is not ready. Returns true when the phase can go on. */
  async function sandboxReady(task: Running<WorkState>, runtime: Runtime, context: Context): Promise<boolean> {
    const sandboxId = (await runtime.snapshot(SandboxDoc, context))?.sandboxId;
    const state = await provisioner.state(sandboxId, runtime.signal);
    if (state === "ready") return true;
    const resume = { ...task.state.checkpoint, errors: 0 };
    const phase = state === "missing" ? PHASE.provision : PHASE.prepare;
    await advance(runtime, { phase, errors: 0, resume }, `the sandbox is ${state}; set it up again`, context);
    return false;
  }
  // endregion: failure handling

  // region: agents
  async function roleConversation(runtime: Runtime, role: Role, context: Context): Promise<ConversationId> {
    const known = (await runtime.snapshot(ProgressDoc, context))?.conversations[role];
    if (known !== undefined) return known as ConversationId;
    let conversationId: ConversationId | undefined;
    await runtime.commit(async (tx) => {
      const progress = await tx.doc(ProgressDoc);
      const existing = progress.conversations[role];
      if (existing !== undefined) {
        conversationId = existing as ConversationId;
        return undefined;
      }
      // The task owns the conversation, so an abort of the pipeline also stops the agent. A follow-up uses the
      // conversations of the earlier pipeline; the worker stops those agents itself (`#stopAgents`).
      const created = await tx.createConversation({ ownership: { kind: "task", taskId: runtime.taskId } });
      await configure(tx, created.id, { instructions: roleInstructions(role), cwd: REPO_PATH });
      progress.conversations[role] = created.id;
      conversationId = created.id;
      return undefined;
    }, context);
    if (conversationId === undefined) throw new Error(`Could not create the conversation of the ${role}`);
    return conversationId;
  }

  type Answer = { ok: true; entry: EntryId } | { ok: false; reason: string };

  async function ask(
    runtime: Runtime,
    role: Role,
    prompt: string,
    requestId: string,
    context: Context,
  ): Promise<Answer> {
    const conversationId = await roleConversation(runtime, role, context);
    const conversation = await runtime.conversation(conversationId, context);
    if (conversation === undefined) throw new Error(`The conversation of the ${role} is gone`);
    const submission = await conversation.submit({ type: "input", content: prompt, requestId }, context);
    const settled = await submission.wait(context);
    if (settled.status === "done" && settled.type === "input") return { ok: true, entry: settled.answer };
    const detail = settled.status === "unanswered" ? `${settled.reason}` : settled.status;
    return { ok: false, reason: detail };
  }

  async function readAnswer(runtime: Runtime, entry: EntryId, context: Context): Promise<string> {
    let text = "";
    await runtime.commit(async (tx) => {
      text = answerText((await tx.entry(AssistantEntry, entry))?.model?.[0] as AssistantMessage | undefined);
      return undefined;
    }, context);
    return text;
  }

  /**
   * The id of the prompt of a checkpoint. The task id is a part of it: a second pipeline of the same feature, after
   * a failed one, uses the same conversations and must not get the settled submissions of the first one.
   */
  function requestId(runtime: Runtime, state: WorkState): string {
    return `${runtime.taskId}:${state.phase}:${state.round}:${state.attempt}`;
  }

  /**
   * One agent turn of a phase. `decide` gets the answer and returns the next checkpoint. A failed answer makes a new
   * submission, and too many of them end the pipeline.
   */
  async function agentPhase(
    task: Running<WorkState>,
    runtime: Runtime,
    context: Context,
    role: Role,
    prompt: string,
    decide: (answer: string) => Promise<{ next: PipelineState; message: string }>,
  ): Promise<void> {
    await guarded(task, runtime, context, async () => {
      if (!(await sandboxReady(task, runtime, context))) return;
      const state = task.state.checkpoint;
      const answer = await ask(runtime, role, prompt, requestId(runtime, state), context);
      if (!answer.ok) {
        const attempt = state.attempt + 1;
        if (attempt >= MAX_SUBMISSION_ATTEMPTS) {
          await runtime.commit(async (tx) => {
            await record(tx, runtime.now(), state, state.phase, `the ${role} gave no answer: ${answer.reason}`);
            return failed(`The ${role} gave no answer in ${state.phase} (${answer.reason})`);
          }, context);
          return;
        }
        const message = `the ${role} gave no answer (${answer.reason}); ask again`;
        await advance(runtime, { ...state, attempt, errors: 0 }, message, context);
        return;
      }
      const { next, message } = await decide(await readAnswer(runtime, answer.entry, context));
      await advance(runtime, next, message, context);
    });
  }

  /** The verdict of a tester or reviewer answer. An answer without a verdict line gets one more request. */
  async function verdictOf(
    runtime: Runtime,
    role: Role,
    state: WorkState,
    answer: string,
    context: Context,
  ): Promise<{ passed: boolean; findings: string }> {
    let verdict = parseVerdict(answer);
    if (verdict === undefined) {
      const reminder = await ask(
        runtime,
        role,
        verdictReminder(),
        `${requestId(runtime, state)}${VERDICT_REQUEST_SUFFIX}`,
        context,
      );
      if (reminder.ok) verdict = parseVerdict(await readAnswer(runtime, reminder.entry, context));
    }
    return { passed: verdict === VERDICT.pass, findings: clip(answer, MAX_FEEDBACK_CHARS) };
  }

  /** After a rejected round: one more round for the implementer, or the end when the rounds are used up. */
  function afterRejection(
    input: PipelineInput,
    state: WorkState,
    by: Role,
    findings: string,
  ): { next: PipelineState; message: string } {
    // A follow-up continues the round numbers of the earlier pipeline, and it gets its own rounds.
    const lastRound = (input.followUp?.firstRound ?? FIRST_ROUND) + maxRounds - 1;
    if (state.round >= lastRound) {
      const note = `The ${by} rejected round ${state.round}, and ${maxRounds} rounds is the limit.`;
      return {
        next: work(PHASE.finalize, { round: state.round, verdict: PIPELINE_VERDICT.needsAttention, note }),
        message: note,
      };
    }
    return {
      next: work(PHASE.implement, { round: state.round + 1, feedback: findings }),
      message: `the ${by} rejected round ${state.round}; start round ${state.round + 1}`,
    };
  }
  // endregion: agents

  return defineTask<PipelineInput, PipelineState, PipelineResult>({
    name: PIPELINE_TASK_NAME,
    version: PIPELINE_TASK_VERSION,
    // A follow-up starts at `implement`. That phase sets the sandbox up again only when the sandbox is not ready.
    initial: (input) =>
      input.followUp === undefined
        ? { phase: PHASE.provision, errors: 0, resume: work(PHASE.research) }
        : work(PHASE.implement, { round: input.followUp.firstRound }),
    phases: {
      provision: (task, runtime, context) =>
        guarded(task, runtime, context, async () => {
          const known = (await runtime.snapshot(SandboxDoc, context))?.sandboxId;
          const { sandbox, created } = await provisioner.ensureSandbox(task.input.spec, known, runtime.signal);
          const { resume } = task.state.checkpoint;
          await runtime.commit(async (tx, current) => {
            const doc = await tx.doc(SandboxDoc);
            if (doc.sandboxId !== sandbox.id) {
              doc.sandboxId = sandbox.id;
              doc.createdAt = runtime.now();
              doc.generation += 1;
            }
            const next: PipelineState = { phase: PHASE.prepare, errors: 0, resume };
            const message = `${created ? "created" : "found"} sandbox ${sandbox.id}`;
            await record(tx, runtime.now(), next, current.state.checkpoint.phase, message);
            return running(next);
          }, context);
        }),

      prepare: (task, runtime, context) =>
        guarded(task, runtime, context, async () => {
          const sandboxId = (await runtime.snapshot(SandboxDoc, context))?.sandboxId;
          const { resume } = task.state.checkpoint;
          if (sandboxId === undefined) {
            await advance(runtime, { phase: PHASE.provision, errors: 0, resume }, "no sandbox is recorded", context);
            return;
          }
          const steps: string[] = [];
          await provisioner.prepare(sandboxId, task.input.spec, context, (line) => steps.push(line));
          // A setup that another caller started gives no lines here.
          const detail = steps.length === 0 ? "" : `: ${steps.join("; ")}`;
          await advance(runtime, resume, `the sandbox is ready${detail}`, context);
        }),

      research: (task, runtime, context) =>
        agentPhase(task, runtime, context, ROLE.researcher, researchPrompt(task.input.spec), async () => ({
          next: work(PHASE.design),
          message: "the research is written",
        })),

      design: (task, runtime, context) =>
        agentPhase(task, runtime, context, ROLE.architect, designPrompt(task.input.spec), async () => ({
          next: work(PHASE.implement),
          message: "the requirements and the decision record are written",
        })),

      implement: (task, runtime, context) => {
        const { round, feedback } = task.state.checkpoint;
        const prompt = implementPrompt(task.input.spec, round, feedback, task.input.followUp?.request);
        return agentPhase(task, runtime, context, ROLE.implementer, prompt, async () => ({
          next: work(PHASE.test, { round }),
          message: `round ${round} is implemented`,
        }));
      },

      test: (task, runtime, context) => {
        const state = task.state.checkpoint;
        const prompt = testPrompt(task.input.spec, state.round, task.input.followUp?.request);
        return agentPhase(task, runtime, context, ROLE.tester, prompt, async (answer) => {
          const { passed, findings } = await verdictOf(runtime, ROLE.tester, state, answer, context);
          if (!passed) return afterRejection(task.input, state, ROLE.tester, findings);
          return { next: work(PHASE.review, { round: state.round }), message: `round ${state.round} passed the tests` };
        });
      },

      review: (task, runtime, context) => {
        const state = task.state.checkpoint;
        const prompt = reviewPrompt(task.input.spec, state.round, task.input.followUp?.request);
        return agentPhase(task, runtime, context, ROLE.reviewer, prompt, async (answer) => {
          const { passed, findings } = await verdictOf(runtime, ROLE.reviewer, state, answer, context);
          if (!passed) return afterRejection(task.input, state, ROLE.reviewer, findings);
          const note = `Round ${state.round} passed the tests and the review.`;
          return { next: work(PHASE.finalize, { round: state.round, note }), message: note };
        });
      },

      finalize: (task, runtime, context) =>
        guarded(task, runtime, context, async () => {
          if (!(await sandboxReady(task, runtime, context))) return;
          const { spec } = task.input;
          const state = task.state.checkpoint;
          const sandboxId = (await runtime.snapshot(SandboxDoc, context))?.sandboxId;
          if (sandboxId === undefined) throw new Error("No sandbox is recorded");

          // The documents and the patch go into the durable state, so the result outlives the sandbox.
          // A read that fails for another reason than a missing folder is a throw: the phase then runs again, and
          // the result never lacks a document only because one request failed.
          const env = provisioner.openEnv(sandboxId, spec);
          const files: Record<string, string> = {};
          const skipped: string[] = [];
          let budget = MAX_ARTIFACT_FILES_BYTES;
          const listing = await env.listDir(docsDirectory(spec.name), context);
          if (!listing.ok && listing.error.code !== "not_found") throw listing.error;
          const entries = listing.ok ? [...listing.value].sort((a, b) => a.name.localeCompare(b.name)) : [];
          for (const entry of entries) {
            if (entry.kind !== "file") continue;
            const content = await env.readTextFile(entry.path, context);
            if (!content.ok) throw content.error;
            const text = clipToBytes(content.value, Math.min(MAX_ARTIFACT_FILE_BYTES, budget));
            if (budget <= 0 || text === "") {
              skipped.push(entry.name);
              continue;
            }
            budget -= byteLength(text);
            files[`${docsDirectory(spec.name)}/${entry.name}`] = text;
          }
          const change = await provisioner.collectChange(sandboxId, spec, context);

          const result: PipelineResult = { verdict: state.verdict, rounds: state.round, note: state.note };
          await runtime.commit(async (tx) => {
            const artifacts = await tx.doc(ArtifactsDoc);
            artifacts.files = files;
            artifacts.patch = clipToBytes(change.patch, MAX_PATCH_BYTES);
            artifacts.status = clipToBytes(change.status, MAX_ARTIFACT_FILE_BYTES);
            artifacts.collectedAt = runtime.now();
            const left = skipped.length === 0 ? "" : `, not stored: ${skipped.join(", ")}`;
            const message = `finished: ${result.verdict}, ${Object.keys(files).length} documents${left}`;
            await record(tx, runtime.now(), state, state.phase, message);
            return { status: "terminal", outcome: { status: "completed", result } };
          }, context);
        }),
    },
    abort: async (_task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "aborted" } }), context);
    },
  });
}

export type PipelineTask = ReturnType<typeof createPipelineTask>;

/** The task definition comes with an extension, so a task that waits in storage runs again after a restart. */
export function pipelineExtension(task: PipelineTask) {
  return defineExtension({ name: PIPELINE_EXTENSION_NAME, tasks: [task] });
}
