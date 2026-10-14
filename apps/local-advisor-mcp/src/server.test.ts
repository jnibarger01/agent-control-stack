import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { type AdvisorResponse } from "@agent-control-stack/local-advisor";
import { LocalAdvisorMcpServer, PROTOCOL_VERSION, TOOL_DEFINITIONS } from "./server.js";

const HASH = `sha256:${"ab".repeat(32)}`;

function failed(): AdvisorResponse {
  return {
    schemaVersion: "advisor.v1",
    requestId: "req-1",
    missionId: "mission-1",
    operation: "review_plan",
    status: "unavailable",
    reason: "provider_unavailable",
    findings: [],
    recommendedActions: [],
    model: null,
    inputHash: HASH,
    evidenceHashes: { "diff-1": HASH },
    usage: { latencyMs: 1 }
  };
}

function harness(
  run: LocalAdvisorMcpServer extends never ? never : ConstructorParameters<typeof LocalAdvisorMcpServer>[2]
) {
  const input = new PassThrough();
  const output = new PassThrough();
  const chunks: Buffer[] = [];
  output.on("data", (chunk: Buffer) => chunks.push(chunk));
  const server = new LocalAdvisorMcpServer(input, output, run);
  server.start();
  const text = () => Buffer.concat(chunks).toString("utf8");
  const send = (message: unknown) => {
    const body = JSON.stringify(message);
    input.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  return { input, server, send, text };
}

async function settle(server: LocalAdvisorMcpServer): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
  await server.idle();
}

function frames(
  text: string
): Array<{ result?: { isError?: boolean; structuredContent?: AdvisorResponse; protocolVersion?: string } }> {
  const out: Array<{ result?: { isError?: boolean; structuredContent?: AdvisorResponse; protocolVersion?: string } }> =
    [];
  let rest = text;
  while (rest.length > 0) {
    const sep = rest.indexOf("\r\n\r\n");
    if (sep < 0) break;
    const match = /content-length:\s*(\d+)/iu.exec(rest.slice(0, sep));
    const len = match ? Number(match[1]) : 0;
    const start = sep + 4;
    out.push(JSON.parse(rest.slice(start, start + len)));
    rest = rest.slice(start + len);
  }
  return out;
}

const args = {
  requestId: "req-1",
  mission: { id: "mission-1", envelopeHash: HASH },
  context: {
    objective: "Review the change",
    evidence: [{ id: "diff-1", kind: "diff", content: "return a - b" }]
  },
  budget: { timeoutMs: 5000, maxOutputTokens: 128 }
};

describe("local advisor MCP", () => {
  it("lists exactly the three read-only tools and negotiates the contract version", async () => {
    const h = harness(async () => failed());
    h.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } });
    h.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await settle(h.server);
    const [init, list] = frames(h.text());
    expect(init?.result?.protocolVersion).toBe(PROTOCOL_VERSION);
    const tools =
      (list?.result as { tools?: { name: string; annotations?: { readOnlyHint?: boolean } }[] } | undefined)?.tools ??
      [];
    expect(tools.map((tool) => tool.name)).toEqual(TOOL_DEFINITIONS.map((tool) => tool.name));
    expect(tools.every((tool) => tool.annotations?.readOnlyHint === true)).toBe(true);
  });

  it("returns an explicit non-success status and no verdict when inference fails", async () => {
    const h = harness(async () => failed());
    h.send({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "advisor_review_plan", arguments: args } });
    await settle(h.server);
    const [frame] = frames(h.text());
    expect(frame?.result?.isError).toBe(false);
    expect(frame?.result?.structuredContent?.status).toBe("unavailable");
    expect(frame?.result?.structuredContent?.verdict).toBeUndefined();
  });

  it("rejects a tool argument that is not an advisor request, without calling the runner", async () => {
    let calls = 0;
    const h = harness(async () => {
      calls += 1;
      return failed();
    });
    h.send({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "advisor_review_plan", arguments: { requestId: "nope" } }
    });
    await settle(h.server);
    const [frame] = frames(h.text());
    expect(frame?.result?.isError).toBe(true);
    expect(calls).toBe(0);
  });

  it("cancels an in-flight review", async () => {
    let seen = false;
    const h = harness(async (_request, signal) => {
      seen = true;
      await new Promise<void>((resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return failed();
    });
    h.send({
      jsonrpc: "2.0",
      id: 9,
      method: "tools/call",
      params: { name: "advisor_diagnose_failure", arguments: args }
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 9 } });
    await settle(h.server);
    expect(seen).toBe(true);
    const [frame] = frames(h.text());
    expect(frame?.result?.isError).toBe(true);
  });

  it("keys in-flight requests by id type and value, and rejects duplicate ids", async () => {
    const signals: AbortSignal[] = [];
    const h = harness(async (_request, signal) => {
      signals.push(signal);
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      });
      return failed();
    });
    const call = (id: unknown) => ({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "advisor_review_plan", arguments: args }
    });
    h.send(call(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.send(call("1"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    h.send(call(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals).toHaveLength(2);

    const duplicate = frames(h.text()) as Array<{ id?: unknown; error?: { message?: string } }>;
    expect(duplicate).toHaveLength(1);
    expect(duplicate[0]).toMatchObject({ id: 1, error: { message: "duplicate request id" } });

    // Cancelling the string id must not abort the numeric request with the same digits.
    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: "1" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(signals[1]?.aborted).toBe(true);
    expect(signals[0]?.aborted).toBe(false);

    h.send({ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 1 } });
    await settle(h.server);
    expect(signals[0]?.aborted).toBe(true);
  });

  it.each(["abc", "12abc", "1e3"])("refuses a non-numeric Content-Length header %j", async (value) => {
    let calls = 0;
    const h = harness(async () => {
      calls++;
      return failed();
    });
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
    h.input.write(`Content-Length: ${value}\r\n\r\n${body}`);
    await settle(h.server);
    expect(h.text()).toContain("invalid or oversized frame");
    expect(h.text()).not.toContain('"result"');
    expect(calls).toBe(0);
  });

  it.each([[{ a: 1 }], [[1]], [true]])(
    "rejects a JSON-RPC id that is not a string, number or null (%j)",
    async (badId) => {
      let calls = 0;
      const h = harness(async () => {
        calls++;
        return failed();
      });
      h.send({
        jsonrpc: "2.0",
        id: badId,
        method: "tools/call",
        params: { name: "advisor_review_plan", arguments: args }
      });
      h.send({ jsonrpc: "2.0", id: null, method: "ping" });
      await settle(h.server);
      const out = frames(h.text()) as Array<{ id?: unknown; error?: { message?: string }; result?: unknown }>;
      expect(out[0]).toMatchObject({ id: null, error: { message: "invalid request id" } });
      expect(out[1]).toMatchObject({ id: null, result: {} });
      expect(calls).toBe(0);
    }
  );

  it("keeps framing undecided until a split Content-Length header is identifiable", async () => {
    const h = harness(async () => failed());
    const body = JSON.stringify({ jsonrpc: "2.0", id: 7, method: "ping" });
    const frame = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
    for (const piece of [frame.slice(0, 3), frame.slice(3, 7), frame.slice(7)]) {
      h.input.write(piece);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await settle(h.server);
    expect(frames(h.text())[0]).toMatchObject({ id: 7, result: {} });
  });
});
