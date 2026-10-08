// The sandbox of one feature: how the worker finds it, makes it, and prepares it. Each step is safe to run again,
// because a pod of the worker or of the sandbox can go away at any time.
import type { Context } from "@earendil-works/chord";
import type { SandboxConfig } from "../config.ts";
import { MS_PER_SECOND, SANDBOX_FEATURE_LABEL, SECONDS_PER_MINUTE } from "../constants.ts";
import type { FeatureSpec } from "../pipeline/docs.ts";
import {
  featureBranch,
  PREPARED_MARKER_PATH,
  REPO_PATH,
  SANDBOX_HOME_PATH,
  SETUP_DIRECTORY,
  WORKSPACE_PATH,
} from "../pipeline/roles.ts";
import { type CreateSandboxRequest, SANDBOX_STATE, type SandboxClient, type SandboxInfo } from "./client.ts";
import { OpenSandboxExecutionEnv, type SandboxUser } from "./execution-env.ts";

// region: constants
/** The account that runs the agent commands. Some programs, memcached for example, refuse to run as root. */
export const SANDBOX_USER: SandboxUser = {
  name: "dev",
  group: "dev",
  uid: 1000,
  gid: 1000,
  home: SANDBOX_HOME_PATH,
};

const WORKSPACE_VOLUME_NAME = "workspace";
const WORKSPACE_CLAIM_PREFIX = "workspace-";
const WORKSPACE_ACCESS_MODE = "ReadWriteOnce";
const SANDBOX_OS = "linux";
/** The sandbox only has to stay alive; execd runs the commands. */
const SANDBOX_ENTRYPOINT = ["tail", "-f", "/dev/null"];
const BASE_COMMIT_FILE = `${SETUP_DIRECTORY}/base-commit`;
const SETUP_LOCK_FILE = `${SETUP_DIRECTORY}/setup.lock`;
const ROOT_SETUP_FILE = `${SETUP_DIRECTORY}/root-setup.sh`;
const USER_SETUP_FILE = `${SETUP_DIRECTORY}/user-setup.sh`;
const GIT_IDENTITY = { name: "pi-agent-celld-spike", email: "pi-agent-celld-spike@localhost" } as const;

const EXECD_WAIT_MS = 5 * SECONDS_PER_MINUTE * MS_PER_SECOND;
const EXECD_POLL_MS = 2 * MS_PER_SECOND;
const SHORT_SCRIPT_TIMEOUT_SECONDS = 2 * SECONDS_PER_MINUTE;
const CLONE_TIMEOUT_SECONDS = 10 * SECONDS_PER_MINUTE;
const SETUP_TIMEOUT_SECONDS = 20 * SECONDS_PER_MINUTE;
/** How much of the output of a failed script goes into the error message. */
const ERROR_OUTPUT_TAIL_CHARS = 2000;

const USABLE_STATES: readonly string[] = [SANDBOX_STATE.pending, SANDBOX_STATE.allocated, SANDBOX_STATE.running];
// endregion: constants

// region: scripts
/**
 * Each setup script takes this lock first. A setup command is a detached process of the sandbox: it continues when
 * the worker goes away, and the new worker then starts the same script again. With the lock, the second copy waits
 * for the first one and then finds the work done. The lock file is opened for reading, which each user can do.
 */
const TAKE_SETUP_LOCK = `exec 9<${SETUP_LOCK_FILE}
flock 9`;

/**
 * `--non-unique` lets the account share uid 1000 with an account of the image, for example `ubuntu` or `node`. The
 * upload API of execd finds the owner of a file by name, so the name must exist.
 */
const BOOTSTRAP_SCRIPT = `set -eu
mkdir -p ${SETUP_DIRECTORY}
touch ${SETUP_LOCK_FILE}
${TAKE_SETUP_LOCK}
getent group ${SANDBOX_USER.group} >/dev/null 2>&1 || groupadd --non-unique --gid ${SANDBOX_USER.gid} ${SANDBOX_USER.group}
id -u ${SANDBOX_USER.name} >/dev/null 2>&1 || useradd --non-unique --uid ${SANDBOX_USER.uid} --gid ${SANDBOX_USER.gid} --home-dir ${SANDBOX_USER.home} --no-create-home --shell /bin/bash ${SANDBOX_USER.name}
mkdir -p ${SANDBOX_USER.home}
chown ${SANDBOX_USER.uid}:${SANDBOX_USER.gid} ${WORKSPACE_PATH} ${SANDBOX_USER.home} ${SETUP_DIRECTORY}
`;

/**
 * Reads REPO_URL, BRANCH, and REF from the environment, so no value of the caller is part of the shell text.
 * A clone that stopped in the middle has no valid HEAD and is made again. A new clone gets its final name only
 * when it is complete.
 */
export const CLONE_SCRIPT = `set -eu
${TAKE_SETUP_LOCK}
if [ -d repo ] && ! git -C repo rev-parse --verify --quiet HEAD >/dev/null 2>&1; then
  rm -rf repo
fi
if [ ! -d repo ]; then
  rm -rf repo.partial
  git clone --quiet "$REPO_URL" repo.partial
  mv repo.partial repo
fi
cd repo
git config user.name "${GIT_IDENTITY.name}"
git config user.email "${GIT_IDENTITY.email}"
if git rev-parse --verify --quiet "refs/heads/$BRANCH" >/dev/null; then
  git checkout --quiet "$BRANCH"
else
  start=""
  if [ -n "$REF" ]; then
    if git rev-parse --verify --quiet "refs/remotes/origin/$REF" >/dev/null; then start="origin/$REF"; else start="$REF"; fi
  fi
  git checkout --quiet -b "$BRANCH" $start
fi
# The agents make no commit, so the head of the branch is the commit that the feature starts from.
[ -s "${BASE_COMMIT_FILE}" ] || git rev-parse HEAD > "${BASE_COMMIT_FILE}"
`;

function lockedSetup(file: string): string {
  return `${TAKE_SETUP_LOCK}\nbash -eu ${file}`;
}

const COLLECT_STATUS_SCRIPT = "git add --all && git status --short";
const COLLECT_PATCH_SCRIPT = `git diff --cached "$(cat ${BASE_COMMIT_FILE})"`;
// endregion: scripts

export function isUsable(sandbox: SandboxInfo): boolean {
  return USABLE_STATES.includes(sandbox.status.state);
}

export function workspaceClaimName(feature: string): string {
  return `${WORKSPACE_CLAIM_PREFIX}${feature}`;
}

export function createRequest(spec: FeatureSpec, config: SandboxConfig): CreateSandboxRequest {
  return {
    image: { uri: config.image },
    entrypoint: [...SANDBOX_ENTRYPOINT],
    // No expiry: the feature owns the sandbox until someone deletes the feature.
    timeout: null,
    resourceLimits: { cpu: config.cpuLimit, memory: config.memoryLimit },
    resourceRequests: { cpu: config.cpuRequest, memory: config.memoryRequest },
    metadata: { [SANDBOX_FEATURE_LABEL]: spec.name },
    platform: { os: SANDBOX_OS, arch: config.arch },
    volumes: [
      {
        name: WORKSPACE_VOLUME_NAME,
        mountPath: WORKSPACE_PATH,
        readOnly: false,
        pvc: {
          claimName: workspaceClaimName(spec.name),
          createIfNotExists: true,
          // The checkout must outlive the sandbox, so a new sandbox of the feature finds the same files.
          deleteOnSandboxTermination: false,
          ...(config.workspaceStorageClass === "" ? {} : { storageClass: config.workspaceStorageClass }),
          storage: config.workspaceSize,
          accessModes: [WORKSPACE_ACCESS_MODE],
        },
      },
    ],
  };
}

export interface SandboxProvisionerOptions {
  sandboxes: SandboxClient;
  config: SandboxConfig;
}

export interface ScriptResult {
  exitCode: number;
  output: string;
}

function pause(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export class SandboxProvisioner {
  readonly #sandboxes: SandboxClient;
  readonly #config: SandboxConfig;
  // The pipeline and the tools can ask for the same sandbox at the same moment. Each call that arrives while the
  // work runs gets the result of that work, so there is one create request and one setup run.
  readonly #ensuring = new Map<string, Promise<{ sandbox: SandboxInfo; created: boolean }>>();
  readonly #preparing = new Map<string, Promise<void>>();

  constructor(options: SandboxProvisionerOptions) {
    this.#sandboxes = options.sandboxes;
    this.#config = options.config;
  }

  /** The environment of the agent commands of a feature: the sandbox user, in the repository by default. */
  openEnv(sandboxId: string, spec: FeatureSpec, cwd: string = REPO_PATH): OpenSandboxExecutionEnv {
    return new OpenSandboxExecutionEnv({
      execd: this.#sandboxes.execd(sandboxId),
      sandboxId,
      cwd,
      user: SANDBOX_USER,
      baseEnv: spec.env,
    });
  }

  /**
   * Finds the sandbox of the feature or makes one, and waits until its command daemon answers. `known` is the id
   * that the feature recorded. A sandbox in a failed state is removed first; its volume stays.
   */
  ensureSandbox(
    spec: FeatureSpec,
    known: string | undefined,
    signal: AbortSignal,
  ): Promise<{ sandbox: SandboxInfo; created: boolean }> {
    let running = this.#ensuring.get(spec.name);
    if (running === undefined) {
      running = this.#findOrCreate(spec, known, signal).finally(() => this.#ensuring.delete(spec.name));
      this.#ensuring.set(spec.name, running);
    }
    return running;
  }

  async #findOrCreate(
    spec: FeatureSpec,
    known: string | undefined,
    signal: AbortSignal,
  ): Promise<{ sandbox: SandboxInfo; created: boolean }> {
    let sandbox = known === undefined ? undefined : await this.#sandboxes.get(known);
    if (sandbox !== undefined && !isUsable(sandbox)) {
      await this.#sandboxes.delete(sandbox.id);
      sandbox = undefined;
    }
    if (sandbox === undefined) {
      // A create can succeed while its answer gets lost, so look for a sandbox with the label of the feature.
      for (const candidate of await this.#sandboxes.findByMetadata({ [SANDBOX_FEATURE_LABEL]: spec.name })) {
        if (sandbox === undefined && isUsable(candidate)) sandbox = candidate;
        else await this.#sandboxes.delete(candidate.id);
      }
    }
    let created = false;
    if (sandbox === undefined) {
      sandbox = await this.#sandboxes.create(createRequest(spec, this.#config));
      created = true;
    }
    await this.#waitForExecd(sandbox.id, signal);
    return { sandbox, created };
  }

  async #waitForExecd(sandboxId: string, signal: AbortSignal): Promise<void> {
    const execd = this.#sandboxes.execd(sandboxId);
    const deadline = Date.now() + EXECD_WAIT_MS;
    while (!(await execd.ping(signal))) {
      if (signal.aborted) throw new Error("aborted");
      if (Date.now() > deadline) throw new Error(`The command daemon of sandbox ${sandboxId} did not answer in time`);
      await pause(EXECD_POLL_MS, signal);
    }
  }

  /**
   * `ready`: the sandbox runs and has the setup. `unprepared`: it runs, but a new pod lost the setup. `missing`: there
   * is no usable sandbox.
   */
  async state(sandboxId: string | undefined, signal: AbortSignal): Promise<"ready" | "unprepared" | "missing"> {
    if (sandboxId === undefined) return "missing";
    const sandbox = await this.#sandboxes.get(sandboxId);
    if (sandbox === undefined || !isUsable(sandbox)) return "missing";
    const execd = this.#sandboxes.execd(sandboxId);
    if (!(await execd.ping(signal))) return "unprepared";
    return (await execd.fileInfo(PREPARED_MARKER_PATH, signal)) === undefined ? "unprepared" : "ready";
  }

  /**
   * Makes the sandbox of the feature ready for a command, from each state that it can be in, and returns its id.
   * `record` stores the id of a sandbox that is new for the feature. The tools call this before each command, so a
   * sandbox that got a new pod in the middle of an agent turn gets its setup back before the next command.
   */
  async ensureReady(
    spec: FeatureSpec,
    known: string | undefined,
    context: Context,
    record: (sandboxId: string) => Promise<void>,
  ): Promise<string> {
    const signal = context.abortSignal ?? new AbortController().signal;
    const state = await this.state(known, signal);
    if (state === "ready" && known !== undefined) return known;
    let sandboxId = known;
    if (state === "missing" || sandboxId === undefined) {
      sandboxId = (await this.ensureSandbox(spec, known, signal)).sandbox.id;
      if (sandboxId !== known) await record(sandboxId);
    } else {
      await this.#waitForExecd(sandboxId, signal);
    }
    await this.prepare(sandboxId, spec, context, () => {});
    return sandboxId;
  }

  /** Makes the sandbox user, the checkout on the feature branch, and the tools of the project. Safe to run again. */
  prepare(sandboxId: string, spec: FeatureSpec, context: Context, log: (line: string) => void): Promise<void> {
    let running = this.#preparing.get(sandboxId);
    if (running === undefined) {
      running = this.#runSetup(sandboxId, spec, context, log).finally(() => this.#preparing.delete(sandboxId));
      this.#preparing.set(sandboxId, running);
    }
    return running;
  }

  async #runSetup(sandboxId: string, spec: FeatureSpec, context: Context, log: (line: string) => void): Promise<void> {
    const user = this.openEnv(sandboxId, spec, WORKSPACE_PATH);
    const root = user.asDaemonUser(WORKSPACE_PATH);

    await this.#mustRun(root, BOOTSTRAP_SCRIPT, "create the sandbox user", SHORT_SCRIPT_TIMEOUT_SECONDS, context);
    log("the sandbox user exists");

    const cloneEnv = { REPO_URL: spec.repo, BRANCH: featureBranch(spec.name), REF: spec.ref };
    await this.#mustRun(user, CLONE_SCRIPT, "clone the repository", CLONE_TIMEOUT_SECONDS, context, cloneEnv);
    log(`the checkout is on ${cloneEnv.BRANCH}`);

    if (spec.rootSetup.trim() !== "") {
      await this.#writeScript(root, ROOT_SETUP_FILE, spec.rootSetup, context);
      const rootInRepo = user.asDaemonUser(REPO_PATH);
      await this.#mustRun(
        rootInRepo,
        lockedSetup(ROOT_SETUP_FILE),
        "run the root setup",
        SETUP_TIMEOUT_SECONDS,
        context,
      );
      log("the root setup ran");
    }
    if (spec.userSetup.trim() !== "") {
      await this.#writeScript(user, USER_SETUP_FILE, spec.userSetup, context);
      const userInRepo = this.openEnv(sandboxId, spec, REPO_PATH);
      await this.#mustRun(
        userInRepo,
        lockedSetup(USER_SETUP_FILE),
        "run the user setup",
        SETUP_TIMEOUT_SECONDS,
        context,
      );
      log("the user setup ran");
    }
    await this.#mustRun(
      root,
      `touch ${PREPARED_MARKER_PATH}`,
      "mark the sandbox",
      SHORT_SCRIPT_TIMEOUT_SECONDS,
      context,
    );
  }

  /** The change of the feature branch against its start, with new files included. */
  async collectChange(
    sandboxId: string,
    spec: FeatureSpec,
    context: Context,
  ): Promise<{ status: string; patch: string }> {
    const env = this.openEnv(sandboxId, spec, REPO_PATH);
    const status = await this.#mustRun(
      env,
      COLLECT_STATUS_SCRIPT,
      "read the git status",
      SHORT_SCRIPT_TIMEOUT_SECONDS,
      context,
    );
    const patch = await this.#mustRun(
      env,
      COLLECT_PATCH_SCRIPT,
      "read the git diff",
      SHORT_SCRIPT_TIMEOUT_SECONDS,
      context,
    );
    return { status: status.output, patch: patch.output };
  }

  async delete(sandboxId: string): Promise<void> {
    await this.#sandboxes.delete(sandboxId);
  }

  async #writeScript(env: OpenSandboxExecutionEnv, path: string, content: string, context: Context): Promise<void> {
    const result = await env.writeFile(path, content.endsWith("\n") ? content : `${content}\n`, context);
    if (!result.ok) throw result.error;
  }

  async #mustRun(
    env: OpenSandboxExecutionEnv,
    script: string,
    action: string,
    timeoutSeconds: number,
    context: Context,
    variables?: Record<string, string>,
  ): Promise<ScriptResult> {
    let output = "";
    const result = await env.exec(
      script,
      {
        timeout: timeoutSeconds,
        ...(variables === undefined ? {} : { env: variables }),
        onOutput: (text) => {
          output += text;
        },
      },
      context,
    );
    if (!result.ok) throw new Error(`Could not ${action}: ${result.error.message}`);
    if (result.value.exitCode !== 0) {
      const tail = output.slice(-ERROR_OUTPUT_TAIL_CHARS);
      throw new Error(`Could not ${action}: exit code ${result.value.exitCode}\n${tail}`);
    }
    return { exitCode: result.value.exitCode, output };
  }
}
