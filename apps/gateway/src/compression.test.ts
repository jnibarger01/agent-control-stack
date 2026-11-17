import { Readable } from "node:stream";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { MIN_COMPRESS_BYTES, encodingQuality, registerResponseCompression, selectEncoding } from "./compression.js";

function testApp() {
  const app = Fastify({ logger: false });
  registerResponseCompression(app);
  const large = "compress me ".repeat(500);
  app.get("/large-json", async () => ({ value: large }));
  app.get("/large-text", async (_request, reply) => reply.type("text/plain; charset=utf-8").send(large));
  app.get("/small", async () => ({ value: "ok" }));
  app.get("/stream", async (_request, reply) => reply.type("text/event-stream").send(`data: ${large}\n\n`));
  app.get("/file-stream", async (_request, reply) => reply.type("text/plain").send(Readable.from([large])));
  app.get("/range", async (_request, reply) =>
    reply.code(206).header("content-range", "bytes 0-10/5000").type("text/plain").send(large.slice(0, 11))
  );
  app.get("/no-transform", async (_request, reply) =>
    reply.header("cache-control", "no-store, no-transform").type("text/plain").send(large)
  );
  return app;
}

describe("response compression", () => {
  it("negotiates Brotli and gzip with q-values", () => {
    expect(selectEncoding("gzip, br")).toBe("br");
    expect(selectEncoding("gzip")).toBe("gzip");
    expect(selectEncoding("br;q=0.4, gzip;q=0.9")).toBe("gzip");
    expect(selectEncoding("gzip;q=0, br;q=0")).toBeUndefined();
    expect(selectEncoding(undefined)).toBeUndefined();
    expect(encodingQuality("br;q=0.5, *;q=0.1", "gzip")).toBe(0.1);
  });

  it("compresses a large JSON response with gzip and keeps the body intact", async () => {
    const app = testApp();
    const response = await app.inject({ method: "GET", url: "/large-json", headers: { "accept-encoding": "gzip" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["vary"]).toMatch(/accept-encoding/i);
    expect(Number(response.headers["content-length"])).toBe(response.rawPayload.length);
    expect(JSON.parse(gunzipSync(response.rawPayload).toString("utf8"))).toEqual({
      value: "compress me ".repeat(500)
    });
    await app.close();
  });

  it("prefers Brotli when the client accepts it", async () => {
    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: "/large-text",
      headers: { "accept-encoding": "gzip, br" }
    });
    expect(response.headers["content-encoding"]).toBe("br");
    expect(brotliDecompressSync(response.rawPayload).toString("utf8")).toBe("compress me ".repeat(500));
    await app.close();
  });

  it("leaves small, event-stream, range, and no-transform responses uncompressed", async () => {
    const app = testApp();
    for (const url of ["/small", "/stream", "/range", "/no-transform"]) {
      const response = await app.inject({ method: "GET", url, headers: { "accept-encoding": "gzip, br" } });
      expect(response.headers["content-encoding"], url).toBeUndefined();
    }
    const small = await app.inject({ method: "GET", url: "/small", headers: { "accept-encoding": "gzip" } });
    expect(Buffer.byteLength(small.body)).toBeLessThan(MIN_COMPRESS_BYTES);
    await app.close();
  });

  it("compresses a streamed response with gzip", async () => {
    const app = testApp();
    const response = await app.inject({ method: "GET", url: "/file-stream", headers: { "accept-encoding": "gzip" } });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.headers["vary"]).toMatch(/accept-encoding/i);
    expect(gunzipSync(response.rawPayload).toString("utf8")).toBe("compress me ".repeat(500));
    await app.close();
  });

  it("reports the same encoding headers on HEAD as on GET", async () => {
    const app = testApp();
    const get = await app.inject({ method: "GET", url: "/large-json", headers: { "accept-encoding": "gzip" } });
    const head = await app.inject({ method: "HEAD", url: "/large-json", headers: { "accept-encoding": "gzip" } });
    expect(head.statusCode).toBe(200);
    expect(head.headers["content-encoding"]).toBe("gzip");
    expect(head.headers["content-length"]).toBe(get.headers["content-length"]);
    expect(head.body).toBe("");

    const streamHead = await app.inject({
      method: "HEAD",
      url: "/file-stream",
      headers: { "accept-encoding": "gzip" }
    });
    expect(streamHead.statusCode).toBe(200);
    expect(streamHead.headers["content-encoding"]).toBe("gzip");
    expect(streamHead.body).toBe("");
    await app.close();
  });

  it("does not compress when the client refuses both encodings", async () => {
    const app = testApp();
    const response = await app.inject({
      method: "GET",
      url: "/large-json",
      headers: { "accept-encoding": "gzip;q=0, br;q=0, identity" }
    });
    expect(response.headers["content-encoding"]).toBeUndefined();
    // Caches must not reuse the identity body for a caller that accepts Brotli.
    expect(response.headers["vary"]).toMatch(/accept-encoding/i);
    expect(JSON.parse(response.body)).toEqual({ value: "compress me ".repeat(500) });
    await app.close();
  });
});
