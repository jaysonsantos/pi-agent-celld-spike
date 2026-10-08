// Names and numbers that the worker shares between modules.

// region: units
export const MS_PER_SECOND = 1000;
export const SECONDS_PER_MINUTE = 60;
export const BYTES_PER_KIB = 1024;
export const BYTES_PER_MIB = BYTES_PER_KIB * BYTES_PER_KIB;
// endregion: units

// region: http
export const HTTP_STATUS = {
  ok: 200,
  accepted: 202,
  partialContent: 206,
  badRequest: 400,
  notFound: 404,
  methodNotAllowed: 405,
  conflict: 409,
  rangeNotSatisfiable: 416,
  internalError: 500,
  serviceUnavailable: 503,
} as const;

export const HTTP_METHOD = {
  get: "GET",
  put: "PUT",
  post: "POST",
  delete: "DELETE",
} as const;

export const HEADER = {
  contentType: "content-type",
  range: "range",
  /** The deployment that a request is for. The worker refuses the request when it runs a different one. */
  deployId: "x-deploy-id",
  /** execd answers a log read with the byte offset for the next read. */
  commandTailCursor: "EXECD-COMMANDS-TAIL-CURSOR",
} as const;

export const CONTENT_TYPE = {
  json: "application/json",
  text: "text/plain; charset=utf-8",
  html: "text/html; charset=utf-8",
  octetStream: "application/octet-stream",
} as const;
// endregion: http

// region: routes
/** `/features/<name>` and the paths below it go to the Durable Object of that feature. */
export const FEATURES_SEGMENT = "features";
export const FEATURE_ACTION = {
  transcript: "transcript",
  artifacts: "artifacts",
  abort: "abort",
  tasks: "tasks",
  /** The conversation of one agent as JSON, for the page. */
  chat: "chat",
  /** A message of the user to an agent, or the request for a new round. */
  messages: "messages",
} as const;
export const QUERY = {
  role: "role",
  limit: "limit",
  /** Only entries after this entry id. */
  after: "after",
  /** Only entries before this entry id. */
  before: "before",
} as const;
// endregion: routes

// region: gateway
/** Path prefixes of the gateway sidecar. They match `ROUTE_PREFIX` in `src/gateway/inject-proxy.ts`. */
export const GATEWAY_PREFIX = {
  llm: "/llm",
  sandbox: "/sandbox",
} as const;
// endregion: gateway

// region: features
/** A feature name is also a label value and a part of a PersistentVolumeClaim name. */
export const FEATURE_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/;
/** Metadata key that marks the sandbox of a feature. OpenSandbox stores it as a label. */
export const SANDBOX_FEATURE_LABEL = "feature";
// endregion: features

// region: durable object
/** While a pipeline runs, the alarm wakes the object after a restart of the pod, and the Harness then resumes. */
export const HEARTBEAT_INTERVAL_MS = 15 * MS_PER_SECOND;
// endregion: durable object
