// The list of the features. A Durable Object cannot list the other objects of its class, so each feature object
// writes a short summary of itself to this one object, and the page reads the list from here.
//
// The list is a copy for the page only. The state of a feature is in the object of that feature.
import { DurableObject, type DurableObjectNamespace, type DurableObjectState } from "cloudflare:workers";
import type { WorkerEnv } from "./config.ts";
import { CONTENT_TYPE, FEATURE_NAME_PATTERN, HEADER, HTTP_METHOD, HTTP_STATUS } from "./constants.ts";

// region: constants
/** One object holds the list of all features. */
const INDEX_OBJECT_NAME = "features";
/** The host is not used: a request to a stub goes to its object. */
const INDEX_ORIGIN = "http://feature-index";
const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS features (
  name TEXT PRIMARY KEY,
  summary TEXT NOT NULL,
  updated_at INTEGER NOT NULL
)`;
const UPSERT = `INSERT INTO features (name, summary, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(name) DO UPDATE SET summary = excluded.summary, updated_at = excluded.updated_at`;
const SELECT_ALL = "SELECT summary, updated_at FROM features ORDER BY updated_at DESC, name";
// endregion: constants

/** What the list shows of one feature. A feature object sends it when one of its values changes. */
export interface FeatureSummary {
  name: string;
  repo: string;
  /** The start of the task text. */
  task: string;
  /** `running`, `blocked`, `accepted`, `needs-attention`, `failed`, `aborted`, or `new`. */
  state: string;
  phase: string;
  round: number;
  /** The roles that work at this moment. */
  busy: string[];
  model: string;
  createdAt: number | null;
}

export interface FeatureListResponse {
  features: (FeatureSummary & { updatedAt: number })[];
}

function json(body: unknown, status: number = HTTP_STATUS.ok): Response {
  return new Response(`${JSON.stringify(body, null, 2)}\n`, {
    status,
    headers: { [HEADER.contentType]: CONTENT_TYPE.json },
  });
}

function stub(namespace: DurableObjectNamespace) {
  return namespace.get(namespace.idFromName(INDEX_OBJECT_NAME));
}

/** Reads the list. The caller is the worker entry. */
export function listFeatures(namespace: DurableObjectNamespace): Promise<Response> {
  return stub(namespace).fetch(new Request(INDEX_ORIGIN));
}

/** Writes the summary of one feature. The caller is the object of that feature. */
export function putFeatureSummary(namespace: DurableObjectNamespace, summary: FeatureSummary): Promise<Response> {
  return stub(namespace).fetch(
    new Request(`${INDEX_ORIGIN}/${summary.name}`, {
      method: HTTP_METHOD.put,
      headers: { [HEADER.contentType]: CONTENT_TYPE.json },
      body: JSON.stringify(summary),
    }),
  );
}

export class FeatureIndex extends DurableObject<WorkerEnv> {
  #hasTable = false;

  constructor(ctx: DurableObjectState, env: WorkerEnv) {
    super(ctx, env);
  }

  /** Makes the table at the first request, as the storage adapter of Pi Durable does for its tables. */
  #prepare(): void {
    if (this.#hasTable) return;
    this.ctx.storage.sql.exec(CREATE_TABLE);
    this.#hasTable = true;
  }

  override async fetch(request: Request): Promise<Response> {
    this.#prepare();
    const [name] = new URL(request.url).pathname.split("/").filter((part) => part !== "");
    if (name === undefined) {
      if (request.method !== HTTP_METHOD.get) return json({ error: "use GET" }, HTTP_STATUS.methodNotAllowed);
      return json(this.#list());
    }
    if (!FEATURE_NAME_PATTERN.test(name)) return json({ error: "not a feature name" }, HTTP_STATUS.badRequest);
    if (request.method !== HTTP_METHOD.put) return json({ error: "use PUT" }, HTTP_STATUS.methodNotAllowed);
    const summary: unknown = await request.json().catch(() => undefined);
    if (typeof summary !== "object" || summary === null || Array.isArray(summary)) {
      return json({ error: "the body must be a JSON object" }, HTTP_STATUS.badRequest);
    }
    this.ctx.storage.sql.exec(UPSERT, name, JSON.stringify({ ...summary, name }), Date.now());
    return json({ ok: true });
  }

  #list(): FeatureListResponse {
    const rows = this.ctx.storage.sql.exec(SELECT_ALL).toArray();
    return {
      features: rows.map((row) => ({
        ...(JSON.parse(String(row.summary)) as FeatureSummary),
        updatedAt: Number(row.updated_at),
      })),
    };
  }
}
