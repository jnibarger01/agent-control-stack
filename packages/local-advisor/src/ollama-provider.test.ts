import { describe, expect, it } from "vitest";
import {
  OllamaProvider,
  DEFAULT_OLLAMA_BASE_URL,
  MAX_CHAT_RESPONSE_BYTES,
  MAX_TAGS_RESPONSE_BYTES,
  chatModelNames,
  listInstalledOllamaModels,
  readBoundedJson
} from "./ollama-provider.js";
import { ProviderError } from "./provider.js";

const HEX = "c".repeat(64);
const DIGEST = `sha256:${HEX}`;

type Handler = (url: URL, init: RequestInit) => Response | Promise<Response>;

function fakeFetch(handler: Handler) {
  const seen: { url: URL; init: RequestInit }[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    seen.push({ url, init: init ?? {} });
    return handler(url, init ?? {});
  }) as unknown as typeof fetch;
  return { impl, seen };
}

const tags = (name = "qwen2.5-coder:7b", digest = HEX) =>
  new Response(JSON.stringify({ models: [{ name, model: name, digest }] }), { status: 200 });

const chat = (content: string) =>
  new Response(JSON.stringify({ message: { role: "assistant", content }, prompt_eval_count: 9, eval_count: 4 }), {
    status: 200
  });

const input = (signal = new AbortController().signal) => ({
  system: "s",
  user: "u",
  format: { type: "object" },
  maxOutputTokens: 128,
  signal
});

describe("OllamaProvider: local-only endpoint", () => {
  it("defaults to 127.0.0.1:11434", () => {
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fakeFetch(() => tags()).impl });
    expect(DEFAULT_OLLAMA_BASE_URL).toBe("http://127.0.0.1:11434");
    expect(provider.providerId).toBe("ollama");
  });

  it.each([
    "http://10.0.0.5:11434",
    "http://example.com:11434",
    "https://api.openai.com",
    "http://user:pass@127.0.0.1:11434"
  ])("refuses non-loopback or credentialed endpoint %s", (baseUrl) => {
    expect(() => new OllamaProvider({ model: "qwen2.5-coder:7b", baseUrl })).toThrow();
  });

  it("refuses a model name that could alter the request path", () => {
    expect(() => new OllamaProvider({ model: "../../etc", fetchImpl: fakeFetch(() => tags()).impl })).toThrow(
      /invalid Ollama model name/u
    );
  });

  it("only ever contacts the configured loopback host, with redirects refused", async () => {
    const fake = fakeFetch((url) => (url.pathname === "/api/tags" ? tags() : chat('{"verdict":"PASS"}')));
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl });
    await provider.generate(input());
    expect(fake.seen.length).toBeGreaterThanOrEqual(2);
    for (const call of fake.seen) {
      expect(call.url.hostname).toBe("127.0.0.1");
      expect(call.init.redirect).toBe("error");
    }
  });
});

describe("OllamaProvider: model identity", () => {
  it("returns the verified digest from /api/tags and does not pull models", async () => {
    const fake = fakeFetch((url) => (url.pathname === "/api/tags" ? tags() : chat("{}")));
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl });
    const result = await provider.generate(input());
    expect(result.digest).toBe(DIGEST);
    expect(result.promptTokens).toBe(9);
    expect(result.completionTokens).toBe(4);
    expect(fake.seen.some((c) => c.url.pathname.startsWith("/api/pull"))).toBe(false);
  });

  it("refuses generation when the installed digest differs from the pinned digest", async () => {
    const fake = fakeFetch((url) => (url.pathname === "/api/tags" ? tags("qwen2.5-coder:7b", "d".repeat(64)) : chat("{}")));
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", expectedDigest: DIGEST, fetchImpl: fake.impl });
    await expect(provider.generate(input())).rejects.toMatchObject({ kind: "digest_mismatch" });
    expect(fake.seen.some((c) => c.url.pathname === "/api/chat")).toBe(false);
  });

  it("refuses when the model is not installed", async () => {
    const fake = fakeFetch(() => tags("other:latest"));
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl });
    await expect(provider.generate(input())).rejects.toMatchObject({ kind: "model_not_installed" });
  });
});

describe("OllamaProvider: failures, retries, cancellation", () => {
  it("retries unavailable endpoints with backoff, then surfaces unavailable", async () => {
    let chatCalls = 0;
    const fake = fakeFetch((url) => {
      if (url.pathname === "/api/tags") return tags();
      chatCalls++;
      return new Response("boom", { status: 503 });
    });
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl, retries: 2, retryBaseDelayMs: 1 });
    await expect(provider.generate(input())).rejects.toMatchObject({ kind: "unavailable" });
    expect(chatCalls).toBe(3);
  });

  it("does not retry a malformed response", async () => {
    let chatCalls = 0;
    const fake = fakeFetch((url) => {
      if (url.pathname === "/api/tags") return tags();
      chatCalls++;
      return new Response("<html>", { status: 200 });
    });
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl, retries: 3, retryBaseDelayMs: 1 });
    await expect(provider.generate(input())).rejects.toMatchObject({ kind: "malformed_response" });
    expect(chatCalls).toBe(1);
  });

  it("aborts an in-flight request when the caller cancels", async () => {
    const controller = new AbortController();
    const fake = fakeFetch((url, init) => {
      if (url.pathname === "/api/tags") return tags();
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
      });
    });
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl, retries: 0 });
    const pending = provider.generate(input(controller.signal));
    setTimeout(() => controller.abort(), 20);
    await expect(pending).rejects.toBeInstanceOf(ProviderError);
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
  });

  it("bounds concurrency to maxConcurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    const fake = fakeFetch(async (url) => {
      if (url.pathname === "/api/tags") return tags();
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, 15));
      inFlight--;
      return chat("{}");
    });
    const provider = new OllamaProvider({ model: "qwen2.5-coder:7b", fetchImpl: fake.impl, maxConcurrency: 1 });
    await Promise.all([provider.generate(input()), provider.generate(input()), provider.generate(input())]);
    expect(peak).toBe(1);
  });

  it("rejects out-of-range safety settings", () => {
    expect(() => new OllamaProvider({ model: "m", maxConcurrency: 0 })).toThrow();
    expect(() => new OllamaProvider({ model: "m", maxConcurrency: 9 })).toThrow();
    expect(() => new OllamaProvider({ model: "m", retries: 10 })).toThrow();
    expect(() => new OllamaProvider({ model: "m", expectedDigest: "sha256:xyz" as `sha256:${string}` })).toThrow();
  });
});

describe("chatModelNames", () => {
  it("keeps completion models and drops non-chat capabilities", () => {
    const names = chatModelNames([
      { name: "nimble:latest", digest: DIGEST, capabilities: ["decision"] },
      { name: "embeddinggemma:latest", digest: DIGEST, capabilities: ["embedding"] },
      { name: "qwen2.5-coder:7b", digest: DIGEST, capabilities: ["completion", "tools"] },
      { name: "legacy:7b", digest: DIGEST }
    ]);
    expect([...names].sort()).toEqual(["legacy:7b", "qwen2.5-coder:7b"]);
  });
});

/** A body that streams `chunk` forever and records whether the reader cancelled it. */
function endlessBody(chunk: Uint8Array) {
  const state = { cancelled: false, pulls: 0 };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulls++;
      controller.enqueue(chunk);
    },
    cancel() {
      state.cancelled = true;
    }
  });
  return { body, state };
}

describe("OllamaProvider: response size caps", () => {
  it("aborts an oversized /api/chat body during the read", async () => {
    const stream = endlessBody(new Uint8Array(64 * 1024).fill(0x20));
    const provider = new OllamaProvider({
      model: "qwen2.5-coder:7b",
      fetchImpl: fakeFetch((url) => (url.pathname === "/api/tags" ? tags() : new Response(stream.body, { status: 200 }))).impl
    });
    await expect(provider.generate(input())).rejects.toMatchObject({ kind: "malformed_response" });
    expect(stream.state.cancelled).toBe(true);
    expect(stream.state.pulls * 64 * 1024).toBeLessThanOrEqual(MAX_CHAT_RESPONSE_BYTES + 3 * 64 * 1024);
  });

  it("aborts an oversized /api/tags body during the read", async () => {
    const stream = endlessBody(new Uint8Array(16 * 1024).fill(0x20));
    await expect(
      listInstalledOllamaModels({ fetchImpl: fakeFetch(() => new Response(stream.body, { status: 200 })).impl })
    ).rejects.toMatchObject({ kind: "malformed_response" });
    expect(stream.state.cancelled).toBe(true);
    expect(stream.state.pulls * 16 * 1024).toBeLessThanOrEqual(MAX_TAGS_RESPONSE_BYTES + 3 * 16 * 1024);
  });

  it("rejects a declared content-length above the cap without reading", async () => {
    const response = new Response("{}", { status: 200, headers: { "content-length": String(MAX_TAGS_RESPONSE_BYTES + 1) } });
    await expect(readBoundedJson(response, MAX_TAGS_RESPONSE_BYTES)).rejects.toBeInstanceOf(ProviderError);
  });

  it("parses a body under the cap", async () => {
    await expect(readBoundedJson(new Response('{"ok":true}'), 1024)).resolves.toEqual({ ok: true });
  });
});
