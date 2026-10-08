// One upstream request with a streamed body in each direction.
import http, {
  type IncomingHttpHeaders,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import https from "node:https";

export const STATUS = {
  badRequest: 400,
  notFound: 404,
  notImplemented: 501,
  badGateway: 502,
} as const;

const HTTPS_PROTOCOL = "https:";
// A hop-by-hop header belongs to one connection, so the gateway does not pass it on.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const keepAliveAgents = {
  http: new http.Agent({ keepAlive: true }),
  https: new https.Agent({ keepAlive: true }),
};

/** The headers of a message without the hop-by-hop headers. A repeated header keeps its first value. */
export function endToEndHeaders(headers: IncomingHttpHeaders): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name)) continue;
    result[name] = Array.isArray(value) ? (value[0] ?? "") : value;
  }
  return result;
}

export function sendText(response: ServerResponse, status: number, message: string): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  response.writeHead(status, { "content-type": "text/plain; charset=utf-8" });
  response.end(`${message}\n`);
}

export interface UpstreamTarget {
  origin: URL;
  method: string;
  /** Path and query as they go on the wire. */
  pathAndQuery: string;
  headers: OutgoingHttpHeaders;
}

/** Sends the client request to the upstream and streams the answer back. */
export function forward(target: UpstreamTarget, clientRequest: IncomingMessage, clientResponse: ServerResponse): void {
  const secure = target.origin.protocol === HTTPS_PROTOCOL;
  const upstreamRequest = (secure ? https : http).request(
    {
      protocol: target.origin.protocol,
      hostname: target.origin.hostname,
      port: target.origin.port === "" ? undefined : Number(target.origin.port),
      method: target.method,
      path: target.pathAndQuery,
      headers: target.headers,
      agent: secure ? keepAliveAgents.https : keepAliveAgents.http,
    },
    (upstreamResponse) => {
      const headers: OutgoingHttpHeaders = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name)) headers[name] = value;
      }
      clientResponse.writeHead(upstreamResponse.statusCode ?? STATUS.badGateway, headers);
      upstreamResponse.pipe(clientResponse);
      upstreamResponse.on("error", () => clientResponse.destroy());
    },
  );
  upstreamRequest.on("error", (error) => {
    sendText(clientResponse, STATUS.badGateway, `gateway: upstream request failed: ${error.message}`);
  });
  // A client that goes away must also stop the upstream work, for example a long model answer.
  clientResponse.on("close", () => {
    if (!clientResponse.writableFinished) upstreamRequest.destroy();
  });
  clientRequest.pipe(upstreamRequest);
}
