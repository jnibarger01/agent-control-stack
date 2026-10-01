/**
 * `@agent-control-stack/webmcp-adapter`
 *
 * Governed WebMCP (Chrome 154+) execution surface for ACS.
 *
 * WebMCP is an execution surface, never a source of ACS authority. Chrome's
 * `document.modelContext` API lets a page expose tools; a page-supplied tool,
 * schema, annotation, title, or origin claim never authorizes anything. Every
 * permitted invocation is bound to an ACS work item and an ACS-issued
 * `WebMcpExecutionAuthorization`, and the whole lane is inert until the
 * live-execution gate is explicitly cleared (see `gate.ts`).
 *
 * Execution boundary: this adapter package owns process creation for its Chrome
 * child, mirroring `packages/desktop-commander-adapter` owning its stdio
 * runtime. Gateway, protocol, and policy code never spawn (AGENTS.md, "Sandbox
 * and Process Execution") — they reach WebMCP only through this package.
 */

export * from "./contracts.js";
export * from "./json.js";
export * from "./normalize.js";
export * from "./policy.js";
export * from "./gate.js";
export * from "./execution-authorization.js";
export * from "./audit.js";
export * from "./cdp.js";
export * from "./cdp-client.js";
export * from "./chrome-runtime.js";
export * from "./executor.js";
