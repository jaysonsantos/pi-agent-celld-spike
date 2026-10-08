import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorization,
  awsEncode,
  canonicalPath,
  canonicalQuery,
  parseAuthorization,
  type SigningRequest,
} from "../src/gateway/sigv4.ts";

// The example values of the AWS guide "Signature Calculations for the Authorization Header".
const CREDENTIALS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const HOST = "examplebucket.s3.amazonaws.com";
const TIMESTAMP = "20130524T000000Z";
const REGION = "us-east-1";

test("signs the GET object example of the AWS guide", () => {
  const request: SigningRequest = {
    method: "GET",
    path: "/test.txt",
    query: "",
    headers: { host: HOST, range: "bytes=0-9", "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": TIMESTAMP },
    signedHeaders: ["host", "range", "x-amz-content-sha256", "x-amz-date"],
    payloadHash: EMPTY_SHA256,
    timestamp: TIMESTAMP,
    region: REGION,
  };
  assert.equal(
    authorization(request, CREDENTIALS),
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
});

test("signs the list objects example of the AWS guide", () => {
  const request: SigningRequest = {
    method: "GET",
    path: "/",
    query: canonicalQuery("prefix=J&max-keys=2"),
    headers: { host: HOST, "x-amz-content-sha256": EMPTY_SHA256, "x-amz-date": TIMESTAMP },
    signedHeaders: ["host", "x-amz-content-sha256", "x-amz-date"],
    payloadHash: EMPTY_SHA256,
    timestamp: TIMESTAMP,
    region: REGION,
  };
  assert.match(
    authorization(request, CREDENTIALS),
    /Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7$/,
  );
});

test("encodes a path segment one time and keeps the slashes", () => {
  assert.equal(canonicalPath("/bucket/cells/Feature:abc/own.json"), "/bucket/cells/Feature%3Aabc/own.json");
  assert.equal(canonicalPath("/bucket/cells/Feature%3Aabc/a%20b"), "/bucket/cells/Feature%3Aabc/a%20b");
});

test("sorts the query and gives an empty value to a bare name", () => {
  assert.equal(canonicalQuery("uploads&prefix=a/b&list-type=2"), "list-type=2&prefix=a%2Fb&uploads=");
  assert.equal(canonicalQuery(""), "");
});

test("encodes each reserved byte with upper-case digits", () => {
  assert.equal(awsEncode("a b+c/é~"), "a%20b%2Bc%2F%C3%A9~");
});

test("reads the fields of a client authorization header", () => {
  const parsed = parseAuthorization(
    "AWS4-HMAC-SHA256 Credential=key/20130524/eu-central-1/s3/aws4_request, SignedHeaders=host;if-match, Signature=00",
  );
  assert.deepEqual(parsed, {
    accessKeyId: "key",
    date: "20130524",
    region: "eu-central-1",
    signedHeaders: ["host", "if-match"],
  });
  assert.equal(parseAuthorization("Bearer token"), undefined);
});
