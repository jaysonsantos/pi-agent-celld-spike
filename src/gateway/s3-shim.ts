// S3 shim for an object store that is a Ceph RADOS Gateway.
//
// That endpoint accepts `If-Match: <etag>` on a PUT only when the ETag has no quotes; with the quotes of RFC 9110 it
// always answers 412. celld sends the quotes, so its compare-and-swap writes never succeed. The shim removes the
// quotes. The client signed that header, so the shim signs the changed request again.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GatewayConfig } from "./config.ts";
import { endToEndHeaders, forward, STATUS, sendText } from "./forward.ts";
import { authorization, canonicalPath, canonicalQuery, parseAuthorization, UNSIGNED_PAYLOAD } from "./sigv4.ts";

const HEADER = {
  authorization: "authorization",
  host: "host",
  contentSha256: "x-amz-content-sha256",
  date: "x-amz-date",
} as const;

// Each of these headers carries an ETag list that the endpoint compares without quotes.
const ETAG_CONDITION_HEADERS = [
  "if-match",
  "if-none-match",
  "x-amz-copy-source-if-match",
  "x-amz-copy-source-if-none-match",
];

// A chunk-signed body has one signature for each chunk, made from the first signature. The shim cannot sign it again.
const CHUNK_SIGNED_PAYLOAD_PREFIX = "STREAMING-AWS4-HMAC-SHA256-PAYLOAD";

const ANY_ETAG = "*";

/** Removes the quotes from each ETag of a condition header. `*` and a weak validator prefix stay. */
export function unquoteEtags(value: string): string {
  if (value.trim() === ANY_ETAG) return value;
  return value
    .split(",")
    .map((etag) => etag.trim().replace(/^(W\/)?"(.*)"$/, "$1$2"))
    .join(", ");
}

type S3Config = NonNullable<GatewayConfig["s3"]>;

function handle(config: S3Config, request: IncomingMessage, response: ServerResponse): void {
  const headers = endToEndHeaders(request.headers);
  const parsed = parseAuthorization(headers[HEADER.authorization] ?? "");
  const timestamp = headers[HEADER.date];
  if (parsed === undefined || timestamp === undefined) {
    sendText(response, STATUS.badRequest, "s3 shim: the request has no Signature Version 4 authorization header");
    return;
  }
  const payloadHash = headers[HEADER.contentSha256] ?? UNSIGNED_PAYLOAD;
  if (payloadHash.startsWith(CHUNK_SIGNED_PAYLOAD_PREFIX)) {
    sendText(response, STATUS.notImplemented, "s3 shim: a chunk-signed body is not supported");
    return;
  }

  const rawUrl = request.url ?? "/";
  const queryStart = rawUrl.indexOf("?");
  const path = canonicalPath(queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart));
  const query = canonicalQuery(queryStart === -1 ? "" : rawUrl.slice(queryStart + 1));

  for (const name of ETAG_CONDITION_HEADERS) {
    const value = headers[name];
    if (value !== undefined) headers[name] = unquoteEtags(value);
  }
  headers[HEADER.host] = config.upstream.host;
  headers[HEADER.contentSha256] = payloadHash;
  const signedHeaders = new Set([...parsed.signedHeaders, HEADER.host, HEADER.contentSha256, HEADER.date]);
  headers[HEADER.authorization] = authorization(
    {
      method: request.method ?? "GET",
      path,
      query,
      headers,
      signedHeaders: [...signedHeaders],
      payloadHash,
      timestamp,
      region: parsed.region,
    },
    { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
  );

  forward(
    {
      origin: config.upstream,
      method: request.method ?? "GET",
      pathAndQuery: query === "" ? path : `${path}?${query}`,
      headers,
    },
    request,
    response,
  );
}

export function createS3Shim(config: S3Config): Server {
  return createServer((request, response) => {
    try {
      handle(config, request, response);
    } catch (error) {
      sendText(response, STATUS.badRequest, `s3 shim: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}
