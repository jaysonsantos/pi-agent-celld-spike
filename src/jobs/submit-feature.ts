// Sends the request of one feature to the worker and waits until the worker accepts it. The request is idempotent:
// a feature that exists with the same repo, ref, and task keeps its state.
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const FLAG = {
  url: "url",
  feature: "feature",
  spec: "spec",
  timeout: "timeout-seconds",
  deployId: "deploy-id",
} as const;
const DEPLOY_ID_HEADER = "x-deploy-id";
const ENV = {
  url: "WORKER_URL",
  feature: "FEATURE_NAME",
  spec: "FEATURE_SPEC_PATH",
  timeout: "SUBMIT_TIMEOUT_SECONDS",
  deployId: "DEPLOY_ID",
} as const;
const DEFAULT_TIMEOUT_SECONDS = 900;
const RETRY_PAUSE_MS = 5000;
const REQUEST_TIMEOUT_MS = 60_000;
const MS_PER_SECOND = 1000;
const HTTP_CONFLICT = 409;

const { values } = parseArgs({
  options: {
    [FLAG.url]: { type: "string", default: process.env[ENV.url] ?? "" },
    [FLAG.feature]: { type: "string", default: process.env[ENV.feature] ?? "" },
    [FLAG.spec]: { type: "string", default: process.env[ENV.spec] ?? "" },
    [FLAG.timeout]: { type: "string", default: process.env[ENV.timeout] ?? String(DEFAULT_TIMEOUT_SECONDS) },
    [FLAG.deployId]: { type: "string", default: process.env[ENV.deployId] ?? "" },
  },
  strict: true,
});

const baseUrl = values[FLAG.url].replace(/\/+$/, "");
const feature = values[FLAG.feature];
if (baseUrl === "" || feature === "" || values[FLAG.spec] === "") {
  throw new Error(`--${FLAG.url}, --${FLAG.feature}, and --${FLAG.spec} are necessary`);
}
const body = readFileSync(values[FLAG.spec], "utf8");
JSON.parse(body);
const deadline = Date.now() + Number(values[FLAG.timeout]) * MS_PER_SECOND;

for (;;) {
  try {
    const response = await fetch(`${baseUrl}/features/${feature}`, {
      method: "PUT",
      // With the id, the worker accepts the request only when it runs the deployment of the same chart revision.
      headers: {
        "content-type": "application/json",
        ...(values[FLAG.deployId] === "" ? {} : { [DEPLOY_ID_HEADER]: values[FLAG.deployId] }),
      },
      body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await response.text();
    if (response.ok) {
      console.log(`feature ${feature}: HTTP ${response.status}\n${text}`);
      break;
    }
    // A different request for the same name cannot succeed later, so stop at once.
    if (response.status === HTTP_CONFLICT) throw new Error(`feature ${feature}: ${text}`);
    console.log(`feature ${feature}: HTTP ${response.status}, try again: ${text.slice(0, 300)}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`feature ${feature}:`)) throw error;
    console.log(
      `feature ${feature}: the worker is not ready: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Date.now() > deadline) throw new Error(`feature ${feature}: the worker did not accept the request in time`);
  await new Promise((resolve) => setTimeout(resolve, RETRY_PAUSE_MS));
}
