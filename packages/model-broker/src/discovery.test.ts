import { describe, expect, it } from "vitest";
import { assertLoopback, discoverHostedProviders, discoverOllama, discoverOpenAiCompatible, type FetchLike } from "./discovery.js";

const json = (body: unknown, status = 200) => async () => ({ ok: status < 400, status, json: async () => body });
const route =
  (table: Record<string, unknown>): FetchLike =>
  async (url) => {
    const key = Object.keys(table).find((k) => url.endsWith(k));
    if (!key) throw new TypeError("fetch failed");
    return json(table[key])();
  };
const now = () => new Date("2026-10-11T12:00:00.000Z");

describe("assertLoopback", () => {
  it.each(["http://127.0.0.1:11434", "http://localhost:8080", "http://[::1]:1234"])("accepts %s", (url) => {
    expect(() => assertLoopback(url)).not.toThrow();
  });
  it.each(["http://10.0.0.5:11434", "http://example.com", "http://0.0.0.0:80", "ftp://127.0.0.1", "http://user:pw@127.0.0.1"])(
    "refuses %s",
    (url) => {
      expect(() => assertLoopback(url)).toThrow();
    }
  );
});

describe("discoverOllama", () => {
  it("lists installed models and the ones resident in memory", async () => {
    const result = await discoverOllama(
      route({
        "/api/tags": { models: [{ name: "b:1" }, { name: "a:1" }, { name: "a:1" }] },
        "/api/ps": { models: [{ name: "a:1" }] }
      }),
      undefined,
      now
    );
    expect(result).toMatchObject({ providerId: "ollama", kind: "local", reachable: true, models: ["a:1", "b:1"], loadedModels: ["a:1"] });
  });

  it("still reports installed models when residency cannot be read", async () => {
    const result = await discoverOllama(route({ "/api/tags": { models: [{ name: "a:1" }] } }), undefined, now);
    expect(result).toMatchObject({ reachable: true, models: ["a:1"], loadedModels: [] });
  });

  it("reports an unreachable server with only the error class", async () => {
    const result = await discoverOllama(async () => Promise.reject(new TypeError("connect ECONNREFUSED secret-detail")), undefined, now);
    expect(result).toMatchObject({ reachable: false, models: [], error: "TypeError" });
    expect(JSON.stringify(result)).not.toContain("secret-detail");
  });

  it("treats an HTTP error or an unexpected shape as unreachable, not as an empty install", async () => {
    expect((await discoverOllama(json({}, 500), undefined, now)).reachable).toBe(false);
    expect((await discoverOllama(json({ nope: 1 }), undefined, now)).reachable).toBe(false);
  });

  it("refuses to treat a non-loopback endpoint as local", async () => {
    await expect(discoverOllama(json({}), "http://10.1.2.3:11434", now)).rejects.toThrow(/loopback/);
  });
});

describe("discoverOpenAiCompatible", () => {
  it("reads /v1/models", async () => {
    const result = await discoverOpenAiCompatible(route({ "/v1/models": { data: [{ id: "m1" }, { id: "m2" }] } }), "llamacpp", "http://127.0.0.1:8080", now);
    expect(result).toMatchObject({ providerId: "llamacpp", reachable: true, models: ["m1", "m2"] });
  });
  it("reports a server that is not an OpenAI-compatible API as unreachable", async () => {
    expect((await discoverOpenAiCompatible(json({ html: true }), "x", "http://127.0.0.1:8080", now)).reachable).toBe(false);
    expect((await discoverOpenAiCompatible(json({}, 404), "x", "http://127.0.0.1:8080", now)).reachable).toBe(false);
  });
});

describe("discoverHostedProviders", () => {
  it("reports configured, not reachable, and never reads the secret into the result", () => {
    const result = discoverHostedProviders(
      { SECRET_A: "sk-live-very-secret", SECRET_B: "" },
      [
        { providerId: "a", credentialEnv: "SECRET_A" },
        { providerId: "b", credentialEnv: "SECRET_B" },
        { providerId: "c", credentialEnv: "SECRET_C" }
      ],
      now
    );
    expect(result.map((r) => [r.providerId, r.credentialPresent, r.reachable])).toEqual([
      ["a", true, "unknown"],
      ["b", false, "unknown"],
      ["c", false, "unknown"]
    ]);
    expect(JSON.stringify(result)).not.toContain("very-secret");
  });
});
