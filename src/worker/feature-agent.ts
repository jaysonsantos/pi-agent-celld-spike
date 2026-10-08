// One Durable Object for each feature. The object holds the Pi Durable Harness of that feature on its own SQLite
// database, which celld replicates to the bucket. So each feature has its own persistence, and a new pod gets the
// state back when the object starts again.
import { DurableObject, type DurableObjectState } from "cloudflare:workers";
import type { Context } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Message } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type Conversation,
  type ConversationId,
  configure,
  createRegistry,
  type EntryId,
  type EntryRecord,
  Harness,
  LiveDoc,
  ROOT_CONVERSATION_ID,
  type TaskId,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { type ChatItem, type ChatLive, chatItems, liveView } from "./chat.ts";
import { readConfig, type WorkerConfig, type WorkerEnv } from "./config.ts";
import {
  CONTENT_TYPE,
  FEATURE_ACTION,
  FEATURE_NAME_PATTERN,
  FEATURES_SEGMENT,
  GATEWAY_PREFIX,
  HEADER,
  HEARTBEAT_INTERVAL_MS,
  HTTP_METHOD,
  HTTP_STATUS,
  MS_PER_SECOND,
  QUERY,
} from "./constants.ts";
import { type FeatureSummary, putFeatureSummary } from "./feature-index.ts";
import { createModelRuntime } from "./models.ts";
import {
  ArtifactsDoc,
  FeatureDoc,
  type FeatureSpec,
  type FeatureState,
  ProgressDoc,
  type ProgressEvent,
  pushEvent,
  SandboxDoc,
  USER_EVENT_PHASE,
} from "./pipeline/docs.ts";
import { ROLE, ROLES, type Role, userMessagePrompt } from "./pipeline/roles.ts";
import {
  createPipelineTask,
  type FollowUp,
  PHASE,
  type PipelineInput,
  type PipelineResult,
  type PipelineState,
  type PipelineTask,
  pipelineExtension,
} from "./pipeline/task.ts";
import { SandboxClient } from "./sandbox/client.ts";
import { SandboxProvisioner } from "./sandbox/provision.ts";
import { openDurableObjectSqliteStorage } from "./storage/durable-object-sqlite.ts";
import { SandboxTools } from "./tools/durable-bash.ts";

// region: constants
/** Each commit is one write to the bucket, so running output is committed less often than the default. */
const PROGRESS_COMMIT_INTERVAL_MS = 3 * MS_PER_SECOND;
const MODEL_STREAM_TIMEOUT_MS = 10 * 60 * MS_PER_SECOND;
const MODEL_MAX_RETRIES = 5;
const DEFAULT_TRANSCRIPT_LIMIT = 40;
const MAX_TRANSCRIPT_LIMIT = 500;
const TRANSCRIPT_PART_MAX_CHARS = 4000;
const CELL_CLASS_NAME = "FeatureAgent";
/** How long `DELETE` waits for the agents to stop before it removes the sandbox. */
const STOP_WAIT_MS = 30 * MS_PER_SECOND;
const START = { started: "started", exists: "exists", conflict: "conflict" } as const;
type StartDecision = (typeof START)[keyof typeof START];
/** How long a passed sandbox check counts for the next tool calls. */
const SANDBOX_CHECK_VALID_MS = 5 * MS_PER_SECOND;
/** `GET /features/<name>/artifacts/patch` gives the diff of the feature branch. */
const PATCH_ARTIFACT = "patch";
const THINKING_OFF = "off";
const DEFAULT_CHAT_LIMIT = 150;
const MAX_CHAT_LIMIT = 300;
const MAX_MESSAGE_CHARS = 8000;
const SUMMARY_TASK_CHARS = 240;
/** `agent`: the message goes to one agent. `round`: the message starts a new round of the pipeline. */
const MESSAGE_MODE = { agent: "agent", round: "round" } as const;
type MessageMode = (typeof MESSAGE_MODE)[keyof typeof MESSAGE_MODE];
/** What the worker did with a message: the agent reads it during its work, or answers it, or a new round started. */
const DELIVERY = { steer: "steer", ask: "ask", round: "round" } as const;
const ROUND_START = { started: "started", running: "running", missing: "missing" } as const;
type RoundStart = (typeof ROUND_START)[keyof typeof ROUND_START];
/** The agent that works in each phase of the pipeline. */
const PHASE_ROLE: Partial<Record<string, Role>> = {
  [PHASE.research]: ROLE.researcher,
  [PHASE.design]: ROLE.architect,
  [PHASE.implement]: ROLE.implementer,
  [PHASE.test]: ROLE.tester,
  [PHASE.review]: ROLE.reviewer,
};
const FEATURE_STATE = { fresh: "new", running: "running", blocked: "blocked", ended: "ended" } as const;
// endregion: constants

// region: response shapes
interface ErrorResponse {
  error: string;
}

interface PipelineStatus {
  taskId: number;
  /** `pending`, `running`, `waiting`, `completing`, or `terminal`. */
  status: string;
  phase: string | null;
  round: number | null;
  outcome: string | null;
  result: PipelineResult | null;
  error: string | null;
}

interface ConversationStatus {
  id: number;
  busy: boolean;
  runningTools: string[];
}

interface FeatureStatusResponse {
  feature: string;
  exists: boolean;
  spec: FeatureSpec | null;
  createdAt: string | null;
  pipeline: PipelineStatus | null;
  conversations: Partial<Record<Role, ConversationStatus>>;
  events: ProgressEvent[];
  sandbox: { id: string | null; generation: number };
  usage: unknown;
  /** The model of this deployment. */
  model: { provider: string; modelId: string };
  /** The model that the pipeline of the feature started with. */
  featureModel: { provider: string; modelId: string } | null;
  /** Why the pipeline does not continue, or `null` when nothing stops it. */
  blocked: string | null;
  /** Where celld keeps this feature: the cell, and the prefix of its objects in the bucket. */
  persistence: { cell: string; objectPrefix: string; bootedAt: string };
}

interface ArtifactsResponse {
  collectedAt: string | null;
  status: string;
  files: string[];
  patchBytes: number;
}

interface ChatResponse {
  role: Role;
  /** `null` when the agent of that role did not start yet. */
  conversationId: number | null;
  /** Oldest first. */
  items: ChatItem[];
  /** True when the conversation has entries before the first item, or more new entries than one answer holds. */
  more: boolean;
  live: ChatLive;
}

/** The body of `POST /features/<name>/messages`. */
interface MessageRequest {
  content: string;
  role?: Role;
  mode?: MessageMode;
}

interface MessageResponse {
  delivery: (typeof DELIVERY)[keyof typeof DELIVERY];
  role: Role | null;
  status: FeatureStatusResponse;
}

/** The body of `PUT /features/<name>`. */
interface FeatureRequest {
  repo: string;
  ref?: string;
  task: string;
  rootSetup?: string;
  userSetup?: string;
  env?: Record<string, string>;
}
// endregion: response shapes

function json(body: unknown, status: number = HTTP_STATUS.ok): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { [HEADER.contentType]: CONTENT_TYPE.json },
  });
}

function text(body: string, status: number = HTTP_STATUS.ok): Response {
  return new Response(body, { status, headers: { [HEADER.contentType]: CONTENT_TYPE.text } });
}

function failure(message: string, status: number): Response {
  return json({ error: message } satisfies ErrorResponse, status);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value).every((entry) => typeof entry === "string");
}

function parseFeatureRequest(name: string, body: unknown): FeatureSpec | string {
  if (typeof body !== "object" || body === null) return "the body must be a JSON object";
  const request = body as Partial<Record<keyof FeatureRequest, unknown>>;
  if (typeof request.repo !== "string" || request.repo === "") return "repo must be a Git URL";
  if (typeof request.task !== "string" || request.task.trim() === "") return "task must describe the feature";
  for (const key of ["ref", "rootSetup", "userSetup"] as const) {
    if (request[key] !== undefined && typeof request[key] !== "string") return `${key} must be a string`;
  }
  if (request.env !== undefined && !isStringRecord(request.env)) return "env must be an object of strings";
  return {
    name,
    repo: request.repo,
    ref: (request.ref as string | undefined) ?? "",
    task: request.task,
    rootSetup: (request.rootSetup as string | undefined) ?? "",
    userSetup: (request.userSetup as string | undefined) ?? "",
    env: (request.env as Record<string, string> | undefined) ?? {},
  };
}

function sameSpec(a: FeatureSpec, b: FeatureSpec): boolean {
  return JSON.stringify([a.repo, a.ref, a.task]) === JSON.stringify([b.repo, b.ref, b.task]);
}

function parseMessageRequest(body: unknown): MessageRequest | string {
  if (typeof body !== "object" || body === null) return "the body must be a JSON object";
  const request = body as Partial<Record<keyof MessageRequest, unknown>>;
  const content = typeof request.content === "string" ? request.content.trim() : "";
  if (content === "") return "content must be the text of the message";
  if (content.length > MAX_MESSAGE_CHARS) return `content must have ${MAX_MESSAGE_CHARS} characters or less`;
  if (request.role !== undefined && !(ROLES as readonly unknown[]).includes(request.role)) {
    return `role must be one of: ${ROLES.join(", ")}`;
  }
  const modes: readonly unknown[] = Object.values(MESSAGE_MODE);
  if (request.mode !== undefined && !modes.includes(request.mode)) {
    return `mode must be one of: ${modes.join(", ")}`;
  }
  return {
    content,
    ...(request.role === undefined ? {} : { role: request.role as Role }),
    ...(request.mode === undefined ? {} : { mode: request.mode as MessageMode }),
  };
}

function entryIdParam(url: URL, name: string): number | undefined {
  const value = Number(url.searchParams.get(name) ?? Number.NaN);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** True while the feature has work that a new pod must continue: a pipeline, or an agent that answers the user. */
function hasWork(status: FeatureStatusResponse): boolean {
  const pipelineRuns = status.pipeline !== null && status.pipeline.status !== "terminal";
  return pipelineRuns || Object.values(status.conversations).some((conversation) => conversation.busy);
}

/** The line of a feature in the list of the page, or `undefined` for an object without a feature. */
function summarize(status: FeatureStatusResponse): FeatureSummary | undefined {
  const { spec, pipeline } = status;
  if (spec === null) return undefined;
  let state: string = FEATURE_STATE.fresh;
  if (status.blocked !== null) state = FEATURE_STATE.blocked;
  else if (pipeline !== null && pipeline.status !== "terminal") state = FEATURE_STATE.running;
  else if (pipeline !== null) state = pipeline.result?.verdict ?? pipeline.outcome ?? FEATURE_STATE.ended;
  const model = status.featureModel ?? status.model;
  return {
    name: spec.name,
    repo: spec.repo,
    task: spec.task.trim().slice(0, SUMMARY_TASK_CHARS),
    state,
    phase: pipeline?.phase ?? "",
    round: pipeline?.round ?? 0,
    busy: ROLES.filter((role) => status.conversations[role]?.busy === true),
    model: `${model.provider}/${model.modelId}`,
    createdAt: status.createdAt === null ? null : Date.parse(status.createdAt),
  };
}

function clip(value: string): string {
  if (value.length <= TRANSCRIPT_PART_MAX_CHARS) return value;
  return `${value.slice(0, TRANSCRIPT_PART_MAX_CHARS)}\n[... ${value.length - TRANSCRIPT_PART_MAX_CHARS} more characters]`;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) => {
      if (typeof part !== "object" || part === null) return "";
      if ("text" in part && typeof part.text === "string") return part.text;
      if ("type" in part && part.type === "toolCall" && "name" in part && "arguments" in part) {
        return `[tool call ${String(part.name)} ${JSON.stringify(part.arguments)}]`;
      }
      return "";
    })
    .filter((part) => part !== "")
    .join("\n");
}

function renderEntry(entry: EntryRecord): string {
  const lines = [`--- entry ${entry.id} ${entry.kind}`];
  for (const message of (entry.model ?? []) as Message[]) {
    const error = message.role === "toolResult" && message.isError ? " (error)" : "";
    lines.push(`[${message.role}${error}] ${clip(contentText(message.content))}`);
  }
  return lines.join("\n");
}

/** The open Harness of the feature and the parts around it. */
interface FeatureRuntime {
  config: WorkerConfig;
  harness: Harness;
  root: Conversation;
  provisioner: SandboxProvisioner;
  pipeline: PipelineTask;
  /** The model of this deployment, and the agent choice that a new pipeline gets. */
  model: { provider: string; modelId: string };
  agent: AgentChange;
}

export class FeatureAgent extends DurableObject<WorkerEnv> {
  #runtime: Promise<FeatureRuntime> | undefined;
  #sandboxChecked: { id: string; at: number } | undefined;
  #sandboxRepair: Promise<string> | undefined;
  /** The summary that the list of the features has from this object, as JSON text. */
  #published: string | undefined;
  readonly #bootedAt = Date.now();

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
  }

  // region: harness lifecycle
  /** Opens the Harness one time for each start of the object, and continues the work that the last process left. */
  #open(): Promise<FeatureRuntime> {
    this.#runtime ??= this.#openHarness().catch((error: unknown) => {
      this.#runtime = undefined;
      throw error;
    });
    return this.#runtime;
  }

  async #openHarness(): Promise<FeatureRuntime> {
    const context = BACKGROUND_CONTEXT;
    const config = readConfig(this.env);
    const sandboxes = new SandboxClient(`${config.gatewayUrl}${GATEWAY_PREFIX.sandbox}`);
    const provisioner = new SandboxProvisioner({ sandboxes, config: config.sandbox });
    const pipeline = createPipelineTask({ provisioner, maxRounds: config.pipelineMaxRounds });
    const { models, model } = createModelRuntime(config);

    const registry = createRegistry();
    registry.install(CodingTools);
    registry.install(SandboxTools);
    registry.install(pipelineExtension(pipeline));

    // The environment function runs only after the Harness is open, so it can use the Harness for a commit.
    let opened: Harness | undefined;
    const recordSandbox = async (sandboxId: string): Promise<void> => {
      await opened?.commit(async (tx) => {
        const doc = await tx.doc(SandboxDoc);
        if (doc.sandboxId === sandboxId) return;
        doc.sandboxId = sandboxId;
        doc.createdAt = Date.now();
        doc.generation += 1;
      }, context);
    };

    const storage = await openDurableObjectSqliteStorage(this.ctx.storage);
    const harness = await Harness.open(
      storage,
      {
        models,
        registry,
        settings: {
          progress: {
            partialIntervalMs: PROGRESS_COMMIT_INTERVAL_MS,
            outputIntervalMs: PROGRESS_COMMIT_INTERVAL_MS,
          },
          stream: { timeoutMs: MODEL_STREAM_TIMEOUT_MS },
          retry: { maxRetries: MODEL_MAX_RETRIES },
        },
        // The sandbox of the feature, as the user that the agents work as. No feature yet: the tools fail cleanly.
        // While the pipeline runs, a missing sandbox is made again here.
        env: async ({ cwd, read }, envContext) => {
          const feature = await read.snapshot(FeatureDoc, envContext);
          const spec = feature?.spec;
          if (spec === undefined || feature?.pipelineTaskId === undefined) return undefined;
          const task = await opened?.getTask(feature.pipelineTaskId as TaskId, envContext);
          if (task === undefined) return undefined;
          const known = (await read.snapshot(SandboxDoc, envContext))?.sandboxId;
          if (task.state.status === "terminal") {
            // After the end of the pipeline, an agent that answers the user gets the sandbox only as it is. Nothing
            // makes or repairs a sandbox here, so a tool call that is still on its way after a stop makes no new one.
            if (known === undefined || !(await this.#sandboxIsReady(provisioner, known, envContext))) return undefined;
            return provisioner.openEnv(known, spec, cwd);
          }
          const sandboxId = await this.#usableSandbox(provisioner, spec, known, (id) => recordSandbox(id));
          return provisioner.openEnv(sandboxId, spec, cwd);
        },
        onReport: (error) => console.error("harness report:", error),
      },
      context,
    );

    opened = harness;

    const agent = { model, thinkingLevel: config.llm.reasoning ? config.llm.thinkingLevel : THINKING_OFF } as const;
    const root = await harness.root(context, { agent });
    // A feature from before the model was recorded: its agents have the model that was deployed at that time.
    const feature = await harness.snapshot(FeatureDoc, context);
    const stored =
      feature?.spec !== undefined && feature.model === undefined ? (await root.agent(context)).model : undefined;
    if (stored !== undefined) {
      await harness.commit(async (tx) => {
        (await tx.doc(FeatureDoc)).model ??= { provider: stored.provider, modelId: stored.modelId };
      }, context);
    }
    const runtime: FeatureRuntime = { config, harness, root, provisioner, pipeline, model, agent };
    // Without this call the Harness schedules nothing, so a pipeline with a different model stays where it is.
    if ((await this.#modelConflict(runtime)) === undefined) harness.resume();
    return runtime;
  }

  /**
   * A text when a pipeline is live and this deployment has a different model than the one it started with. A
   * feature keeps its model: an upgrade that changes the model, for example back to the scripted test model, must
   * not take over the work.
   */
  async #modelConflict(runtime: FeatureRuntime): Promise<string | undefined> {
    const feature = await runtime.harness.snapshot(FeatureDoc, BACKGROUND_CONTEXT);
    const started = feature?.model;
    if (started === undefined || !(await this.#isActive(runtime))) return undefined;
    const deployed = runtime.model;
    if (started.provider === deployed.provider && started.modelId === deployed.modelId) return undefined;
    return (
      `The pipeline started with ${started.provider}/${started.modelId}, and this deployment has ` +
      `${deployed.provider}/${deployed.modelId}. The pipeline waits until the deployment has its model again.`
    );
  }

  /**
   * The id of a sandbox that is ready for a command. A check that passed stays valid for a short time, and calls
   * that arrive during a repair share that repair.
   */
  #usableSandbox(
    provisioner: SandboxProvisioner,
    spec: FeatureSpec,
    known: string | undefined,
    record: (sandboxId: string) => Promise<void>,
  ): Promise<string> {
    const checked = this.#sandboxChecked;
    if (checked !== undefined && checked.id === known && Date.now() - checked.at < SANDBOX_CHECK_VALID_MS) {
      return Promise.resolve(checked.id);
    }
    this.#sandboxRepair ??= provisioner
      .ensureReady(spec, known, BACKGROUND_CONTEXT, record)
      .then((id) => {
        this.#sandboxChecked = { id, at: Date.now() };
        return id;
      })
      .finally(() => {
        this.#sandboxRepair = undefined;
      });
    return this.#sandboxRepair;
  }

  /** True when the recorded sandbox can run a command now. A check that passed stays valid for a short time. */
  async #sandboxIsReady(provisioner: SandboxProvisioner, sandboxId: string, context: Context): Promise<boolean> {
    const checked = this.#sandboxChecked;
    if (checked !== undefined && checked.id === sandboxId && Date.now() - checked.at < SANDBOX_CHECK_VALID_MS) {
      return true;
    }
    const signal = context.abortSignal ?? new AbortController().signal;
    if ((await provisioner.state(sandboxId, signal)) !== "ready") return false;
    this.#sandboxChecked = { id: sandboxId, at: Date.now() };
    return true;
  }

  async #pipelineRecord(runtime: FeatureRuntime, feature: FeatureState | undefined) {
    if (feature?.pipelineTaskId === undefined) return undefined;
    const taskId = feature.pipelineTaskId as TaskId<PipelineResult>;
    return runtime.harness.getTask(taskId, BACKGROUND_CONTEXT);
  }

  /** True while the pipeline of the feature is not at its end. */
  async #isActive(runtime: FeatureRuntime): Promise<boolean> {
    const feature = await runtime.harness.snapshot(FeatureDoc, BACKGROUND_CONTEXT);
    const record = await this.#pipelineRecord(runtime, feature);
    return record !== undefined && record.state.status !== "terminal";
  }

  /**
   * The heartbeat. celld keeps an alarm in the bucket and fires it on a new node after a pod loss. That event starts
   * this object again, `#open()` resumes the Harness, and the pipeline continues at its last checkpoint.
   */
  override async alarm(): Promise<void> {
    try {
      const runtime = await this.#open();
      // A commit that storage refused after admission leaves the Session unusable until it opens again. An empty
      // commit shows that state.
      await runtime.harness.commit(() => undefined, BACKGROUND_CONTEXT);
      const conflict = await this.#modelConflict(runtime);
      if (conflict === undefined) runtime.harness.resume();
      else console.warn(conflict);
      const name = (await runtime.harness.snapshot(FeatureDoc, BACKGROUND_CONTEXT))?.spec?.name;
      if (name === undefined) return;
      const status = await this.#status(runtime, name);
      await this.#publish(status);
      if (hasWork(status)) await this.#armHeartbeat();
    } catch (error) {
      console.error("heartbeat failed; the Harness opens again at the next alarm:", error);
      const broken = this.#runtime;
      this.#runtime = undefined;
      void broken?.then((runtime) => runtime.harness.close(BACKGROUND_CONTEXT)).catch(() => {});
      await this.#armHeartbeat();
    }
  }

  async #armHeartbeat(): Promise<void> {
    await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  /**
   * Sends the summary of the feature to the list of the features when a value of it changed. The list is a copy for
   * the page, so a failure here must not stop the work of the feature.
   */
  async #publish(status: FeatureStatusResponse): Promise<void> {
    const summary = summarize(status);
    if (summary === undefined) return;
    const body = JSON.stringify(summary);
    if (body === this.#published) return;
    try {
      const response = await putFeatureSummary(this.env.INDEX, summary);
      if (response.ok) this.#published = body;
      else console.warn(`the list of the features refused the summary: HTTP ${response.status}`);
    } catch (error) {
      console.warn("the list of the features did not get the summary:", error);
    }
  }

  /** The status for a response. The list of the features gets the same values. */
  async #report(runtime: FeatureRuntime, name: string): Promise<FeatureStatusResponse> {
    const status = await this.#status(runtime, name);
    await this.#publish(status);
    return status;
  }
  // endregion: harness lifecycle

  // region: http
  override async fetch(request: Request): Promise<Response> {
    try {
      return await this.#route(request);
    } catch (error) {
      console.error("request failed:", error);
      return failure(error instanceof Error ? error.message : String(error), HTTP_STATUS.internalError);
    }
  }

  async #route(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const [segment, name, action, ...rest] = url.pathname.split("/").filter((part) => part !== "");
    if (segment !== FEATURES_SEGMENT || name === undefined || !FEATURE_NAME_PATTERN.test(name)) {
      return failure("not a feature path", HTTP_STATUS.notFound);
    }
    const runtime = await this.#open();
    const { method } = request;

    if (action === undefined) {
      if (method === HTTP_METHOD.get) return json(await this.#report(runtime, name));
      if (method === HTTP_METHOD.put) return this.#start(runtime, name, request);
      if (method === HTTP_METHOD.delete) return this.#delete(runtime, name);
      return failure("use GET, PUT, or DELETE", HTTP_STATUS.methodNotAllowed);
    }
    if (action === FEATURE_ACTION.abort && method === HTTP_METHOD.post) return this.#abort(runtime, name);
    if (action === FEATURE_ACTION.messages && method === HTTP_METHOD.post) {
      return this.#message(runtime, name, request);
    }
    if (method !== HTTP_METHOD.get) return failure("use GET", HTTP_STATUS.methodNotAllowed);
    if (action === FEATURE_ACTION.chat) return this.#chat(runtime, url);
    if (action === FEATURE_ACTION.transcript) return this.#transcript(runtime, url);
    if (action === FEATURE_ACTION.artifacts) return this.#artifacts(runtime, rest.join("/"));
    if (action === FEATURE_ACTION.tasks) return json(await runtime.harness.inspect(BACKGROUND_CONTEXT));
    return failure(`unknown action ${action}`, HTTP_STATUS.notFound);
  }

  /** Starts the pipeline of the feature. The same request again changes nothing and gets the status. */
  async #start(runtime: FeatureRuntime, name: string, request: Request): Promise<Response> {
    const parsed = parseFeatureRequest(name, await request.json().catch(() => undefined));
    if (typeof parsed === "string") return failure(parsed, HTTP_STATUS.badRequest);

    // The check and the start are one commit, so two requests at the same moment start one pipeline.
    const input: PipelineInput = { spec: parsed };
    const decision = await runtime.root.commit(async (tx): Promise<StartDecision> => {
      const feature = await tx.doc(FeatureDoc);
      if (feature.spec !== undefined && !sameSpec(feature.spec, parsed)) return START.conflict;
      if (feature.pipelineTaskId !== undefined) {
        const state = (await tx.task(feature.pipelineTaskId as TaskId))?.state;
        const outcome = state?.status === "terminal" ? state.outcome.status : undefined;
        // A pipeline that runs, or one that ended with a result, stays. One that failed or was stopped starts again.
        if (state !== undefined && (outcome === undefined || outcome === "completed")) return START.exists;
      }
      feature.spec = parsed;
      feature.createdAt ??= Date.now();
      // A new pipeline takes the model of this deployment and keeps it to its end.
      feature.model = { ...runtime.model };
      await configure(tx, ROOT_CONVERSATION_ID, runtime.agent);
      feature.pipelineTaskId = await tx.createTask(runtime.pipeline, input, { ownership: { kind: "conversation" } });
      // The earlier pipeline owns the earlier conversations, and a stop of the new pipeline would not reach them.
      (await tx.doc(ProgressDoc)).conversations = {};
      return START.started;
    }, BACKGROUND_CONTEXT);

    if (decision === START.conflict) {
      return failure(`feature ${name} exists with a different repo, ref, or task`, HTTP_STATUS.conflict);
    }
    if ((await this.#modelConflict(runtime)) === undefined) runtime.harness.resume();
    await this.#armHeartbeat();
    const status = decision === START.started ? HTTP_STATUS.accepted : HTTP_STATUS.ok;
    return json(await this.#report(runtime, name), status);
  }

  // region: messages of the user
  /**
   * A message of the user. While the pipeline runs, it goes to one agent: a busy agent reads it at its next step, and
   * an idle agent answers it. After the end of the pipeline, it starts a new round, or one agent answers it.
   */
  async #message(runtime: FeatureRuntime, name: string, request: Request): Promise<Response> {
    const parsed = parseMessageRequest(await request.json().catch(() => undefined));
    if (typeof parsed === "string") return failure(parsed, HTTP_STATUS.badRequest);
    const feature = await runtime.harness.snapshot(FeatureDoc, BACKGROUND_CONTEXT);
    if (feature?.spec === undefined || feature.pipelineTaskId === undefined) {
      return failure(`feature ${name} has no pipeline; start it with PUT /features/${name}`, HTTP_STATUS.notFound);
    }
    // An agent keeps the model that it started with, and only a deployment with that model can run it.
    const started = feature.model;
    const deployed = runtime.model;
    if (started !== undefined && (started.provider !== deployed.provider || started.modelId !== deployed.modelId)) {
      const error =
        `The agents of this feature have the model ${started.provider}/${started.modelId}, and this deployment has ` +
        `${deployed.provider}/${deployed.modelId}. Send the message when the deployment has that model again.`;
      return failure(error, HTTP_STATUS.conflict);
    }
    const active = await this.#isActive(runtime);
    const mode = parsed.mode ?? (active ? MESSAGE_MODE.agent : MESSAGE_MODE.round);
    if (mode === MESSAGE_MODE.agent) return this.#tell(runtime, name, parsed, active);
    if (active) {
      const error = "The pipeline runs, and a new round can start only after its end. Send the message to an agent.";
      return failure(error, HTTP_STATUS.conflict);
    }
    return this.#followUp(runtime, name, feature.spec, parsed.content);
  }

  /** Gives the message to one agent. A busy agent gets it after its current tool calls, in the same run. */
  async #tell(runtime: FeatureRuntime, name: string, message: MessageRequest, active: boolean): Promise<Response> {
    const context = BACKGROUND_CONTEXT;
    const { harness } = runtime;
    const progress = await harness.snapshot(ProgressDoc, context);
    const conversations = progress?.conversations ?? {};
    let busyRole: Role | undefined;
    for (const candidate of ROLES) {
      const id = conversations[candidate];
      if (id === undefined || busyRole !== undefined) continue;
      if ((await harness.snapshot(LiveDoc, id as ConversationId, context))?.run !== undefined) busyRole = candidate;
    }
    const role = message.role ?? busyRole ?? PHASE_ROLE[progress?.phase ?? ""] ?? ROLE.implementer;
    const id = conversations[role];
    const conversation = id === undefined ? undefined : await harness.conversation(id as ConversationId, context);
    if (conversation === undefined) {
      return failure(`The ${role} did not start yet, so it has no conversation.`, HTTP_STATUS.conflict);
    }
    const busy = (await harness.snapshot(LiveDoc, conversation.id, context))?.run !== undefined;
    const content = userMessagePrompt(message.content, active);
    await conversation.submit({ type: "input", content, whenBusy: "steer" }, context);
    await harness.commit(async (tx) => {
      const event = { at: Date.now(), phase: USER_EVENT_PHASE, message: `to the ${role}: ${message.content}` };
      pushEvent(await tx.doc(ProgressDoc), event);
    }, context);
    harness.resume();
    await this.#armHeartbeat();
    const delivery = busy ? DELIVERY.steer : DELIVERY.ask;
    const response: MessageResponse = { delivery, role, status: await this.#report(runtime, name) };
    return json(response, HTTP_STATUS.accepted);
  }

  /**
   * Starts a new round for a change that the user asks for: the implementer, then the tester and the reviewer. The
   * agents keep their conversations, so each one has the transcript of the earlier rounds.
   */
  async #followUp(runtime: FeatureRuntime, name: string, spec: FeatureSpec, request: string): Promise<Response> {
    // The check and the start are one commit, so two requests at the same moment start one round.
    const decision = await runtime.root.commit(async (tx): Promise<RoundStart> => {
      const feature = await tx.doc(FeatureDoc);
      if (feature.pipelineTaskId === undefined) return ROUND_START.missing;
      const state = (await tx.task(feature.pipelineTaskId as TaskId))?.state;
      if (state !== undefined && state.status !== "terminal") return ROUND_START.running;
      const progress = await tx.doc(ProgressDoc);
      const followUp: FollowUp = { request, firstRound: progress.round + 1 };
      const input: PipelineInput = { spec, followUp };
      feature.pipelineTaskId = await tx.createTask(runtime.pipeline, input, { ownership: { kind: "conversation" } });
      const message = `the user asks for a change, round ${followUp.firstRound}: ${request}`;
      pushEvent(progress, { at: Date.now(), phase: USER_EVENT_PHASE, message });
      return ROUND_START.started;
    }, BACKGROUND_CONTEXT);

    if (decision === ROUND_START.missing) return failure(`feature ${name} has no pipeline`, HTTP_STATUS.notFound);
    if (decision === ROUND_START.running) return failure("The pipeline runs already.", HTTP_STATUS.conflict);
    runtime.harness.resume();
    await this.#armHeartbeat();
    const response: MessageResponse = {
      delivery: DELIVERY.round,
      role: null,
      status: await this.#report(runtime, name),
    };
    return json(response, HTTP_STATUS.accepted);
  }

  /**
   * Stops each agent. A new round does not own the conversations that it uses, and an agent that answers the user
   * has no pipeline, so the stop of the pipeline task does not reach those agents.
   */
  async #stopAgents(runtime: FeatureRuntime): Promise<void> {
    const context = BACKGROUND_CONTEXT;
    const progress = await runtime.harness.snapshot(ProgressDoc, context);
    for (const id of Object.values(progress?.conversations ?? {})) {
      const conversation = await runtime.harness.conversation(id as ConversationId, context);
      // The call returns when the agent is idle. The request does not wait for that.
      void conversation?.abort(context).catch((error: unknown) => console.warn("an agent did not stop:", error));
    }
  }
  // endregion: messages of the user

  async #abort(runtime: FeatureRuntime, name: string): Promise<Response> {
    const feature = await runtime.harness.snapshot(FeatureDoc, BACKGROUND_CONTEXT);
    if (feature?.pipelineTaskId !== undefined) {
      await runtime.harness.abortTask(feature.pipelineTaskId as TaskId, BACKGROUND_CONTEXT);
    }
    await this.#stopAgents(runtime);
    return json(await this.#report(runtime, name));
  }

  /** Stops the pipeline and removes the sandbox. The transcripts and the artifacts stay in the object. */
  async #delete(runtime: FeatureRuntime, name: string): Promise<Response> {
    const context = BACKGROUND_CONTEXT;
    const feature = await runtime.harness.snapshot(FeatureDoc, context);
    if (feature?.pipelineTaskId !== undefined) {
      const taskId = feature.pipelineTaskId as TaskId;
      await runtime.harness.abortTask(taskId, context);
      await this.#stopAgents(runtime);
      // The agents stop before the sandbox goes. The wait has a limit, so a stuck tool cannot block the request.
      const stopped = runtime.harness.waitForTask(taskId, context).catch(() => undefined);
      await Promise.race([stopped, new Promise((resolve) => setTimeout(resolve, STOP_WAIT_MS))]);
    }
    const sandboxId = (await runtime.harness.snapshot(SandboxDoc, context))?.sandboxId;
    if (sandboxId !== undefined) {
      await runtime.provisioner.delete(sandboxId);
      await runtime.harness.commit(async (tx) => {
        delete (await tx.doc(SandboxDoc)).sandboxId;
      }, context);
    }
    await this.ctx.storage.deleteAlarm();
    return json(await this.#report(runtime, name));
  }

  async #status(runtime: FeatureRuntime, name: string): Promise<FeatureStatusResponse> {
    const context = BACKGROUND_CONTEXT;
    const { harness } = runtime;
    const feature = await harness.snapshot(FeatureDoc, context);
    const progress = await harness.snapshot(ProgressDoc, context);
    const sandbox = await harness.snapshot(SandboxDoc, context);
    const record = await this.#pipelineRecord(runtime, feature);

    let pipeline: PipelineStatus | null = null;
    if (record !== undefined && feature?.pipelineTaskId !== undefined) {
      const { state } = record;
      const outcome = state.status === "terminal" ? state.outcome : undefined;
      const checkpoint = state.status === "terminal" ? undefined : (state.checkpoint as PipelineState | undefined);
      pipeline = {
        taskId: feature.pipelineTaskId,
        status: state.status,
        phase: checkpoint?.phase ?? progress?.phase ?? null,
        round: progress?.round ?? null,
        outcome: outcome?.status ?? null,
        result: outcome?.status === "completed" ? outcome.result : null,
        error: outcome?.error?.message ?? outcome?.reason ?? null,
      };
    }

    const conversations: Partial<Record<Role, ConversationStatus>> = {};
    for (const role of ROLES) {
      const id = progress?.conversations[role];
      if (id === undefined) continue;
      const live = await harness.snapshot(LiveDoc, id as ConversationId, context);
      const runningTools = Object.values(live?.tools ?? {}).map((tool) => tool.name);
      conversations[role] = { id, busy: live?.run !== undefined, runningTools };
    }

    const cell = `${CELL_CLASS_NAME}:${this.ctx.id.toString()}`;
    const bucket = runtime.config.bucketUrl.replace(/\/+$/, "");
    return {
      feature: name,
      exists: feature?.spec !== undefined,
      spec: feature?.spec ?? null,
      createdAt: feature?.createdAt === undefined ? null : new Date(feature.createdAt).toISOString(),
      pipeline,
      conversations,
      events: progress?.events ?? [],
      sandbox: { id: sandbox?.sandboxId ?? null, generation: sandbox?.generation ?? 0 },
      usage: await harness.usage(context),
      model: runtime.model,
      featureModel: feature?.model ?? null,
      blocked: (await this.#modelConflict(runtime)) ?? null,
      persistence: {
        cell,
        objectPrefix: `${bucket}/cells/${cell}/`,
        bootedAt: new Date(this.#bootedAt).toISOString(),
      },
    };
  }

  /** The newest entries of the conversation of one role, oldest first, as plain text. */
  async #transcript(runtime: FeatureRuntime, url: URL): Promise<Response> {
    const context = BACKGROUND_CONTEXT;
    const role = url.searchParams.get(QUERY.role);
    const progress = await runtime.harness.snapshot(ProgressDoc, context);
    const known = Object.keys(progress?.conversations ?? {});
    const id = role === null ? undefined : progress?.conversations[role];
    if (id === undefined) {
      return failure(`give ?${QUERY.role}= one of: ${known.join(", ") || "(none yet)"}`, HTTP_STATUS.badRequest);
    }
    const requested = Number(url.searchParams.get(QUERY.limit) ?? DEFAULT_TRANSCRIPT_LIMIT);
    const limit =
      Number.isInteger(requested) && requested > 0
        ? Math.min(requested, MAX_TRANSCRIPT_LIMIT)
        : DEFAULT_TRANSCRIPT_LIMIT;
    const conversation = await runtime.harness.conversation(id as ConversationId, context);
    if (conversation === undefined) return failure(`conversation ${id} is gone`, HTTP_STATUS.notFound);
    const page = await conversation.entries({}, limit, undefined, context);
    return text(`${[...page.items].reverse().map(renderEntry).join("\n\n")}\n`);
  }

  /**
   * The conversation of one agent for the page: the newest entries, oldest first, and what the agent does now.
   * `after` gives only the entries that are new since the last read, and `before` gives an older part.
   */
  async #chat(runtime: FeatureRuntime, url: URL): Promise<Response> {
    const context = BACKGROUND_CONTEXT;
    const role = url.searchParams.get(QUERY.role) as Role | null;
    if (role === null || !ROLES.includes(role)) {
      return failure(`give ?${QUERY.role}= one of: ${ROLES.join(", ")}`, HTTP_STATUS.badRequest);
    }
    const id = (await runtime.harness.snapshot(ProgressDoc, context))?.conversations[role];
    const conversation =
      id === undefined ? undefined : await runtime.harness.conversation(id as ConversationId, context);
    if (conversation === undefined) {
      const empty: ChatResponse = { role, conversationId: null, items: [], more: false, live: liveView(undefined) };
      return json(empty);
    }
    const requested = Number(url.searchParams.get(QUERY.limit) ?? DEFAULT_CHAT_LIMIT);
    const limit =
      Number.isInteger(requested) && requested > 0 ? Math.min(requested, MAX_CHAT_LIMIT) : DEFAULT_CHAT_LIMIT;
    const after = entryIdParam(url, QUERY.after);
    const before = entryIdParam(url, QUERY.before);
    const query = {
      ...(after === undefined ? {} : { minEntryId: (after + 1) as EntryId }),
      ...(before === undefined ? {} : { maxEntryId: (before - 1) as EntryId }),
    };
    const page = await conversation.entries(query, limit, undefined, context);
    const response: ChatResponse = {
      role,
      conversationId: conversation.id,
      items: [...page.items].reverse().flatMap(chatItems),
      more: page.next !== undefined,
      live: liveView(await runtime.harness.snapshot(LiveDoc, conversation.id, context)),
    };
    return json(response);
  }

  /** Without a path: the list of the collected files. With `patch` or a file path: that content. */
  async #artifacts(runtime: FeatureRuntime, path: string): Promise<Response> {
    const artifacts = await runtime.harness.snapshot(ArtifactsDoc, BACKGROUND_CONTEXT);
    if (path === "") {
      return json({
        collectedAt: artifacts?.collectedAt === undefined ? null : new Date(artifacts.collectedAt).toISOString(),
        status: artifacts?.status ?? "",
        files: Object.keys(artifacts?.files ?? {}).sort(),
        patchBytes: artifacts?.patch.length ?? 0,
      } satisfies ArtifactsResponse);
    }
    if (path === PATCH_ARTIFACT) return text(artifacts?.patch ?? "");
    const content = artifacts?.files[path];
    return content === undefined ? failure(`no artifact ${path}`, HTTP_STATUS.notFound) : text(content);
  }
  // endregion: http
}
