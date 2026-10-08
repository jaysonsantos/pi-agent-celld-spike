// Writes the Wrangler config for `celld deploy`: the config of the repository plus the `vars` of this deployment.
// celld has no secret store and keeps `vars` as plain text in the bucket, so only values that are not secret go here.
import { readFileSync, writeFileSync } from "node:fs";
import { parseArgs } from "node:util";

const FLAG = { source: "source", output: "output", vars: "vars" } as const;
const ENV = { vars: "WORKER_VARS_JSON" } as const;
const DEFAULT = { source: "wrangler.jsonc", output: "wrangler.deploy.json" } as const;
const LINE_COMMENT = /^\s*\/\//;

interface WranglerConfig {
  vars?: Record<string, string>;
  [key: string]: unknown;
}

/** The config of the repository has comments only on lines of their own. */
function parseJsonc(text: string): WranglerConfig {
  const json = text
    .split("\n")
    .filter((line) => !LINE_COMMENT.test(line))
    .join("\n");
  return JSON.parse(json) as WranglerConfig;
}

function parseVars(text: string): Record<string, string> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the vars must be a JSON object");
  }
  const vars: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    // celld accepts only string values.
    vars[name] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return vars;
}

const { values } = parseArgs({
  options: {
    [FLAG.source]: { type: "string", default: DEFAULT.source },
    [FLAG.output]: { type: "string", default: DEFAULT.output },
    [FLAG.vars]: { type: "string", default: process.env[ENV.vars] ?? "{}" },
  },
  strict: true,
});

const config = parseJsonc(readFileSync(values[FLAG.source], "utf8"));
config.vars = { ...config.vars, ...parseVars(values[FLAG.vars]) };
writeFileSync(values[FLAG.output], `${JSON.stringify(config, null, 2)}\n`);
console.log(`wrote ${values[FLAG.output]} with ${Object.keys(config.vars).length} vars`);
