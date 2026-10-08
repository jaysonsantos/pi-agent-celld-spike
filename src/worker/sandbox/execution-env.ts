// The execution environment of Pi Durable on one OpenSandbox sandbox: the tools of an agent read, write, and run
// commands in the sandbox, and the Harness itself stays in the Durable Object.
import type { Context } from "@earendil-works/chord";
import {
  type BinaryReader,
  type DirReader,
  type ExecutionEnv,
  ExecutionError,
  err,
  FileError,
  type FileInfo,
  type FileKind,
  type FileWatcher,
  type LineScan,
  LineScanner,
  ok,
  type Result,
  type ShellExecOptions,
  type ShellExecResult,
  type TextLineReader,
  type WatchChange,
  type WatchTarget,
} from "@earendil-works/pi-durable/env";
import { BYTES_PER_MIB, HTTP_STATUS, MS_PER_SECOND } from "../constants.ts";
import { type ExecdClient, type ExecdFileInfo, FILE_TYPE, isFileNotFound, SandboxApiError } from "./client.ts";

// region: constants
const ENV_ID_PREFIX = "opensandbox:";
const PATH_SEPARATOR = "/";
const PARENT_SEGMENT = "..";
const CURRENT_SEGMENT = ".";
const NEWLINE = "\n";

/** The pause between two polls of a running command. It grows while the command prints nothing. */
const POLL_MIN_MS = 250;
const POLL_MAX_MS = 2 * MS_PER_SECOND;
const POLL_BACKOFF = 2;
/** A poll can fail while the gateway or the server restarts. The command itself keeps running in the sandbox. */
const POLL_MAX_FAILURES = 30;
const POLL_FAILURE_PAUSE_MS = 2 * MS_PER_SECOND;

/** A file reader keeps the file in memory, so it refuses a file above this size. */
const READER_MAX_BYTES = 64 * BYTES_PER_MIB;
/** Output kept in memory for the spill file. Output after this size is not in the spill file. */
const SPILL_MAX_BYTES = 16 * BYTES_PER_MIB;
const SPILL_DIRECTORY = "/tmp";
const SPILL_FILE_PREFIX = "pi-output-";
const SPILL_FILE_SUFFIX = ".log";

const MAX_TIMEOUT_MS = 2_147_483_647;
/** execd starts its timer some moments before the worker notes the start time. */
const TIMEOUT_MARGIN_MS = 5 * MS_PER_SECOND;
const KILLED_ERROR_PATTERN = /signal: killed/;
/** How much of the earlier output a call reads when it follows a command from before a restart. */
const ATTACH_TAIL_BYTES = BYTES_PER_MIB;
const TEXT_ENCODING = "utf-8";
const EXIT_CODE_UNKNOWN = 1;
/** execd reports this exit code when it cannot start the program. */
const EXIT_CODE_START_FAILURE = 255;
const TEMP_NAME_TEMPLATE = "XXXXXXXX";
const DEFAULT_TEMP_PREFIX = "pi-";
// endregion: constants

// region: paths
/** Resolves a POSIX path against `cwd` and removes `.` and `..` segments. */
export function resolvePosixPath(cwd: string, path: string): string {
  const joined = path.startsWith(PATH_SEPARATOR) ? path : `${cwd}${PATH_SEPARATOR}${path}`;
  const segments: string[] = [];
  for (const segment of joined.split(PATH_SEPARATOR)) {
    if (segment === "" || segment === CURRENT_SEGMENT) continue;
    if (segment === PARENT_SEGMENT) segments.pop();
    else segments.push(segment);
  }
  return `${PATH_SEPARATOR}${segments.join(PATH_SEPARATOR)}`;
}

/** Joins path parts as `path.posix.join` does: empty parts go away, and the result is normalized. */
export function joinPosixPath(parts: readonly string[]): string {
  const joined = parts.filter((part) => part !== "").join(PATH_SEPARATOR);
  if (joined === "") return CURRENT_SEGMENT;
  const absolute = joined.startsWith(PATH_SEPARATOR);
  const segments: string[] = [];
  for (const segment of joined.split(PATH_SEPARATOR)) {
    if (segment === "" || segment === CURRENT_SEGMENT) continue;
    if (segment === PARENT_SEGMENT && segments.length > 0 && segments.at(-1) !== PARENT_SEGMENT) segments.pop();
    else if (segment !== PARENT_SEGMENT || !absolute) segments.push(segment);
  }
  const body = segments.join(PATH_SEPARATOR);
  if (absolute) return `${PATH_SEPARATOR}${body}`;
  return body === "" ? CURRENT_SEGMENT : body;
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf(PATH_SEPARATOR) + 1);
}
// endregion: paths

// region: errors
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

function toFileError(error: unknown, path: string): FileError {
  if (error instanceof FileError) return error;
  if (isAbort(error)) return new FileError("aborted", "aborted", path);
  if (isFileNotFound(error)) {
    return new FileError("not_found", `No such file or directory: ${path}`, path, error as Error);
  }
  const cause = error instanceof Error ? error : new Error(String(error));
  return new FileError("unknown", cause.message, path, cause);
}

function notFound(path: string): FileError {
  return new FileError("not_found", `No such file or directory: ${path}`, path);
}

function notSupported(operation: string, path?: string): FileError {
  return new FileError("not_supported", `${operation} is not supported in an OpenSandbox environment`, path);
}

/** Maps the message of a failed file command to an error code. */
function commandFileError(output: string, path: string): FileError {
  const message = output.trim() || `command failed for ${path}`;
  if (/No such file or directory/i.test(message)) return new FileError("not_found", message, path);
  if (/Permission denied|Operation not permitted/i.test(message))
    return new FileError("permission_denied", message, path);
  if (/Not a directory/i.test(message)) return new FileError("not_directory", message, path);
  if (/Is a directory/i.test(message)) return new FileError("is_directory", message, path);
  return new FileError("unknown", message, path);
}
// endregion: errors

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

function fileKind(info: ExecdFileInfo): FileKind | undefined {
  if (info.type === FILE_TYPE.file) return "file";
  if (info.type === FILE_TYPE.directory) return "directory";
  if (info.type === FILE_TYPE.symlink) return "symlink";
  return undefined;
}

function toFileInfo(info: ExecdFileInfo, kind: FileKind): FileInfo {
  const mtimeMs = Date.parse(info.modified_at);
  return {
    name: baseName(info.path),
    path: info.path,
    kind,
    size: info.size,
    mtimeMs: Number.isFinite(mtimeMs) ? mtimeMs : 0,
  };
}

/** A file read into memory one time, so each call sees the same bytes. */
class SnapshotBinaryReader implements BinaryReader {
  readonly #info: FileInfo;
  readonly #bytes: Uint8Array;

  constructor(info: FileInfo, bytes: Uint8Array) {
    this.#info = { ...info, size: bytes.byteLength };
    this.#bytes = bytes;
  }

  async info(_context: Context): Promise<Result<FileInfo, FileError>> {
    return ok(this.#info);
  }

  async read(offset: number, length: number, _context: Context): Promise<Result<Uint8Array, FileError>> {
    if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0) {
      return err(new FileError("invalid", "offset and length must be non-negative integers", this.#info.path));
    }
    return ok(this.#bytes.slice(offset, offset + length));
  }

  async scanLines(
    options: { startLine: number; endLine?: number },
    _context: Context,
  ): Promise<Result<LineScan, FileError>> {
    try {
      const scanner = new LineScanner(options.startLine, options.endLine);
      scanner.push(this.#bytes);
      return ok(scanner.finish());
    } catch (error) {
      return err(new FileError("invalid", error instanceof Error ? error.message : String(error), this.#info.path));
    }
  }

  async close(_context: Context): Promise<void> {}
}

class ListDirReader implements DirReader {
  readonly #entries: FileInfo[];
  #position = 0;

  constructor(entries: FileInfo[]) {
    this.#entries = entries;
  }

  async next(
    maxEntries: number,
    _context: Context,
  ): Promise<Result<{ entries: FileInfo[]; done: boolean }, FileError>> {
    const entries = this.#entries.slice(this.#position, this.#position + Math.max(1, maxEntries));
    this.#position += entries.length;
    return ok({ entries, done: this.#position >= this.#entries.length });
  }

  async close(_context: Context): Promise<void> {}
}

class ArrayTextLineReader implements TextLineReader {
  readonly #lines: string[];
  readonly #lastTerminated: boolean;
  #position = 0;

  constructor(text: string) {
    this.#lines = text.split(NEWLINE);
    this.#lastTerminated = text.endsWith(NEWLINE);
    if (this.#lastTerminated) this.#lines.pop();
  }

  async readLine(_context: Context): Promise<Result<{ text: string; terminated: boolean } | undefined, FileError>> {
    const text = this.#lines[this.#position];
    if (text === undefined) return ok(undefined);
    this.#position += 1;
    const isLast = this.#position === this.#lines.length;
    return ok({ text, terminated: !isLast || this.#lastTerminated });
  }

  async close(_context: Context): Promise<void> {}
}

/** The account of the sandbox that runs the commands and owns the written files. */
export interface SandboxUser {
  name: string;
  group: string;
  uid: number;
  gid: number;
  home: string;
}

export interface OpenSandboxExecutionEnvOptions {
  execd: ExecdClient;
  sandboxId: string;
  cwd: string;
  /** Absent: the user of the execd daemon, which is root in most images. */
  user?: SandboxUser;
  /** Variables of each command. The variables of one call go on top of them. */
  baseEnv?: Readonly<Record<string, string>>;
}

/** How to continue with a command that an earlier call of `execDetached` started. */
export interface DetachedCommand {
  id: string;
  /** Wall-clock time of the start, for the timeout of the caller. */
  startedAt: number;
}

export interface ExecDetachedOptions extends ShellExecOptions {
  /** The command that an interrupted call started. The environment follows it and does not start a new one. */
  attach?: DetachedCommand;
  /** Called with the command after the start, before the first output. */
  onStart?: (command: DetachedCommand) => void | Promise<void>;
}

export class OpenSandboxExecutionEnv implements ExecutionEnv {
  readonly id: string;
  cwd: string;
  readonly #execd: ExecdClient;
  readonly #options: OpenSandboxExecutionEnvOptions;

  constructor(options: OpenSandboxExecutionEnvOptions) {
    this.id = `${ENV_ID_PREFIX}${options.sandboxId}`;
    this.cwd = options.cwd;
    this.#execd = options.execd;
    this.#options = options;
  }

  /** The same sandbox as the user of the execd daemon, for the setup steps that need root. */
  asDaemonUser(cwd: string = this.cwd): OpenSandboxExecutionEnv {
    return new OpenSandboxExecutionEnv({ execd: this.#execd, sandboxId: this.#options.sandboxId, cwd });
  }

  #commandEnv(callEnv: Record<string, string> | undefined): Record<string, string> | undefined {
    const user = this.#options.user;
    const identity: Record<string, string> =
      user === undefined ? {} : { HOME: user.home, USER: user.name, LOGNAME: user.name };
    const merged: Record<string, string> = { ...identity, ...this.#options.baseEnv, ...callEnv };
    return Object.keys(merged).length === 0 ? undefined : merged;
  }

  #owner(): { user: string; group: string } | undefined {
    const user = this.#options.user;
    return user === undefined ? undefined : { user: user.name, group: user.group };
  }

  // region: shell
  exec(
    command: string | readonly string[],
    options: ShellExecOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    return this.execDetached(command, options, context);
  }

  /**
   * Runs a command as a detached process of the sandbox and follows its output with short requests. The process does
   * not depend on this worker, so a caller that keeps the command id can follow the same process after a restart.
   * execd writes stdout and stderr to one file, so each chunk is reported as stdout.
   */
  async execDetached(
    command: string | readonly string[],
    options: ExecDetachedOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    if (signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
    let timeoutMs: number | undefined;
    if (options?.timeout !== undefined) {
      timeoutMs = options.timeout * MS_PER_SECOND;
      if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) {
        return err(new ExecutionError("timeout", "Invalid timeout: must be a finite number of seconds"));
      }
    }

    let running = options?.attach;
    if (running === undefined) {
      const isArgv = typeof command !== "string";
      const envs = this.#commandEnv(options?.env);
      const user = this.#options.user;
      try {
        const id = await this.#execd.startCommand(
          {
            ...(isArgv ? { argv: command } : { command }),
            cwd: options?.cwd ?? this.cwd,
            ...(envs === undefined ? {} : { envs }),
            ...(timeoutMs === undefined ? {} : { timeoutMs }),
            ...(user === undefined ? {} : { uid: user.uid, gid: user.gid }),
          },
          signal,
        );
        running = { id, startedAt: Date.now() };
      } catch (error) {
        if (isAbort(error) && signal?.aborted) return err(new ExecutionError("aborted", "aborted"));
        const cause = error instanceof Error ? error : new Error(String(error));
        return err(new ExecutionError(isArgv ? "spawn_error" : "unknown", cause.message, cause));
      }
      try {
        await options?.onStart?.(running);
      } catch (error) {
        await this.#execd.interruptCommand(running.id).catch(() => {});
        const cause = error instanceof Error ? error : new Error(String(error));
        return err(new ExecutionError("callback_error", cause.message, cause));
      }
    }
    const attached = options?.attach !== undefined;
    return this.#follow(running, attached, typeof command !== "string", timeoutMs, options, context);
  }

  async #follow(
    command: DetachedCommand,
    attached: boolean,
    isArgv: boolean,
    timeoutMs: number | undefined,
    options: ExecDetachedOptions | undefined,
    context: Context,
  ): Promise<Result<ShellExecResult, ExecutionError>> {
    const signal = context.abortSignal;
    const decoder = new TextDecoder();
    const kept: Uint8Array[] = [];
    let keptBytes = 0;
    let totalBytes = 0;
    let totalLines = 0;
    let cursor = 0;
    let pause = POLL_MIN_MS;
    let failures = 0;
    if (attached) {
      // The command can have a large output from before the restart. The caller keeps the tail only.
      const size = await this.#execd.commandLogSize(command.id, signal).catch(() => 0);
      cursor = Math.max(0, size - ATTACH_TAIL_BYTES);
    }

    const emit = (bytes: Uint8Array, last: boolean): ExecutionError | undefined => {
      totalBytes += bytes.byteLength;
      if (keptBytes < SPILL_MAX_BYTES && bytes.byteLength > 0) {
        kept.push(bytes);
        keptBytes += bytes.byteLength;
      }
      const text = decoder.decode(bytes, { stream: !last });
      if (text === "") return undefined;
      for (let index = text.indexOf(NEWLINE); index !== -1; index = text.indexOf(NEWLINE, index + 1)) totalLines += 1;
      try {
        options?.onOutput?.(text, context, { stream: "stdout" });
      } catch (error) {
        const cause = error instanceof Error ? error : new Error(String(error));
        return new ExecutionError("callback_error", cause.message, cause);
      }
      return undefined;
    };

    const spill = async (): Promise<string | undefined> => {
      const limits = options?.spill;
      if (limits === undefined) return undefined;
      if (totalBytes <= limits.afterBytes && totalLines <= limits.afterLines) return undefined;
      const path = `${SPILL_DIRECTORY}/${SPILL_FILE_PREFIX}${command.id}${SPILL_FILE_SUFFIX}`;
      const content = new Uint8Array(keptBytes);
      let offset = 0;
      for (const chunk of kept) {
        content.set(chunk, offset);
        offset += chunk.byteLength;
      }
      try {
        await this.#execd.upload(path, content, { isNew: true, owner: this.#owner() });
        return path;
      } catch {
        return undefined;
      }
    };

    const fail = async (
      code: ExecutionError["code"],
      message: string,
    ): Promise<Result<ShellExecResult, ExecutionError>> => {
      const error = new ExecutionError(code, message);
      const spillPath = await spill();
      if (spillPath !== undefined) error.spillPath = spillPath;
      return err(error);
    };

    for (;;) {
      if (signal?.aborted) {
        await this.#execd.interruptCommand(command.id).catch(() => {});
        return fail("aborted", "aborted");
      }
      let finished: { exitCode: number; error?: string } | undefined;
      try {
        // Read the status first: when it says that the command ended, the log read that follows has all the output.
        const status = await this.#execd.commandStatus(command.id, signal);
        const logs = await this.#execd.commandLogs(command.id, cursor, signal);
        failures = 0;
        if (!status.running) finished = { exitCode: status.exit_code ?? EXIT_CODE_UNKNOWN, error: status.error };
        if (logs.bytes.byteLength > 0 || finished !== undefined) {
          cursor = logs.cursor;
          const callbackError = emit(logs.bytes, finished !== undefined);
          if (callbackError !== undefined) {
            await this.#execd.interruptCommand(command.id).catch(() => {});
            return err(callbackError);
          }
        }
        pause = logs.bytes.byteLength > 0 ? POLL_MIN_MS : Math.min(pause * POLL_BACKOFF, POLL_MAX_MS);
      } catch (error) {
        if (signal?.aborted) continue;
        if (error instanceof SandboxApiError && error.status === HTTP_STATUS.notFound) {
          // The answer comes from execd, or from the proxy of the server while the sandbox has no pod address.
          return fail("unknown", `The sandbox lost command ${command.id}; its pod started again: ${error.message}`);
        }
        failures += 1;
        if (failures > POLL_MAX_FAILURES) {
          const message = error instanceof Error ? error.message : String(error);
          return fail("unknown", `Lost the connection to the sandbox: ${message}`);
        }
        pause = POLL_FAILURE_PAUSE_MS;
      }

      const elapsedMs = Date.now() - command.startedAt;
      const timedOut = timeoutMs !== undefined && elapsedMs >= timeoutMs;
      if (finished !== undefined) {
        // execd kills a command at its timeout. A command that ends by itself near the deadline is not a timeout.
        const killed = finished.exitCode < 0 || KILLED_ERROR_PATTERN.test(finished.error ?? "");
        const nearDeadline = timeoutMs !== undefined && elapsedMs >= timeoutMs - TIMEOUT_MARGIN_MS;
        if (killed && nearDeadline) return fail("timeout", `timeout after ${options?.timeout} seconds`);
        if (isArgv && finished.exitCode === EXIT_CODE_START_FAILURE && totalBytes === 0 && finished.error) {
          return fail("spawn_error", finished.error);
        }
        const spillPath = await spill();
        return ok({ exitCode: finished.exitCode, ...(spillPath === undefined ? {} : { spillPath }) });
      }
      if (timedOut) {
        await this.#execd.interruptCommand(command.id).catch(() => {});
        return fail("timeout", `timeout after ${options?.timeout} seconds`);
      }
      await sleep(pause, signal);
    }
  }

  /** Runs a program without a shell and returns its output. */
  async #run(argv: readonly string[], context: Context): Promise<{ exitCode: number; output: string }> {
    let output = "";
    const result = await this.execDetached(
      argv,
      {
        cwd: PATH_SEPARATOR,
        onOutput: (text) => {
          output += text;
        },
      },
      context,
    );
    if (!result.ok) throw result.error;
    return { exitCode: result.value.exitCode, output };
  }

  async #runFileCommand(argv: readonly string[], path: string, context: Context): Promise<Result<string, FileError>> {
    try {
      const { exitCode, output } = await this.#run(argv, context);
      if (exitCode !== 0) return err(commandFileError(output, path));
      return ok(output);
    } catch (error) {
      if (error instanceof ExecutionError && error.code === "aborted") {
        return err(new FileError("aborted", "aborted", path));
      }
      return err(toFileError(error, path));
    }
  }
  // endregion: shell

  // region: paths
  async absolutePath(path: string, _context: Context): Promise<Result<string, FileError>> {
    return ok(resolvePosixPath(this.cwd, path));
  }

  async joinPath(parts: string[], _context: Context): Promise<Result<string, FileError>> {
    return ok(joinPosixPath(parts));
  }

  async canonicalPath(path: string, context: Context): Promise<Result<string, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    const result = await this.#runFileCommand(["realpath", "-e", "--", resolved], resolved, context);
    return result.ok ? ok(result.value.replace(/\r?\n$/, "")) : result;
  }
  // endregion: paths

  // region: read
  async fileInfo(path: string, context: Context): Promise<Result<FileInfo, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    try {
      const info = await this.#execd.fileInfo(resolved, context.abortSignal);
      if (info === undefined) return err(notFound(resolved));
      const kind = fileKind(info);
      if (kind === undefined)
        return err(new FileError("invalid", `Not a file, directory, or link: ${resolved}`, resolved));
      return ok(toFileInfo({ ...info, path: resolved }, kind));
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async exists(path: string, context: Context): Promise<Result<boolean, FileError>> {
    const result = await this.fileInfo(path, context);
    if (result.ok) return ok(true);
    return result.error.code === "not_found" ? ok(false) : err(result.error);
  }

  async readBinaryFile(path: string, context: Context): Promise<Result<Uint8Array, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    try {
      const bytes = await this.#execd.download(resolved, undefined, context.abortSignal);
      if (bytes !== undefined) return ok(bytes);
      return err(notFound(resolved));
    } catch (error) {
      // execd answers a directory with an error status; a file info read gives the exact reason.
      const info = await this.fileInfo(resolved, context);
      if (info.ok && info.value.kind === "directory") {
        return err(new FileError("is_directory", `Is a directory: ${resolved}`, resolved));
      }
      return err(toFileError(error, resolved));
    }
  }

  async readTextFile(path: string, context: Context): Promise<Result<string, FileError>> {
    const result = await this.readBinaryFile(path, context);
    // The edit tool reads the byte-order mark to write it back, so the decoder must keep it.
    return result.ok ? ok(new TextDecoder(TEXT_ENCODING, { ignoreBOM: true }).decode(result.value)) : result;
  }

  async readTextLines(
    path: string,
    options: { maxLines?: number } | undefined,
    context: Context,
  ): Promise<Result<string[], FileError>> {
    const result = await this.readTextFile(path, context);
    if (!result.ok) return result;
    const lines = result.value.split(NEWLINE);
    if (result.value.endsWith(NEWLINE)) lines.pop();
    return ok(options?.maxLines === undefined ? lines : lines.slice(0, options.maxLines));
  }

  async openTextLineReader(path: string, context: Context): Promise<Result<TextLineReader, FileError>> {
    const result = await this.readTextFile(path, context);
    return result.ok ? ok(new ArrayTextLineReader(result.value)) : result;
  }

  async openBinaryReader(
    path: string,
    options: { noFollow?: boolean } | undefined,
    context: Context,
  ): Promise<Result<BinaryReader, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    let info = await this.fileInfo(resolved, context);
    if (!info.ok) return info;
    if (info.value.kind === "symlink") {
      if (options?.noFollow) return err(new FileError("invalid", `Is a symbolic link: ${resolved}`, resolved));
      const target = await this.canonicalPath(resolved, context);
      if (!target.ok) return target;
      info = await this.fileInfo(target.value, context);
      if (!info.ok) return info;
    }
    if (info.value.kind === "directory")
      return err(new FileError("is_directory", `Is a directory: ${resolved}`, resolved));
    if (info.value.kind !== "file") return err(new FileError("invalid", `Not a regular file: ${resolved}`, resolved));
    if (info.value.size > READER_MAX_BYTES) {
      return err(new FileError("invalid", `File is larger than ${READER_MAX_BYTES} bytes: ${resolved}`, resolved));
    }
    const bytes = await this.readBinaryFile(info.value.path, context);
    if (!bytes.ok) return bytes;
    return ok(new SnapshotBinaryReader({ ...info.value, name: baseName(resolved), path: resolved }, bytes.value));
  }

  async listDir(path: string, context: Context): Promise<Result<FileInfo[], FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    const info = await this.fileInfo(resolved, context);
    if (!info.ok) return info;
    if (info.value.kind !== "directory") {
      return err(new FileError("not_directory", `Not a directory: ${resolved}`, resolved));
    }
    try {
      const entries = await this.#execd.listDirectory(resolved, context.abortSignal);
      const result: FileInfo[] = [];
      for (const entry of entries) {
        const kind = fileKind(entry);
        if (kind !== undefined) result.push(toFileInfo(entry, kind));
      }
      return ok(result);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async openDirReader(path: string, context: Context): Promise<Result<DirReader, FileError>> {
    const result = await this.listDir(path, context);
    return result.ok ? ok(new ListDirReader(result.value)) : result;
  }
  // endregion: read

  // region: write
  async writeFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    try {
      const existing = await this.#execd.fileInfo(resolved, context.abortSignal);
      if (existing?.type === FILE_TYPE.directory) {
        return err(new FileError("is_directory", `Is a directory: ${resolved}`, resolved));
      }
      const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
      const upload = { isNew: existing === undefined, owner: this.#owner() };
      await this.#execd.upload(resolved, bytes, upload, context.abortSignal);
      return ok(undefined);
    } catch (error) {
      return err(toFileError(error, resolved));
    }
  }

  async appendFile(path: string, content: string | Uint8Array, context: Context): Promise<Result<void, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    const current = await this.readBinaryFile(resolved, context);
    if (!current.ok && current.error.code !== "not_found") return current;
    const head = current.ok ? current.value : new Uint8Array(0);
    const tail = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const joined = new Uint8Array(head.byteLength + tail.byteLength);
    joined.set(head, 0);
    joined.set(tail, head.byteLength);
    return this.writeFile(resolved, joined, context);
  }

  async truncateFile(path: string, size: number, context: Context): Promise<Result<void, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    if (!Number.isInteger(size) || size < 0) {
      return err(new FileError("invalid", "size must be a non-negative integer", resolved));
    }
    const result = await this.#runFileCommand(["truncate", "-s", String(size), "--", resolved], resolved, context);
    return result.ok ? ok(undefined) : result;
  }

  /** execd syncs a file after each upload, so there is nothing more to flush. */
  async flushFile(path: string, context: Context): Promise<Result<void, FileError>> {
    const info = await this.fileInfo(path, context);
    return info.ok ? ok(undefined) : info;
  }

  async renameFile(sourcePath: string, destinationPath: string, context: Context): Promise<Result<void, FileError>> {
    const source = resolvePosixPath(this.cwd, sourcePath);
    const destination = resolvePosixPath(this.cwd, destinationPath);
    // `mv` replaces a destination that exists, as a rename does. The move call of execd refuses that.
    const result = await this.#runFileCommand(["mv", "-f", "--", source, destination], source, context);
    return result.ok ? ok(undefined) : result;
  }

  async createDir(
    path: string,
    options: { recursive?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    const argv = options?.recursive ? ["mkdir", "-p", "--", resolved] : ["mkdir", "--", resolved];
    const result = await this.#runFileCommand(argv, resolved, context);
    return result.ok ? ok(undefined) : result;
  }

  async remove(
    path: string,
    options: { recursive?: boolean; force?: boolean } | undefined,
    context: Context,
  ): Promise<Result<void, FileError>> {
    const resolved = resolvePosixPath(this.cwd, path);
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    const argv = flags === "" ? ["rm", "-d", "--", resolved] : ["rm", `-${flags}`, "--", resolved];
    const result = await this.#runFileCommand(argv, resolved, context);
    return result.ok ? ok(undefined) : result;
  }

  async createTempDir(prefix: string | undefined, context: Context): Promise<Result<string, FileError>> {
    const template = `${SPILL_DIRECTORY}/${prefix ?? DEFAULT_TEMP_PREFIX}${TEMP_NAME_TEMPLATE}`;
    const result = await this.#runFileCommand(["mktemp", "-d", template], template, context);
    return result.ok ? ok(result.value.trim()) : result;
  }

  async createTempFile(
    options: { prefix?: string; suffix?: string } | undefined,
    context: Context,
  ): Promise<Result<string, FileError>> {
    const template = `${SPILL_DIRECTORY}/${options?.prefix ?? DEFAULT_TEMP_PREFIX}${TEMP_NAME_TEMPLATE}`;
    const argv = ["mktemp", ...(options?.suffix ? [`--suffix=${options.suffix}`] : []), template];
    const result = await this.#runFileCommand(argv, template, context);
    return result.ok ? ok(result.value.trim()) : result;
  }
  // endregion: write

  /** The sandbox has no change notification that reaches the worker. */
  async watch(
    targets: readonly WatchTarget[],
    _onChange: (change: WatchChange) => void,
    _context: Context,
  ): Promise<Result<FileWatcher, FileError>> {
    return err(notSupported("watch", targets[0]?.path));
  }

  /** The sandbox belongs to the feature, not to one tool call, so there is nothing to stop here. */
  async cleanup(_context: Context): Promise<void> {}
}
