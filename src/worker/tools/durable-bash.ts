// A `bash` tool that survives a restart of the worker. The built-in tool of Pi Durable is not replay-safe: after a
// crash the model only gets an `interrupted` result. In a sandbox the command runs as a detached process, so this
// tool records the command id before it reads output. After a restart, the same call finds that id and follows the
// same process to its end.
import { Type } from "@earendil-works/pi-ai";
import { defineExtension, defineTool } from "@earendil-works/pi-durable";
import { BYTES_PER_KIB } from "../constants.ts";
import { type DetachedCommand, OpenSandboxExecutionEnv } from "../sandbox/execution-env.ts";

const TOOL_NAME = "bash";
const EXTENSION_NAME = "sandbox-tools";
const MEMO_COMMAND = "sandbox-command";
/** The limits of the built-in tool: the model sees the tail of the output, and the full output goes to a file. */
const OUTPUT_MAX_LINES = 2000;
const OUTPUT_MAX_BYTES = 50 * BYTES_PER_KIB;

type CommandMemo = { id: string; startedAt: number };

const parameters = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
});

export const durableBashTool = defineTool({
  name: TOOL_NAME,
  description: `Execute a bash command in the current working directory of the sandbox. Returns combined stdout and stderr. Output is truncated to last ${OUTPUT_MAX_LINES} lines or ${OUTPUT_MAX_BYTES / BYTES_PER_KIB}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
  parameters,
  replay: "safe",
  outputLimits: { retain: "tail" },
  async execute(args, api, context) {
    const env = api.env;
    if (!(env instanceof OpenSandboxExecutionEnv)) throw new Error("No sandbox is ready for this conversation");
    const attach: DetachedCommand | undefined = (await api.memo<CommandMemo>(MEMO_COMMAND, context)) ?? undefined;
    const result = await env.execDetached(
      args.command,
      {
        cwd: env.cwd,
        ...(args.timeout === undefined ? {} : { timeout: args.timeout }),
        ...(attach === undefined ? {} : { attach }),
        onStart: async (command) => {
          await api.memo<CommandMemo>(MEMO_COMMAND, { id: command.id, startedAt: command.startedAt }, context);
        },
        onOutput: (text) => api.output(text),
        spill: { afterBytes: OUTPUT_MAX_BYTES, afterLines: OUTPUT_MAX_LINES },
      },
      context,
    );
    const spillPath = result.ok ? result.value.spillPath : result.error.spillPath;
    if (spillPath !== undefined) {
      api.diagnostic({ severity: "info", code: "full_output", message: `Full output: ${spillPath}` });
    }
    if (!result.ok) {
      if (result.error.code === "timeout") throw new Error(`Command timed out after ${args.timeout} seconds`);
      if (result.error.code === "aborted") throw new Error("Command aborted");
      throw result.error;
    }
    if (result.value.exitCode !== 0) throw new Error(`Command exited with code ${result.value.exitCode}`);
    return {};
  },
});

/** Install it after `CodingTools`: a later tool with the same name replaces the built-in `bash`. */
export const SandboxTools = defineExtension({ name: EXTENSION_NAME, tools: [durableBashTool] });
