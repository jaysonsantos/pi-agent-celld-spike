// AWS Signature Version 4 for S3, with only the parts that the shim needs: header authentication of one request.
import { createHash, createHmac } from "node:crypto";

export const ALGORITHM = "AWS4-HMAC-SHA256";
export const UNSIGNED_PAYLOAD = "UNSIGNED-PAYLOAD";
const SERVICE = "s3";
const TERMINATOR = "aws4_request";
const KEY_PREFIX = "AWS4";
const UNRESERVED = /[A-Za-z0-9\-._~]/;

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/** The fields of an `Authorization` header that a client made with Signature Version 4. */
export interface ParsedAuthorization {
  accessKeyId: string;
  date: string;
  region: string;
  signedHeaders: string[];
}

export interface SigningRequest {
  method: string;
  /** The path as it goes on the wire, already canonical. */
  path: string;
  /** The query as it goes on the wire, already canonical. */
  query: string;
  /** Lower-case header names. Each signed header must be here. */
  headers: Record<string, string>;
  signedHeaders: readonly string[];
  payloadHash: string;
  /** The `x-amz-date` value, for example `20130524T000000Z`. */
  timestamp: string;
  region: string;
}

function sha256Hex(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** Percent-encodes each byte that is not unreserved, with upper-case hexadecimal digits. */
export function awsEncode(text: string): string {
  let encoded = "";
  for (const byte of Buffer.from(text, "utf8")) {
    const char = String.fromCharCode(byte);
    encoded += UNRESERVED.test(char) ? char : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return encoded;
}

function decode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

/** Encodes each segment of a raw path one time, as S3 does. The slashes stay. */
export function canonicalPath(rawPath: string): string {
  return rawPath
    .split("/")
    .map((segment) => awsEncode(decode(segment)))
    .join("/");
}

/** Sorts the parameters by encoded name, then by encoded value. A parameter without `=` gets an empty value. */
export function canonicalQuery(rawQuery: string): string {
  if (rawQuery === "") return "";
  return rawQuery
    .split("&")
    .filter((pair) => pair !== "")
    .map((pair) => {
      const separator = pair.indexOf("=");
      const name = separator === -1 ? pair : pair.slice(0, separator);
      const value = separator === -1 ? "" : pair.slice(separator + 1);
      return [awsEncode(decode(name)), awsEncode(decode(value))] as const;
    })
    .sort(([nameA, valueA], [nameB, valueB]) => {
      if (nameA !== nameB) return nameA < nameB ? -1 : 1;
      if (valueA === valueB) return 0;
      return valueA < valueB ? -1 : 1;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
}

export function parseAuthorization(header: string): ParsedAuthorization | undefined {
  if (!header.startsWith(`${ALGORITHM} `)) return undefined;
  const fields = new Map<string, string>();
  for (const part of header.slice(ALGORITHM.length + 1).split(",")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    fields.set(part.slice(0, separator).trim(), part.slice(separator + 1).trim());
  }
  const [accessKeyId, date, region, service, terminator] = (fields.get("Credential") ?? "").split("/");
  const signedHeaders = fields.get("SignedHeaders");
  if (!accessKeyId || !date || !region || service !== SERVICE || terminator !== TERMINATOR || !signedHeaders) {
    return undefined;
  }
  return { accessKeyId, date, region, signedHeaders: signedHeaders.split(";") };
}

function canonicalHeaderValue(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

export function canonicalRequest(request: SigningRequest): string {
  const names = [...request.signedHeaders].sort();
  const headerLines = names.map((name) => {
    const value = request.headers[name];
    if (value === undefined) throw new Error(`signed header ${name} is not in the request`);
    return `${name}:${canonicalHeaderValue(value)}\n`;
  });
  return [request.method, request.path, request.query, headerLines.join(""), names.join(";"), request.payloadHash].join(
    "\n",
  );
}

/** Makes the `Authorization` header value for the request. */
export function authorization(request: SigningRequest, credentials: Credentials): string {
  const date = request.timestamp.slice(0, "YYYYMMDD".length);
  const scope = [date, request.region, SERVICE, TERMINATOR].join("/");
  const stringToSign = [ALGORITHM, request.timestamp, scope, sha256Hex(canonicalRequest(request))].join("\n");
  const dateKey = hmac(`${KEY_PREFIX}${credentials.secretAccessKey}`, date);
  const signingKey = hmac(hmac(hmac(dateKey, request.region), SERVICE), TERMINATOR);
  const signature = hmac(signingKey, stringToSign).toString("hex");
  const signedHeaders = [...request.signedHeaders].sort().join(";");
  return `${ALGORITHM} Credential=${credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
}
