// Settings of the gateway sidecar. Each setting is a long flag, an environment variable, and a default.
import { parseArgs } from "node:util";

const FLAG = {
  s3Listen: "s3-listen",
  s3Upstream: "s3-upstream",
  s3AccessKeyId: "s3-access-key-id",
  s3SecretAccessKey: "s3-secret-access-key",
  proxyListen: "proxy-listen",
  llmUpstream: "llm-upstream",
  llmApiKey: "llm-api-key",
  llmAuthHeader: "llm-auth-header",
  llmAuthScheme: "llm-auth-scheme",
  sandboxUpstream: "sandbox-upstream",
  sandboxApiKey: "sandbox-api-key",
  sandboxAuthHeader: "sandbox-auth-header",
} as const;

const ENV = {
  s3Listen: "GATEWAY_S3_LISTEN",
  s3Upstream: "GATEWAY_S3_UPSTREAM",
  s3AccessKeyId: "AWS_ACCESS_KEY_ID",
  s3SecretAccessKey: "AWS_SECRET_ACCESS_KEY",
  proxyListen: "GATEWAY_PROXY_LISTEN",
  llmUpstream: "LLM_BASE_URL",
  llmApiKey: "LLM_API_KEY",
  llmAuthHeader: "LLM_AUTH_HEADER",
  llmAuthScheme: "LLM_AUTH_SCHEME",
  sandboxUpstream: "SANDBOX_BASE_URL",
  sandboxApiKey: "SANDBOX_API_KEY",
  sandboxAuthHeader: "SANDBOX_AUTH_HEADER",
} as const;

const DEFAULT = {
  s3Listen: "127.0.0.1:9000",
  proxyListen: "127.0.0.1:9100",
  llmAuthHeader: "authorization",
  llmAuthScheme: "Bearer",
  sandboxAuthHeader: "open-sandbox-api-key",
} as const;

type Setting = keyof typeof FLAG;

export interface ListenAddress {
  host: string;
  port: number;
}

/** An upstream that gets a credential header on each request. `apiKey` empty means no header. */
export interface InjectRoute {
  upstream: URL;
  authHeader: string;
  authScheme: string;
  apiKey: string;
}

export interface GatewayConfig {
  s3?: {
    listen: ListenAddress;
    upstream: URL;
    accessKeyId: string;
    secretAccessKey: string;
  };
  proxy: {
    listen: ListenAddress;
    llm?: InjectRoute;
    sandbox?: InjectRoute;
  };
}

function parseListen(value: string, setting: Setting): ListenAddress {
  const separator = value.lastIndexOf(":");
  const port = Number(value.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(port) || port <= 0) {
    throw new Error(`--${FLAG[setting]} must be HOST:PORT, got ${value}`);
  }
  return { host: value.slice(0, separator), port };
}

export function parseConfig(argv: readonly string[], env: Readonly<Record<string, string | undefined>>): GatewayConfig {
  const options = Object.fromEntries(Object.values(FLAG).map((flag) => [flag, { type: "string" as const }]));
  const { values } = parseArgs({ args: [...argv], options, strict: true });
  const read = (setting: Setting): string => {
    const fromFlag = values[FLAG[setting]];
    if (typeof fromFlag === "string" && fromFlag !== "") return fromFlag;
    const fromEnv = env[ENV[setting]];
    if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
    return setting in DEFAULT ? DEFAULT[setting as keyof typeof DEFAULT] : "";
  };

  const config: GatewayConfig = { proxy: { listen: parseListen(read("proxyListen"), "proxyListen") } };
  const s3Upstream = read("s3Upstream");
  if (s3Upstream !== "") {
    const accessKeyId = read("s3AccessKeyId");
    const secretAccessKey = read("s3SecretAccessKey");
    if (accessKeyId === "" || secretAccessKey === "") {
      throw new Error(`--${FLAG.s3Upstream} needs --${FLAG.s3AccessKeyId} and --${FLAG.s3SecretAccessKey}`);
    }
    config.s3 = {
      listen: parseListen(read("s3Listen"), "s3Listen"),
      upstream: new URL(s3Upstream),
      accessKeyId,
      secretAccessKey,
    };
  }
  const llmUpstream = read("llmUpstream");
  if (llmUpstream !== "") {
    config.proxy.llm = {
      upstream: new URL(llmUpstream),
      authHeader: read("llmAuthHeader").toLowerCase(),
      authScheme: read("llmAuthScheme"),
      apiKey: read("llmApiKey"),
    };
  }
  const sandboxUpstream = read("sandboxUpstream");
  if (sandboxUpstream !== "") {
    config.proxy.sandbox = {
      upstream: new URL(sandboxUpstream),
      authHeader: read("sandboxAuthHeader").toLowerCase(),
      authScheme: "",
      apiKey: read("sandboxApiKey"),
    };
  }
  return config;
}
