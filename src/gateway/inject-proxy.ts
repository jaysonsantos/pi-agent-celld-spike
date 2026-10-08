// Reverse proxy that adds the credential of an upstream to each request. The worker in celld has no secret store:
// its variables are plain text in the bucket. So the worker calls this proxy, and the keys stay in the pod.
import { createServer, type Server } from "node:http";
import type { GatewayConfig, InjectRoute } from "./config.ts";
import { endToEndHeaders, forward, STATUS, sendText } from "./forward.ts";

export const ROUTE_PREFIX = {
  llm: "/llm",
  sandbox: "/sandbox",
} as const;

const HEALTH_PATH = "/healthz";
const HOST_HEADER = "host";

type ProxyConfig = GatewayConfig["proxy"];

function matchRoute(config: ProxyConfig, url: string): { route: InjectRoute; rest: string } | undefined {
  const candidates: [string, InjectRoute | undefined][] = [
    [ROUTE_PREFIX.llm, config.llm],
    [ROUTE_PREFIX.sandbox, config.sandbox],
  ];
  for (const [prefix, route] of candidates) {
    if (route === undefined) continue;
    if (url === prefix || url.startsWith(`${prefix}/`) || url.startsWith(`${prefix}?`)) {
      return { route, rest: url.slice(prefix.length) };
    }
  }
  return undefined;
}

/** Joins the path of the upstream base URL and the remaining request path. */
export function upstreamPath(upstream: URL, rest: string): string {
  const base = upstream.pathname.replace(/\/+$/, "");
  const suffix = rest === "" || rest.startsWith("/") || rest.startsWith("?") ? rest : `/${rest}`;
  const joined = `${base}${suffix}`;
  return joined === "" || joined.startsWith("?") ? `/${joined}` : joined;
}

export function createInjectProxy(config: ProxyConfig): Server {
  return createServer((request, response) => {
    const url = request.url ?? "/";
    if (url === HEALTH_PATH) {
      sendText(response, 200, "ok");
      return;
    }
    const match = matchRoute(config, url);
    if (match === undefined) {
      sendText(response, STATUS.notFound, `gateway: no route for ${url}`);
      return;
    }
    const { route, rest } = match;
    const headers = endToEndHeaders(request.headers);
    headers[HOST_HEADER] = route.upstream.host;
    if (route.apiKey !== "") {
      headers[route.authHeader] = route.authScheme === "" ? route.apiKey : `${route.authScheme} ${route.apiKey}`;
    }
    forward(
      {
        origin: route.upstream,
        method: request.method ?? "GET",
        pathAndQuery: upstreamPath(route.upstream, rest),
        headers,
      },
      request,
      response,
    );
  });
}
