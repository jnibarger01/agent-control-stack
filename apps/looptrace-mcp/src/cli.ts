#!/usr/bin/env node
import { LoopTraceQueryService, SCOPES, signGrant, type GrantPayload, type Scope } from "@agent-control-stack/looptrace-query";
import { configFromEnv, readKeyFile } from "./config.js";
import { LoopTraceMcpServer } from "./server.js";

/**
 *   acs-looptrace-mcp                 serve the three read-only tools over stdio
 *   acs-looptrace-mcp issue-grant ... operator utility: sign a grant (prints the token to stdout)
 *       --sub <id> --scopes trace,gaps,verify --visibility all|work_items:<id,..>|roots:<id,..>|requester:<s,..>|assigned:<id,..>
 *       --ttl-seconds <n (<= 86400)>      (key from LOOPTRACE_GRANT_KEY_FILE)
 *
 * The server never mints grants and never reads a grant from tool arguments.
 */
function issueGrant(argv: string[]): void {
  const arg = (name: string): string | undefined => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const keyFile = process.env.LOOPTRACE_GRANT_KEY_FILE;
  if (!keyFile) throw new Error("LOOPTRACE_GRANT_KEY_FILE is required");
  const sub = arg("--sub");
  if (!sub) throw new Error("--sub is required");
  const scopes = (arg("--scopes") ?? "trace,gaps,verify").split(",").map((s) => `looptrace:${s.trim()}`);
  for (const s of scopes) if (!(SCOPES as readonly string[]).includes(s)) throw new Error(`unknown scope ${s}`);
  const vis = arg("--visibility") ?? "";
  const [mode, rest = ""] = vis.split(":", 2) as [string, string?];
  const list = rest.split(",").filter(Boolean);
  const visibility: GrantPayload["visibility"] =
    mode === "all"
      ? { mode: "all" }
      : mode === "work_items" && list.length
        ? { mode: "work_items", ids: list }
        : mode === "roots" && list.length
          ? { mode: "roots", ids: list }
          : mode === "requester" && list.length
            ? { mode: "requester_subjects", subjects: list }
            : mode === "assigned" && list.length
              ? { mode: "assigned_to", ids: list }
              : (() => {
                  throw new Error("--visibility must be all | work_items:<ids> | roots:<ids> | requester:<subjects> | assigned:<ids>");
                })();
  const ttl = Math.min(Number(arg("--ttl-seconds") ?? 3600), 86400);
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Error("--ttl-seconds must be a positive integer");
  const now = Math.floor(Date.now() / 1000);
  process.stdout.write(`${signGrant({ v: 1, sub, scopes: scopes as Scope[], visibility, iat: now, exp: now + ttl }, readKeyFile(keyFile))}\n`);
}

function serve(): void {
  const { config, grant } = configFromEnv(process.env);
  if (!config.acsDbPath) throw new Error("LOOPTRACE_ACS_DB is required");
  if (!config.grantKey) throw new Error("LOOPTRACE_GRANT_KEY_FILE is required");
  const service = new LoopTraceQueryService(config);
  new LoopTraceMcpServer(process.stdin, process.stdout, service, grant).start();
}

try {
  if (process.argv[2] === "issue-grant") issueGrant(process.argv.slice(3));
  else serve();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
