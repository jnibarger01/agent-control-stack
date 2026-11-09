import { pipeline, type Readable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, constants, createBrotliCompress, createGzip, gzip } from "node:zlib";
import type { FastifyInstance, FastifyReply } from "fastify";

const brotliCompressAsync = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Brotli q5 is a few milliseconds for the dashboard HTML and still beats gzip. */
const BROTLI_OPTIONS = { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } };

/** Below this size the encoding overhead outweighs the transfer saving. */
export const MIN_COMPRESS_BYTES = 1_024;

/**
 * Only these media types are compressed. Event streams and binary payloads are
 * left alone; the SSE route writes to the raw response anyway, and compressing
 * an event stream would delay frames.
 */
const COMPRESSIBLE_MEDIA_TYPE =
  /^(?:text\/(?!event-stream)|application\/(?:json|javascript|xml|[a-z0-9.+-]+\+json|[a-z0-9.+-]+\+xml)|image\/svg\+xml)/i;

function headerValue(value: string | number | string[] | undefined): string {
  return Array.isArray(value) ? value.join(", ") : value === undefined ? "" : String(value);
}

/** q-value for one encoding from an Accept-Encoding header; `*` is a fallback. */
export function encodingQuality(header: string | undefined, encoding: "br" | "gzip"): number {
  if (!header) return 0;
  let wildcard = 0;
  for (const part of header.split(",")) {
    const [rawName, ...params] = part.trim().split(";");
    const name = rawName.trim().toLowerCase();
    if (name !== encoding && name !== "*") continue;
    let quality = 1;
    for (const param of params) {
      const [rawKey, rawValue] = param.split("=");
      if (rawKey?.trim().toLowerCase() !== "q") continue;
      const parsed = Number(rawValue);
      quality = Number.isFinite(parsed) && parsed >= 0 && parsed <= 1 ? parsed : 0;
    }
    if (name === encoding) return quality;
    wildcard = quality;
  }
  return wildcard;
}

/** Pick the best encoding the caller accepts, preferring Brotli on a tie. */
export function selectEncoding(header: string | undefined): "br" | "gzip" | undefined {
  const br = encodingQuality(header, "br");
  const gzipQuality = encodingQuality(header, "gzip");
  if (br > 0 && br >= gzipQuality) return "br";
  if (gzipQuality > 0) return "gzip";
  return undefined;
}

function appendVary(reply: FastifyReply): void {
  const current = headerValue(reply.getHeader("vary"));
  if (/(?:^|,)\s*accept-encoding\s*(?:,|$)/i.test(current)) return;
  reply.header("vary", current ? `${current}, Accept-Encoding` : "Accept-Encoding");
}

export function registerResponseCompression(app: FastifyInstance): void {
  app.addHook("onSend", async (request, reply, payload) => {
    if (reply.statusCode < 200 || reply.statusCode === 204 || reply.statusCode === 304) return payload;
    if (reply.getHeader("content-encoding")) return payload;
    if (/no-transform/i.test(headerValue(reply.getHeader("cache-control")))) return payload;

    const contentType = headerValue(reply.getHeader("content-type"));
    if (!COMPRESSIBLE_MEDIA_TYPE.test(contentType)) return payload;

    // A partial response is byte-exact. Re-encoding it would invalidate the
    // range the caller asked for.
    if (reply.statusCode === 206 || request.headers.range || reply.getHeader("content-range")) return payload;

    if (payload !== null && typeof (payload as Readable).pipe === "function") {
      const knownLength = Number(reply.getHeader("content-length"));
      if (Number.isFinite(knownLength) && knownLength < MIN_COMPRESS_BYTES) return payload;
      appendVary(reply);
      const encoding = selectEncoding(headerValue(request.headers["accept-encoding"]));
      if (!encoding) return payload;
      reply.header("content-encoding", encoding);
      reply.removeHeader("content-length");
      const compressor = encoding === "br" ? createBrotliCompress(BROTLI_OPTIONS) : createGzip();
      // pipeline destroys both streams and consumes errors, so a mid-stream
      // failure aborts the response rather than crashing the process.
      return pipeline(payload as Readable, compressor, () => undefined);
    }

    let body: Buffer;
    if (typeof payload === "string") body = Buffer.from(payload, "utf8");
    else if (Buffer.isBuffer(payload)) body = payload;
    else return payload;

    if (body.length < MIN_COMPRESS_BYTES) return payload;

    // A cache must key the compressed and identity representations separately
    // even when this particular caller does not accept an encoding.
    appendVary(reply);
    const encoding = selectEncoding(headerValue(request.headers["accept-encoding"]));
    if (!encoding) return payload;

    let compressed: Buffer;
    try {
      compressed = encoding === "br" ? await brotliCompressAsync(body, BROTLI_OPTIONS) : await gzipAsync(body);
    } catch {
      // Compression is an optimization. A failure must not turn a valid
      // response into a 500; send the uncompressed payload instead.
      return payload;
    }
    if (compressed.length >= body.length) return body;

    reply.header("content-encoding", encoding);
    reply.header("content-length", String(compressed.length));
    return compressed;
  });
}
