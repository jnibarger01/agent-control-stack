import { readFileSync } from "node:fs";
import { EvidenceReader } from "@agent-control-stack/evidence";
import { computeWorkspaceRevision } from "@agent-control-stack/evidence";
import { authorizeReviewer } from "./authorize.js";
import { SqliteEvidenceStoreReader } from "./store-reader.js";
import { EvidenceMcpServer } from "./server.js";

/**
 * `acs-evidence-mcp` — a standalone stdio MCP server that serves ONE attempt's
 * read-only evidence to a reviewer holding an `acs:evidence:read` grant.
 *
 *   ACS_DB_PATH                 (default storage/local.db)
 *   ACS_EVIDENCE_GRANT_JSON     inline reviewer grant JSON, or
 *   ACS_EVIDENCE_GRANT_FILE     path to a file containing it
 *   ACS_EVIDENCE_ENFORCE_REVISION=1  recompute the live workspace revision and
 *                              require it to match the grant (TOCTOU)
 */
async function main(): Promise<void> {
  const dbPath = process.env.ACS_DB_PATH ?? "storage/local.db";
  const grantJsonRaw =
    process.env.ACS_EVIDENCE_GRANT_JSON ??
    (process.env.ACS_EVIDENCE_GRANT_FILE ? readFileSync(process.env.ACS_EVIDENCE_GRANT_FILE, "utf8") : undefined);
  if (!grantJsonRaw) {
    throw new Error("ACS_EVIDENCE_GRANT_JSON or ACS_EVIDENCE_GRANT_FILE is required");
  }
  const grantJson = JSON.parse(grantJsonRaw) as unknown;

  // First pass: authorize against the persisted grant (attempt + revision bound).
  const pre = authorizeReviewer({ dbPath, grantJson });

  let liveWorkspaceRevision: string | undefined;
  if (process.env.ACS_EVIDENCE_ENFORCE_REVISION === "1") {
    liveWorkspaceRevision = (await computeWorkspaceRevision(pre.workspaceHostPath)).revision;
  }
  const authorized = authorizeReviewer({ dbPath, grantJson, liveWorkspaceRevision });

  const store = new SqliteEvidenceStoreReader(dbPath);
  const reader = new EvidenceReader({
    workItemId: authorized.workItemId,
    attemptId: authorized.attemptId,
    workspaceHostPath: authorized.workspaceHostPath,
    store
  });

  process.on("SIGINT", () => {
    store.close();
    process.exit(0);
  });

  new EvidenceMcpServer(process.stdin, process.stdout, reader).start();
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
