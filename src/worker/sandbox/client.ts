// HTTP client of OpenSandbox: the lifecycle API of the server, and the execd API of one sandbox through the proxy of
// the server. The worker reaches both through the gateway sidecar, which adds the API key.
import { CONTENT_TYPE, HEADER, HTTP_METHOD, HTTP_STATUS, MS_PER_SECOND } from "../constants.ts";

// region: lifecycle types
export const SANDBOX_STATE = {
  pending: "Pending",
  allocated: "Allocated",
  running: "Running",
  pausing: "Pausing",
  paused: "Paused",
  resuming: "Resuming",
  stopping: "Stopping",
  terminated: "Terminated",
  failed: "Failed",
} as const;
export type SandboxState = (typeof SANDBOX_STATE)[keyof typeof SANDBOX_STATE];

export interface SandboxStatus {
  state: SandboxState;
  reason?: string;
  message?: string;
}

export interface SandboxInfo {
  id: string;
  status: SandboxStatus;
  metadata?: Record<string, string>;
  createdAt: string;
  expiresAt?: string;
}

export interface PvcVolume {
  claimName: string;
  createIfNotExists: boolean;
  deleteOnSandboxTermination: boolean;
  storageClass?: string;
  storage: string;
  accessModes: string[];
}

export interface SandboxVolume {
  name: string;
  mountPath: string;
  readOnly: boolean;
  pvc: PvcVolume;
}

export interface CreateSandboxRequest {
  image: { uri: string };
  entrypoint: string[];
  /** Seconds until the server removes the sandbox. `null` means no expiry. */
  timeout: number | null;
  resourceLimits: Record<string, string>;
  resourceRequests?: Record<string, string>;
  env?: Record<string, string>;
  metadata?: Record<string, string>;
  platform?: { os: string; arch: string };
  volumes?: SandboxVolume[];
}

interface ListSandboxesResponse {
  items: SandboxInfo[];
}
// endregion: lifecycle types

// region: execd types
export const FILE_TYPE = {
  file: "file",
  directory: "directory",
  symlink: "symlink",
  other: "other",
} as const;
export type ExecdFileType = (typeof FILE_TYPE)[keyof typeof FILE_TYPE];

/** `GET /files/info` entry. `mode` is the octal permission written as decimal digits, for example 644. */
export interface ExecdFileInfo {
  path: string;
  type: ExecdFileType;
  size: number;
  modified_at: string;
  mode: number;
}

export interface CommandStatus {
  id: string;
  running: boolean;
  exit_code?: number;
  error?: string;
}

export interface StartCommandRequest {
  /** Shell text. Exactly one of `command` and `argv` is set. */
  command?: string;
  /** A program and its arguments, run without a shell. */
  argv?: readonly string[];
  cwd?: string;
  envs?: Record<string, string>;
  timeoutMs?: number;
  /** Numeric user and group of the process. Absent: the user of the execd daemon. */
  uid?: number;
  gid?: number;
}

export interface UploadOptions {
  isNew: boolean;
  owner?: { user: string; group: string };
}

export interface CommandLogs {
  bytes: Uint8Array;
  /** Byte offset for the next read. */
  cursor: number;
}

interface StreamEvent {
  type?: string;
  text?: string;
  error?: { ename?: string; evalue?: string };
}
// endregion: execd types

const API_VERSION_PATH = "/v1";
const EXECD_PORT = 44772;
const LIST_PAGE_SIZE = 100;
const EXECD_ERROR_CODE = { fileNotFound: "FILE_NOT_FOUND" } as const;
const STREAM_EVENT_INIT = "init";
const STREAM_EVENT_ERROR = "error";
const SSE_DATA_PREFIX = "data:";
/** Octal permission of a new file, in the decimal-digit form that execd reads. */
const NEW_FILE_MODE = 644;
const UPLOAD_PART = { metadata: "metadata", file: "file" } as const;
/** The server keeps a sandbox create request open until the pod runs, so this request needs a long limit. */
const CREATE_TIMEOUT_MS = 300 * MS_PER_SECOND;
const REQUEST_TIMEOUT_MS = 60 * MS_PER_SECOND;

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** An answer of OpenSandbox with a status that is not a success. */
export class SandboxApiError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "SandboxApiError";
    this.status = status;
    this.code = code;
  }
}

/**
 * True only for the answer of execd that a path does not exist. The proxy of the server also answers 404, for
 * example while a new pod of the sandbox has no address, and that answer says nothing about a file.
 */
export function isFileNotFound(error: unknown): boolean {
  return (
    error instanceof SandboxApiError &&
    error.status === HTTP_STATUS.notFound &&
    error.code === EXECD_ERROR_CODE.fileNotFound
  );
}

async function apiError(response: Response, action: string): Promise<SandboxApiError> {
  const body = await response.text().catch(() => "");
  let code: string | undefined;
  let message = body;
  try {
    const parsed = JSON.parse(body) as { code?: unknown; message?: unknown };
    if (typeof parsed.code === "string") code = parsed.code;
    if (typeof parsed.message === "string") message = parsed.message;
  } catch {
    // The body is not JSON; keep the text.
  }
  return new SandboxApiError(response.status, `${action} failed with HTTP ${response.status}: ${message}`, code);
}

function withTimeout(init: RequestInit | undefined, timeoutMs: number): RequestInit {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  return { ...init, signal };
}

/** Client of the execd daemon of one sandbox. */
export class ExecdClient {
  readonly #baseUrl: string;
  readonly #fetcher: Fetcher;

  constructor(baseUrl: string, fetcher: Fetcher) {
    this.#baseUrl = baseUrl;
    this.#fetcher = fetcher;
  }

  #request(path: string, init?: RequestInit): Promise<Response> {
    return this.#fetcher(`${this.#baseUrl}${path}`, withTimeout(init, REQUEST_TIMEOUT_MS));
  }

  async ping(signal?: AbortSignal): Promise<boolean> {
    try {
      const response = await this.#request("/ping", { signal });
      await response.body?.cancel();
      return response.ok;
    } catch {
      return false;
    }
  }

  // region: commands
  /**
   * Starts a detached command and returns its id. The command keeps running when this worker goes away, and its
   * output stays in a file of the sandbox, so a caller can read it with `logs()` at any later time.
   */
  async startCommand(request: StartCommandRequest, signal?: AbortSignal): Promise<string> {
    const body = {
      ...(request.command === undefined ? {} : { command: request.command }),
      ...(request.argv === undefined ? {} : { argv: request.argv }),
      ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      ...(request.envs === undefined ? {} : { envs: request.envs }),
      ...(request.timeoutMs === undefined ? {} : { timeout: Math.ceil(request.timeoutMs) }),
      ...(request.uid === undefined ? {} : { uid: request.uid }),
      ...(request.gid === undefined ? {} : { gid: request.gid }),
      background: true,
    };
    const response = await this.#request("/command", {
      method: HTTP_METHOD.post,
      headers: { [HEADER.contentType]: CONTENT_TYPE.json },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await apiError(response, "start command");
    const id = await readCommandId(response);
    if (id === undefined) throw new SandboxApiError(response.status, "start command: the stream had no init event");
    return id;
  }

  async commandStatus(id: string, signal?: AbortSignal): Promise<CommandStatus> {
    const response = await this.#request(`/command/status/${encodeURIComponent(id)}`, { signal });
    if (!response.ok) throw await apiError(response, "command status");
    return (await response.json()) as CommandStatus;
  }

  /** Reads the combined stdout and stderr of a detached command from the byte offset `cursor`. */
  async commandLogs(id: string, cursor: number, signal?: AbortSignal): Promise<CommandLogs> {
    const response = await this.#request(`/command/${encodeURIComponent(id)}/logs?cursor=${cursor}`, { signal });
    if (!response.ok) throw await apiError(response, "command logs");
    const bytes = new Uint8Array(await response.arrayBuffer());
    const header = response.headers.get(HEADER.commandTailCursor);
    const next = header === null ? Number.NaN : Number(header);
    return { bytes, cursor: Number.isFinite(next) && next >= cursor ? next : cursor + bytes.byteLength };
  }

  /** The size of the output of a detached command so far. execd moves a cursor past the end back to the end. */
  async commandLogSize(id: string, signal?: AbortSignal): Promise<number> {
    const response = await this.#request(`/command/${encodeURIComponent(id)}/logs?cursor=${Number.MAX_SAFE_INTEGER}`, {
      signal,
    });
    if (!response.ok) throw await apiError(response, "command log size");
    await response.body?.cancel();
    const header = response.headers.get(HEADER.commandTailCursor);
    const size = header === null ? Number.NaN : Number(header);
    return Number.isFinite(size) && size >= 0 && size < Number.MAX_SAFE_INTEGER ? size : 0;
  }

  async interruptCommand(id: string): Promise<void> {
    const response = await this.#request(`/command?id=${encodeURIComponent(id)}`, { method: HTTP_METHOD.delete });
    await response.body?.cancel();
  }
  // endregion: commands

  // region: files
  /** Information about the path itself: a symbolic link is not followed. `undefined` when nothing is there. */
  async fileInfo(path: string, signal?: AbortSignal): Promise<ExecdFileInfo | undefined> {
    const response = await this.#request(`/files/info?path=${encodeURIComponent(path)}`, { signal });
    if (!response.ok) {
      const error = await apiError(response, `file info ${path}`);
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    const infos = (await response.json()) as Record<string, ExecdFileInfo>;
    return infos[path] ?? Object.values(infos)[0];
  }

  /** Downloads a file, or the bytes `[start, end)` of it. `undefined` when the file is not there. */
  async download(
    path: string,
    range?: { start: number; end: number },
    signal?: AbortSignal,
  ): Promise<Uint8Array | undefined> {
    if (range !== undefined && range.end <= range.start) return new Uint8Array(0);
    const headers: Record<string, string> = {};
    if (range !== undefined) headers[HEADER.range] = `bytes=${range.start}-${range.end - 1}`;
    const response = await this.#request(`/files/download?path=${encodeURIComponent(path)}`, { headers, signal });
    if (response.status === HTTP_STATUS.rangeNotSatisfiable) {
      await response.body?.cancel();
      return new Uint8Array(0);
    }
    if (!response.ok) {
      const error = await apiError(response, `download ${path}`);
      if (isFileNotFound(error)) return undefined;
      throw error;
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  /**
   * Writes a file and makes its parent directories. An existing file keeps its permission. `owner` names the user
   * and the group that get the file and each new directory; without it they belong to the user of the daemon.
   */
  async upload(path: string, content: Uint8Array, options: UploadOptions, signal?: AbortSignal): Promise<void> {
    const metadata = {
      path,
      ...(options.isNew ? { mode: NEW_FILE_MODE } : {}),
      ...(options.owner === undefined ? {} : { owner: options.owner.user, group: options.owner.group }),
    };
    const form = new FormData();
    // execd reads both parts as files, so each part needs a file name.
    form.append(
      UPLOAD_PART.metadata,
      new Blob([JSON.stringify(metadata)], { type: CONTENT_TYPE.json }),
      UPLOAD_PART.metadata,
    );
    form.append(
      UPLOAD_PART.file,
      new Blob([content as Uint8Array<ArrayBuffer>], { type: CONTENT_TYPE.octetStream }),
      UPLOAD_PART.file,
    );
    const response = await this.#request("/files/upload", { method: HTTP_METHOD.post, body: form, signal });
    if (!response.ok) throw await apiError(response, `upload ${path}`);
    await response.body?.cancel();
  }

  /** The entries of one directory. A symbolic link in the list is not followed. */
  async listDirectory(path: string, signal?: AbortSignal): Promise<ExecdFileInfo[]> {
    const response = await this.#request(`/directories/list?path=${encodeURIComponent(path)}&depth=1`, { signal });
    if (!response.ok) throw await apiError(response, `list ${path}`);
    return (await response.json()) as ExecdFileInfo[];
  }
  // endregion: files
}

/** Reads the event stream of a command start until the event that carries the command id. */
async function readCommandId(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (reader === undefined) return undefined;
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (value !== undefined) buffered += decoder.decode(value, { stream: true });
      const lines = buffered.split("\n");
      buffered = done ? "" : (lines.pop() ?? "");
      for (const line of lines) {
        const event = parseStreamEvent(line);
        if (event?.type === STREAM_EVENT_INIT && event.text) return event.text;
        if (event?.type === STREAM_EVENT_ERROR) {
          throw new SandboxApiError(HTTP_STATUS.internalError, `start command: ${event.error?.evalue ?? "error"}`);
        }
      }
      if (done) return undefined;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}

/** execd writes one JSON object for each event. A proxy can add the `data:` prefix of a standard event stream. */
function parseStreamEvent(line: string): StreamEvent | undefined {
  let text = line.trim();
  if (text.startsWith(SSE_DATA_PREFIX)) text = text.slice(SSE_DATA_PREFIX.length).trim();
  if (!text.startsWith("{")) return undefined;
  try {
    return JSON.parse(text) as StreamEvent;
  } catch {
    return undefined;
  }
}

/** Client of the OpenSandbox server. `baseUrl` is the gateway route to the server, without `/v1`. */
export class SandboxClient {
  readonly #baseUrl: string;
  readonly #fetcher: Fetcher;

  constructor(baseUrl: string, fetcher: Fetcher = (input, init) => fetch(input, init)) {
    this.#baseUrl = `${baseUrl.replace(/\/+$/, "")}${API_VERSION_PATH}`;
    this.#fetcher = fetcher;
  }

  async create(request: CreateSandboxRequest): Promise<SandboxInfo> {
    const response = await this.#fetcher(
      `${this.#baseUrl}/sandboxes`,
      withTimeout(
        {
          method: HTTP_METHOD.post,
          headers: { [HEADER.contentType]: CONTENT_TYPE.json },
          body: JSON.stringify(request),
        },
        CREATE_TIMEOUT_MS,
      ),
    );
    if (!response.ok) throw await apiError(response, "create sandbox");
    return (await response.json()) as SandboxInfo;
  }

  async get(id: string): Promise<SandboxInfo | undefined> {
    const response = await this.#fetcher(
      `${this.#baseUrl}/sandboxes/${encodeURIComponent(id)}`,
      withTimeout(undefined, REQUEST_TIMEOUT_MS),
    );
    if (response.status === HTTP_STATUS.notFound) {
      await response.body?.cancel();
      return undefined;
    }
    if (!response.ok) throw await apiError(response, `get sandbox ${id}`);
    return (await response.json()) as SandboxInfo;
  }

  /** The sandboxes that carry each of the metadata entries. */
  async findByMetadata(metadata: Record<string, string>): Promise<SandboxInfo[]> {
    const filter = new URLSearchParams(metadata).toString();
    const query = new URLSearchParams({ metadata: filter, pageSize: String(LIST_PAGE_SIZE) });
    const response = await this.#fetcher(
      `${this.#baseUrl}/sandboxes?${query}`,
      withTimeout(undefined, REQUEST_TIMEOUT_MS),
    );
    if (!response.ok) throw await apiError(response, "list sandboxes");
    return ((await response.json()) as ListSandboxesResponse).items;
  }

  async delete(id: string): Promise<void> {
    const response = await this.#fetcher(
      `${this.#baseUrl}/sandboxes/${encodeURIComponent(id)}`,
      withTimeout({ method: HTTP_METHOD.delete }, REQUEST_TIMEOUT_MS),
    );
    if (!response.ok && response.status !== HTTP_STATUS.notFound)
      throw await apiError(response, `delete sandbox ${id}`);
    await response.body?.cancel();
  }

  /** The execd daemon of a sandbox, through the proxy of the server. The proxy follows a new pod address. */
  execd(id: string): ExecdClient {
    return new ExecdClient(`${this.#baseUrl}/sandboxes/${encodeURIComponent(id)}/proxy/${EXECD_PORT}`, this.#fetcher);
  }
}
