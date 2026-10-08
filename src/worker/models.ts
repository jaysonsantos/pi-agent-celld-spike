// Model access of the Harness. A real model goes through the gateway sidecar, which adds the API key, so the worker
// holds no secret. The `faux` setting gives a scripted model for tests.
import type { Api, Model } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";
import { createModels, createProvider, type Models } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { LLM_API, type WorkerConfig } from "./config.ts";
import { GATEWAY_PREFIX } from "./constants.ts";
import { fauxRoute } from "./pipeline/faux-script.ts";

const GATEWAY_PROVIDER_NAME = "Gateway sidecar";
/** The SDKs refuse an empty key. The gateway replaces this value with the real key. */
const PLACEHOLDER_API_KEY = "set-by-the-gateway";
/** Each request takes one scripted answer from the queue. A new process starts with a full queue. */
const FAUX_QUEUE_LENGTH = 100_000;
const FAUX_TOKENS_PER_SECOND = 400;
const NO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

export interface ModelRuntime {
  models: Models;
  model: { provider: string; modelId: string };
}

export function createModelRuntime(config: WorkerConfig): ModelRuntime {
  const models = createModels();
  if (config.llm.api === LLM_API.faux) {
    const faux = fauxProvider({ tokensPerSecond: FAUX_TOKENS_PER_SECOND });
    faux.setResponses(Array.from({ length: FAUX_QUEUE_LENGTH }, () => fauxRoute));
    models.setProvider(faux.provider);
    return { models, model: { provider: faux.provider.id, modelId: faux.getModel().id } };
  }

  const baseUrl = `${config.gatewayUrl}${GATEWAY_PREFIX.llm}`;
  const model: Model<Api> = {
    id: config.llm.model,
    name: config.llm.model,
    api: config.llm.api,
    provider: config.llm.provider,
    baseUrl,
    reasoning: config.llm.reasoning,
    input: ["text"],
    cost: { ...NO_COST },
    contextWindow: config.llm.contextWindow,
    maxTokens: config.llm.maxTokens,
  };
  models.setProvider(
    createProvider({
      id: config.llm.provider,
      name: GATEWAY_PROVIDER_NAME,
      baseUrl,
      auth: {
        apiKey: { name: GATEWAY_PROVIDER_NAME, resolve: async () => ({ auth: { apiKey: PLACEHOLDER_API_KEY } }) },
      },
      models: [model],
      api: {
        [LLM_API.openaiCompletions]: openAICompletionsApi(),
        [LLM_API.openaiResponses]: openAIResponsesApi(),
        [LLM_API.anthropicMessages]: anthropicMessagesApi(),
      },
    }),
  );
  return { models, model: { provider: config.llm.provider, modelId: config.llm.model } };
}
