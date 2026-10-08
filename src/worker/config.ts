// Settings of the worker. celld gives each `vars` entry of the Wrangler config as a string binding on `env`.
import type { DurableObjectNamespace } from "cloudflare:workers";
import { BYTES_PER_KIB } from "./constants.ts";

export const LLM_API = {
  faux: "faux",
  openaiCompletions: "openai-completions",
  openaiResponses: "openai-responses",
  anthropicMessages: "anthropic-messages",
} as const;
export type LlmApi = (typeof LLM_API)[keyof typeof LLM_API];

/** The bindings of the worker. Each setting has a default, so only the two namespaces are always there. */
export interface WorkerEnv {
  FEATURE: DurableObjectNamespace;
  /** The one object that holds the list of the features. */
  INDEX: DurableObjectNamespace;
  GATEWAY_URL?: string;
  LLM_API?: string;
  LLM_PROVIDER?: string;
  LLM_MODEL?: string;
  LLM_CONTEXT_WINDOW?: string;
  LLM_MAX_TOKENS?: string;
  LLM_REASONING?: string;
  LLM_THINKING_LEVEL?: string;
  SANDBOX_IMAGE?: string;
  SANDBOX_ARCH?: string;
  SANDBOX_CPU_LIMIT?: string;
  SANDBOX_MEMORY_LIMIT?: string;
  SANDBOX_CPU_REQUEST?: string;
  SANDBOX_MEMORY_REQUEST?: string;
  SANDBOX_WORKSPACE_STORAGE_CLASS?: string;
  SANDBOX_WORKSPACE_SIZE?: string;
  PIPELINE_MAX_ROUNDS?: string;
  BUCKET_URL?: string;
  /** The id of this deployment, which the chart sets. */
  DEPLOY_ID?: string;
}

const DEFAULT = {
  gatewayUrl: "http://127.0.0.1:9100",
  llmApi: LLM_API.faux,
  llmProvider: "gateway",
  llmModel: "faux-1",
  llmContextWindow: 200 * BYTES_PER_KIB,
  llmMaxTokens: 16 * BYTES_PER_KIB,
  llmThinkingLevel: "medium",
  sandboxImage: "python:3.13-bookworm",
  sandboxArch: "amd64",
  sandboxCpuLimit: "2",
  sandboxMemoryLimit: "2Gi",
  sandboxCpuRequest: "250m",
  sandboxMemoryRequest: "512Mi",
  sandboxWorkspaceStorageClass: "",
  sandboxWorkspaceSize: "5Gi",
  pipelineMaxRounds: 3,
  bucketUrl: "",
} as const;

const TRUE_VALUES = new Set(["1", "true", "yes"]);
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

export interface LlmConfig {
  api: LlmApi;
  /**
   * The provider id that pi-ai sees. pi-ai selects request details by this id, for example the reasoning field of
   * `openrouter`. The requests still go to the gateway.
   */
  provider: string;
  model: string;
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  thinkingLevel: ThinkingLevel;
}

export interface SandboxConfig {
  image: string;
  arch: string;
  cpuLimit: string;
  memoryLimit: string;
  cpuRequest: string;
  memoryRequest: string;
  /** Empty: the default StorageClass of the cluster. */
  workspaceStorageClass: string;
  workspaceSize: string;
}

export interface WorkerConfig {
  gatewayUrl: string;
  llm: LlmConfig;
  sandbox: SandboxConfig;
  pipelineMaxRounds: number;
  /** `s3://bucket/prefix` of the celld fleet, for the status output only. */
  bucketUrl: string;
}

function text(value: string | undefined, fallback: string): string {
  return value === undefined || value === "" ? fallback : value;
}

function positiveInteger(value: string | undefined, fallback: number, name: keyof WorkerEnv): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer, got ${value}`);
  return parsed;
}

function oneOf<T extends string>(value: string, allowed: readonly T[], name: keyof WorkerEnv): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`${name} must be one of ${allowed.join(", ")}, got ${value}`);
}

export function readConfig(env: WorkerEnv): WorkerConfig {
  return {
    gatewayUrl: text(env.GATEWAY_URL, DEFAULT.gatewayUrl).replace(/\/+$/, ""),
    llm: {
      api: oneOf(text(env.LLM_API, DEFAULT.llmApi), Object.values(LLM_API), "LLM_API"),
      provider: text(env.LLM_PROVIDER, DEFAULT.llmProvider),
      model: text(env.LLM_MODEL, DEFAULT.llmModel),
      contextWindow: positiveInteger(env.LLM_CONTEXT_WINDOW, DEFAULT.llmContextWindow, "LLM_CONTEXT_WINDOW"),
      maxTokens: positiveInteger(env.LLM_MAX_TOKENS, DEFAULT.llmMaxTokens, "LLM_MAX_TOKENS"),
      reasoning: TRUE_VALUES.has(text(env.LLM_REASONING, "").toLowerCase()),
      thinkingLevel: oneOf(
        text(env.LLM_THINKING_LEVEL, DEFAULT.llmThinkingLevel),
        THINKING_LEVELS,
        "LLM_THINKING_LEVEL",
      ),
    },
    sandbox: {
      image: text(env.SANDBOX_IMAGE, DEFAULT.sandboxImage),
      arch: text(env.SANDBOX_ARCH, DEFAULT.sandboxArch),
      cpuLimit: text(env.SANDBOX_CPU_LIMIT, DEFAULT.sandboxCpuLimit),
      memoryLimit: text(env.SANDBOX_MEMORY_LIMIT, DEFAULT.sandboxMemoryLimit),
      cpuRequest: text(env.SANDBOX_CPU_REQUEST, DEFAULT.sandboxCpuRequest),
      memoryRequest: text(env.SANDBOX_MEMORY_REQUEST, DEFAULT.sandboxMemoryRequest),
      workspaceStorageClass: text(env.SANDBOX_WORKSPACE_STORAGE_CLASS, DEFAULT.sandboxWorkspaceStorageClass),
      workspaceSize: text(env.SANDBOX_WORKSPACE_SIZE, DEFAULT.sandboxWorkspaceSize),
    },
    pipelineMaxRounds: positiveInteger(env.PIPELINE_MAX_ROUNDS, DEFAULT.pipelineMaxRounds, "PIPELINE_MAX_ROUNDS"),
    bucketUrl: text(env.BUCKET_URL, DEFAULT.bucketUrl),
  };
}
