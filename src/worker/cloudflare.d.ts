// celld bundles an HTML file as a text module (the `rules` entry of wrangler.jsonc).
declare module "*.html" {
  const text: string;
  export default text;
}

// The parts of the Workers runtime API that this worker uses. celld gives the same API as Cloudflare Workers; the
// full type package conflicts with the Node types that the gateway and the tests use.
declare module "cloudflare:workers" {
  export interface SqlStorageCursor {
    toArray(): Record<string, ArrayBuffer | string | number | null>[];
  }

  export interface DurableObjectStorage {
    readonly sql: {
      exec(query: string, ...bindings: (ArrayBuffer | string | number | null)[]): SqlStorageCursor;
    };
    transaction<T>(closure: () => Promise<T>): Promise<T>;
    getAlarm(): Promise<number | null>;
    setAlarm(scheduledTime: number): Promise<void>;
    deleteAlarm(): Promise<void>;
  }

  export interface DurableObjectId {
    toString(): string;
    readonly name?: string;
  }

  export interface DurableObjectState {
    readonly id: DurableObjectId;
    readonly storage: DurableObjectStorage;
    waitUntil(promise: Promise<unknown>): void;
  }

  export interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }

  export interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  export abstract class DurableObject<Env = unknown> {
    protected readonly ctx: DurableObjectState;
    protected readonly env: Env;
    constructor(ctx: DurableObjectState, env: Env);
    fetch?(request: Request): Response | Promise<Response>;
    alarm?(info?: { retryCount: number; isRetry: boolean }): void | Promise<void>;
  }
}
