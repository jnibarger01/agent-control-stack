/**
 * Architecture gate: Desktop Commander's privileged execution path cannot
 * reach a tool handler without its own ACS capability validation (ADR 0019,
 * invariants 2 and 3).
 *
 * This is a structural check over vendor/desktop-commander/src/server.ts. It
 * complements the behavioural proof in acs-dc-mcp/dc-final-enforcement.test.ts
 * (every tool, real DC child, no capability -> rejected, executor untouched).
 * If the call handler is restructured, update both deliberately; never delete
 * the gate to get green.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS } from "@agent-control-stack/dc-tool-manifest";

const DC_SRC = new URL("../../vendor/desktop-commander/src/", import.meta.url);
const serverSource = readFileSync(new URL("server.ts", DC_SRC), "utf8");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return entry === "ui" ? [] : sourceFiles(path);
    return path.endsWith(".ts") ? [path] : [];
  });
}

function functionBody(source: string, signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} not found`).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = source.indexOf("{", start); index < source.length; index++) {
    if (source[index] === "{") depth++;
    if (source[index] === "}" && --depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated ${signature}`);
}

describe("Desktop Commander enforcement architecture", () => {
  it("routes every MCP tools/call in the DC server through handleCallToolRequest", () => {
    const registrations = serverSource.match(/setRequestHandler\(CallToolRequestSchema/gu) ?? [];
    expect(registrations).toHaveLength(1);
    const handler = functionBody(serverSource, "server.setRequestHandler(CallToolRequestSchema");
    expect(handler).toContain("handleCallToolRequest(request)");
  });

  it("validates the ACS capability, then runs the fail-closed kernel, before any tool dispatch", () => {
    const body = functionBody(serverSource, "async function handleCallToolRequest(");
    const authorize = body.indexOf("await authorizeManagedToolCall(name, toolArguments, request.params._meta)");
    const deniedReturn = body.indexOf("return managedAuthorizationErrorResult(error);");
    const kernel = body.indexOf("await preExecuteEnforcement(");
    const blocked = body.indexOf("if (!gate.allowed) {");
    const dispatch = body.indexOf("switch (name) {");
    for (const [label, index] of Object.entries({ authorize, deniedReturn, kernel, blocked, dispatch })) {
      expect(index, `${label} missing from handleCallToolRequest`).toBeGreaterThan(-1);
    }
    expect(authorize).toBeLessThan(deniedReturn);
    expect(deniedReturn).toBeLessThan(kernel);
    expect(kernel).toBeLessThan(blocked);
    expect(blocked).toBeLessThan(dispatch);
  });

  it("exempts only the manifest's capability-optional discovery tool, and only without a presented capability", () => {
    const body = functionBody(serverSource, "async function handleCallToolRequest(");
    const exemption = /const verifyManagedAuthorization = (.+);/u.exec(body)?.[1];
    expect(exemption).toBe(`name !== '${DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS[0]}' || presentsAcsCapability`);
    expect(DC_CAPABILITY_OPTIONAL_DISCOVERY_TOOLS).toHaveLength(1);
  });

  it("keeps the relay a transport: no ACS capability handling, issuance, or OS execution in apps/dc-relay", () => {
    const relayRoot = new URL("../../apps/dc-relay/src/", import.meta.url).pathname;
    for (const file of sourceFiles(relayRoot)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of [
        /acsCapability/iu,
        /capability\/issue/u,
        /node:child_process|from 'child_process'/u,
        /\bspawn\(|\bexecSync\(|\bexecFile\(/u
      ]) {
        expect(forbidden.test(source), `${relative(relayRoot, file)} matches ${forbidden}`).toBe(false);
      }
    }
  });

  it("has no other tools/call entry point that could bypass the managed guard", () => {
    // Known additional MCP servers shipped in the DC package. Each delegates
    // to a managed child or enforces its own ACS contract; a new one must be
    // reviewed and added here deliberately.
    const reviewed: Record<string, string> = {
      "server.ts": "the Desktop Commander server itself (gated above)",
      "openclaw-bridge/index.ts": "transport: requests an ACS capability, then calls the managed child",
      "jace-commander/server.ts": "separate acs.jc.v1 contract, re-verified by the privileged helper"
    };
    const root = new URL(".", DC_SRC).pathname;
    const handlers = sourceFiles(root)
      .filter((file) => readFileSync(file, "utf8").includes("setRequestHandler(CallToolRequestSchema"))
      .map((file) => relative(root, file))
      .sort();
    expect(handlers).toEqual(Object.keys(reviewed).sort());
  });
});
