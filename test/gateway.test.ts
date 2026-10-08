import assert from "node:assert/strict";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, test } from "node:test";
import { parseConfig } from "../src/gateway/config.ts";
import { createInjectProxy, upstreamPath } from "../src/gateway/inject-proxy.ts";
import { createS3Shim, unquoteEtags } from "../src/gateway/s3-shim.ts";
import { authorization, parseAuthorization } from "../src/gateway/sigv4.ts";

const LOOPBACK = "127.0.0.1";
const REAL_KEYS = { accessKeyId: "REALKEY", secretAccessKey: "real-secret" };
const CLIENT_KEYS = { accessKeyId: "shim", secretAccessKey: "shim" };
const REGION = "eu-central-1";
const TIMESTAMP = "20261007T080000Z";
const PAYLOAD_HASH = "UNSIGNED-PAYLOAD";

interface SeenRequest {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

let upstream: Server;
let upstreamUrl: string;
const seen: SeenRequest[] = [];

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => {
    server.listen(0, LOOPBACK, () => resolve(`http://${LOOPBACK}:${(server.address() as AddressInfo).port}`));
  });
}

before(async () => {
  upstream = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      seen.push({
        method: request.method ?? "",
        url: request.url ?? "",
        headers: request.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      response.writeHead(200, { etag: '"abc"' });
      response.end("upstream answer");
    });
  });
  upstreamUrl = await listen(upstream);
});

after(() => {
  upstream.close();
});

test("removes the quotes of each ETag and keeps the any-object condition", () => {
  assert.equal(unquoteEtags('"4f98f59e"'), "4f98f59e");
  assert.equal(unquoteEtags('"a", W/"b"'), "a, W/b");
  assert.equal(unquoteEtags("*"), "*");
  assert.equal(unquoteEtags("plain"), "plain");
});

test("signs the changed request again with the real key pair", async () => {
  const shim = createS3Shim({
    listen: { host: LOOPBACK, port: 0 },
    upstream: new URL(upstreamUrl),
    ...REAL_KEYS,
  });
  const shimUrl = await listen(shim);
  try {
    const path = "/bucket/cells/FeatureAgent:abc/own.json";
    const signed = ["host", "if-match", "x-amz-content-sha256", "x-amz-date"];
    const clientHeaders = {
      host: new URL(shimUrl).host,
      "if-match": '"4f98f59e"',
      "x-amz-content-sha256": PAYLOAD_HASH,
      "x-amz-date": TIMESTAMP,
    };
    const clientRequest = {
      method: "PUT",
      path: "/bucket/cells/FeatureAgent%3Aabc/own.json",
      query: "",
      headers: clientHeaders,
      signedHeaders: signed,
      payloadHash: PAYLOAD_HASH,
      timestamp: TIMESTAMP,
      region: REGION,
    };
    const response = await fetch(`${shimUrl}${path}`, {
      method: "PUT",
      headers: { ...clientHeaders, authorization: authorization(clientRequest, CLIENT_KEYS) },
      body: '{"node":"n","epoch":2}',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "upstream answer");
    assert.equal(response.headers.get("etag"), '"abc"');

    const request = seen.at(-1);
    assert.ok(request !== undefined);
    assert.equal(request.method, "PUT");
    assert.equal(request.url, "/bucket/cells/FeatureAgent%3Aabc/own.json");
    assert.equal(request.headers["if-match"], "4f98f59e");
    assert.equal(request.body, '{"node":"n","epoch":2}');

    // The upstream checks a signature as S3 does: from the request that arrived, with the real secret.
    const parsed = parseAuthorization(String(request.headers.authorization));
    assert.equal(parsed?.accessKeyId, REAL_KEYS.accessKeyId);
    const expected = authorization(
      {
        method: request.method,
        path: request.url,
        query: "",
        headers: request.headers as Record<string, string>,
        signedHeaders: parsed?.signedHeaders ?? [],
        payloadHash: PAYLOAD_HASH,
        timestamp: TIMESTAMP,
        region: REGION,
      },
      REAL_KEYS,
    );
    assert.equal(request.headers.authorization, expected);
  } finally {
    shim.close();
  }
});

test("refuses a request without a Signature Version 4 header", async () => {
  const shim = createS3Shim({ listen: { host: LOOPBACK, port: 0 }, upstream: new URL(upstreamUrl), ...REAL_KEYS });
  const shimUrl = await listen(shim);
  try {
    assert.equal((await fetch(`${shimUrl}/bucket/key`)).status, 400);
  } finally {
    shim.close();
  }
});

test("joins the upstream base path and the request path", () => {
  assert.equal(upstreamPath(new URL("https://api.example.com/v1"), "/chat/completions"), "/v1/chat/completions");
  assert.equal(upstreamPath(new URL("https://api.example.com/"), "/v1/messages?beta=1"), "/v1/messages?beta=1");
  assert.equal(upstreamPath(new URL("http://server"), ""), "/");
  assert.equal(upstreamPath(new URL("http://server/base/"), "?a=1"), "/base?a=1");
});

test("adds the key of the route and removes the prefix", async () => {
  const config = parseConfig(["--llm-upstream", `${upstreamUrl}/v1`, "--sandbox-upstream", upstreamUrl], {
    LLM_API_KEY: "model-key",
    SANDBOX_API_KEY: "sandbox-key",
  });
  const proxy = createInjectProxy(config.proxy);
  const proxyUrl = await listen(proxy);
  try {
    await fetch(`${proxyUrl}/llm/chat/completions`, {
      method: "POST",
      body: "{}",
      headers: { authorization: "Bearer x" },
    });
    const llm = seen.at(-1);
    assert.equal(llm?.url, "/v1/chat/completions");
    assert.equal(llm?.headers.authorization, "Bearer model-key");

    await fetch(`${proxyUrl}/sandbox/v1/sandboxes?pageSize=1`);
    const sandbox = seen.at(-1);
    assert.equal(sandbox?.url, "/v1/sandboxes?pageSize=1");
    assert.equal(sandbox?.headers["open-sandbox-api-key"], "sandbox-key");

    assert.equal((await fetch(`${proxyUrl}/other`)).status, 404);
    assert.equal((await fetch(`${proxyUrl}/healthz`)).status, 200);
  } finally {
    proxy.close();
  }
});

test("needs the key pair when the S3 shim is on", () => {
  assert.throws(() => parseConfig(["--s3-upstream", "https://s3.example.com"], {}), /needs/);
  const config = parseConfig([], {
    GATEWAY_S3_UPSTREAM: "https://s3.example.com",
    AWS_ACCESS_KEY_ID: "a",
    AWS_SECRET_ACCESS_KEY: "b",
  });
  assert.equal(config.s3?.listen.port, 9000);
  assert.equal(config.proxy.llm, undefined);
});
