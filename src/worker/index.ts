// Entry of the worker that celld runs. Each feature has its own Durable Object, named by the feature, so the worker
// only finds the object of a request and passes the request on. It also serves the page: one HTML file that calls
// the same routes.
import type { WorkerEnv } from "./config.ts";
import { CONTENT_TYPE, FEATURE_NAME_PATTERN, FEATURES_SEGMENT, HEADER, HTTP_METHOD, HTTP_STATUS } from "./constants.ts";
import { listFeatures } from "./feature-index.ts";
import PAGE from "./ui/index.html";

export { FeatureAgent } from "./feature-agent.ts";
export { FeatureIndex } from "./feature-index.ts";

const HEALTH_PATH = "/healthz";
const PAGE_PATH = "/";

const USAGE = {
  service: "pi-agent-celld-spike",
  routes: {
    "GET /": "the page: the list of the features, the chat of each agent, and a message box",
    "GET /features": "the list of the features",
    "PUT /features/<name>": "start the pipeline of a feature; body: {repo, ref?, task, rootSetup?, userSetup?, env?}",
    "GET /features/<name>": "status of the feature",
    "GET /features/<name>/transcript?role=<role>&limit=<n>": "newest entries of the conversation of one agent",
    "GET /features/<name>/chat?role=<role>&after=<id>": "the conversation of one agent as JSON, with its live state",
    "POST /features/<name>/messages": "a message of the user; body: {content, role?, mode?: agent | round}",
    "GET /features/<name>/artifacts": "list of the collected documents",
    "GET /features/<name>/artifacts/<path>": "one document, or `patch` for the diff",
    "GET /features/<name>/tasks": "live tasks and submissions of the Harness",
    "POST /features/<name>/abort": "stop the pipeline",
    "DELETE /features/<name>": "stop the pipeline and remove the sandbox",
  },
} as const;

function json(body: unknown, status: number): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { [HEADER.contentType]: CONTENT_TYPE.json },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === HEALTH_PATH) return json({ ok: true }, HTTP_STATUS.ok);
    // After an upgrade of the chart, a node runs the old deployment for some seconds. A request that names a
    // deployment waits for it, so a feature does not start with the settings of the old one.
    const wanted = request.headers.get(HEADER.deployId);
    if (wanted !== null && wanted !== env.DEPLOY_ID) {
      const error = `this node runs deployment ${env.DEPLOY_ID ?? "(no id)"}; the request is for ${wanted}`;
      return json({ error }, HTTP_STATUS.serviceUnavailable);
    }
    if (url.pathname === PAGE_PATH) {
      return new Response(PAGE, { headers: { [HEADER.contentType]: CONTENT_TYPE.html } });
    }
    const [segment, name] = url.pathname.split("/").filter((part) => part !== "");
    if (segment !== FEATURES_SEGMENT) return json(USAGE, HTTP_STATUS.ok);
    if (name === undefined) {
      if (request.method !== HTTP_METHOD.get) return json({ error: "use GET" }, HTTP_STATUS.methodNotAllowed);
      return listFeatures(env.INDEX);
    }
    if (!FEATURE_NAME_PATTERN.test(name)) {
      const error = `a feature name must match ${FEATURE_NAME_PATTERN.source}`;
      return json({ error }, HTTP_STATUS.badRequest);
    }
    return env.FEATURE.get(env.FEATURE.idFromName(name)).fetch(request);
  },
};
