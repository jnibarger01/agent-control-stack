import { spawn } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CLI_CATALOG,
  AGENT_CLI_IDS,
  AGENT_GOVERNANCE,
  type AgentCliId,
  type AgentCliSpec,
  type AgentGovernance
} from "./catalog.js";

export interface AgentCliProbe {
  id: AgentCliId;
  displayName: string;
  provider: string;
  installed: boolean;
  binaryPath?: string;
  version?: string;
  /** Catalog flags were verified against a different major/minor than what is installed. */
  versionDrift: boolean;
  verifiedAgainst: string;
  /** A login/config directory exists. This is a hint, not proof the session is valid. */
  loginDetected: boolean;
  readOnlySupported: boolean;
  editContainment: string;
  governance: AgentGovernance;
  governanceSummary: string;
  /** Why dispatch is refused for this CLI right now, if it is. */
  dispatchBlockedReason?: string;
  error?: string;
}

export function resolveBinary(name: string, pathValue = process.env.PATH ?? ""): string | undefined {
  for (const directory of pathValue.split(":")) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return undefined;
}

export function runVersion(binary: string, args: readonly string[], timeoutMs = 8_000): Promise<string | undefined> {
  return new Promise((resolve) => {
    let out = "";
    let settled = false;
    const finish = (value: string | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    // Version probes get a minimal environment: no provider credentials, no ACS secrets.
    const child = spawn(binary, [...args], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? homedir() }
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(undefined);
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (out.length < 2_000) out += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (out.length < 2_000) out += chunk.toString("utf8");
    });
    child.on("error", () => finish(undefined));
    child.on("close", () => finish(out.trim().split("\n")[0]?.slice(0, 200) || undefined));
  });
}

/** Pull the first dotted version out of a banner line, e.g. "2.1.284 (Claude Code)". */
export function parseVersion(line: string | undefined): string | undefined {
  return line?.match(/\d+(?:\.\d+)+/u)?.[0];
}

export function versionDrifted(installed: string | undefined, verified: string): boolean {
  if (!installed) return false;
  const a = installed.split(".");
  const b = verified.split(".");
  return a[0] !== b[0] || a[1] !== b[1];
}

export async function probeAgentCli(
  spec: AgentCliSpec,
  options: { pathValue?: string; home?: string } = {}
): Promise<AgentCliProbe> {
  const home = options.home ?? process.env.HOME ?? homedir();
  const base = {
    id: spec.id,
    displayName: spec.displayName,
    provider: spec.provider,
    verifiedAgainst: spec.verifiedAgainst,
    readOnlySupported: spec.readOnlySupported,
    editContainment: spec.editContainment,
    governance: AGENT_GOVERNANCE[spec.id].level,
    governanceSummary: AGENT_GOVERNANCE[spec.id].summary,
    ...(spec.dispatchBlockedReason ? { dispatchBlockedReason: spec.dispatchBlockedReason } : {}),
    loginDetected: spec.loginPaths.some((path) => existsSync(join(home, path)))
  };
  const binaryPath = resolveBinary(spec.binary, options.pathValue);
  if (!binaryPath) return { ...base, installed: false, versionDrift: false };
  const version = parseVersion(await runVersion(binaryPath, spec.versionArgs));
  return {
    ...base,
    installed: true,
    binaryPath,
    ...(version ? { version } : { error: "version probe returned nothing" }),
    versionDrift: versionDrifted(version, spec.verifiedAgainst)
  };
}

export async function probeAllAgentClis(options: { pathValue?: string; home?: string } = {}): Promise<AgentCliProbe[]> {
  return Promise.all(AGENT_CLI_IDS.map((id) => probeAgentCli(AGENT_CLI_CATALOG[id], options)));
}
