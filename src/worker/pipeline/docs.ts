// The state of one feature that the worker keeps next to the transcripts, in documents of the Session. A Durable
// Object holds one feature, so each document has Session scope.
import { defineDoc } from "@earendil-works/pi-durable";

/** What the caller asks for. Stored as given, so a repeated request can be compared with it. */
export type FeatureSpec = {
  name: string;
  /** Git URL of the project. */
  repo: string;
  /** Branch, tag, or commit that the feature branch starts from. Empty: the default branch of the clone. */
  ref: string;
  /** The feature to implement, in the words of the caller. */
  task: string;
  /** Shell text that runs as root in the repository at each sandbox start, for example a package install. */
  rootSetup: string;
  /** Shell text that runs as the sandbox user in the repository at each sandbox start. */
  userSetup: string;
  /** Variables of each agent command, for example a PATH with the virtual environment. */
  env: Record<string, string>;
};

export type FeatureState = {
  spec?: FeatureSpec;
  /** Id of the pipeline task. */
  pipelineTaskId?: number;
  createdAt?: number;
  /**
   * The model that the pipeline started with. A deployment with a different model does not continue the pipeline:
   * a scripted test model, for example, must never finish the work of a real one.
   */
  model?: { provider: string; modelId: string };
};

export const FeatureDoc = defineDoc<FeatureState>({
  kind: "app.feature",
  version: 1,
  scope: "session",
  initial: () => ({}),
});

export type SandboxDocState = {
  sandboxId?: string;
  createdAt?: number;
  /** How many sandboxes this feature had. More than one means that a sandbox was lost and made again. */
  generation: number;
};

export const SandboxDoc = defineDoc<SandboxDocState>({
  kind: "app.sandbox",
  version: 1,
  scope: "session",
  initial: () => ({ generation: 0 }),
});

export type ProgressEvent = {
  at: number;
  phase: string;
  message: string;
};

export type ProgressState = {
  phase: string;
  round: number;
  /** Conversation id of each role that worked on the feature. */
  conversations: Record<string, number>;
  events: ProgressEvent[];
};

const MAX_PROGRESS_EVENTS = 200;
const MAX_EVENT_CHARS = 600;
/** The phase name of an event that a message of the user made. */
export const USER_EVENT_PHASE = "user";

/** Adds one line to the progress log. The log keeps the newest lines only. */
export function pushEvent(progress: ProgressState, event: ProgressEvent): void {
  const message =
    event.message.length <= MAX_EVENT_CHARS
      ? event.message
      : `${event.message.slice(0, MAX_EVENT_CHARS)}\n[truncated]\n`;
  progress.events.push({ ...event, message });
  if (progress.events.length > MAX_PROGRESS_EVENTS) {
    progress.events.splice(0, progress.events.length - MAX_PROGRESS_EVENTS);
  }
}

export const ProgressDoc = defineDoc<ProgressState>({
  kind: "app.progress",
  version: 1,
  scope: "session",
  initial: () => ({ phase: "", round: 0, conversations: {}, events: [] }),
});

export type ArtifactsState = {
  /** Text of each document that the agents wrote, by path in the repository. */
  files: Record<string, string>;
  /** `git diff` of the feature branch against its start. */
  patch: string;
  /** Output of `git status --short`. */
  status: string;
  collectedAt?: number;
};

export const ArtifactsDoc = defineDoc<ArtifactsState>({
  kind: "app.artifacts",
  version: 1,
  scope: "session",
  initial: () => ({ files: {}, patch: "", status: "" }),
});
