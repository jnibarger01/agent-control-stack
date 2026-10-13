import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { HealthTarget } from "../types.js";

/**
 * Independent, read-only observers. Callers can only pass a component NAME or a target NAME;
 * paths and URLs come exclusively from operator configuration.
 */

export interface InstalledRelease {
  component: string;
  dir: string;
  commit: string;
  dirMatchesCommit: boolean;
}

const COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const COMMIT = /^[a-f0-9]{40}$/u;

/** Lists installed releases for a component: `<root>/<component>/<sha7>-label/RELEASE.json`. */
export function observeInstalledReleases(roots: string[], component: string): InstalledRelease[] | null {
  if (!COMPONENT.test(component)) return null;
  const found: InstalledRelease[] = [];
  let anyRoot = false;
  for (const root of roots) {
    const base = join(root, component);
    let entries: string[];
    try {
      // Symlinked roots are never followed (matches the release-integrity rule).
      if (lstatSync(base).isSymbolicLink()) continue;
      entries = readdirSync(base).slice(0, 200);
      anyRoot = true;
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(base, name);
      try {
        const st = lstatSync(dir);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        const file = join(dir, "RELEASE.json");
        const fst = lstatSync(file);
        if (!fst.isFile() || fst.size > 64 * 1024) continue;
        const json = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
        if (json.component !== component || typeof json.commit !== "string" || !COMMIT.test(json.commit)) continue;
        found.push({ component, dir: name, commit: json.commit, dirMatchesCommit: name.startsWith(json.commit.slice(0, 7)) });
      } catch {
        continue;
      }
    }
  }
  return anyRoot ? found : null;
}

export type FetchLike = (
  url: string,
  init: { method: "GET"; redirect: "error"; signal: AbortSignal; headers: Record<string, string> }
) => Promise<{ status: number; text(): Promise<string> }>;

export interface HealthObservation {
  target: string;
  outcome: "healthy" | "unhealthy" | "unreachable" | "unknown_target";
  http_status: number | null;
  detail: string;
}

export async function observeHealth(
  targets: HealthTarget[],
  name: string,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = 2000
): Promise<HealthObservation> {
  const target = targets.find((t) => t.name === name);
  if (!target) return { target: name.slice(0, 64), outcome: "unknown_target", http_status: null, detail: "target is not in the operator-configured allowlist" };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(target.url, { method: "GET", redirect: "error", signal: ctl.signal, headers: { accept: "application/json,text/plain" } });
    // The body is deliberately never read into the result: it is untrusted and could carry instructions.
    return {
      target: name,
      outcome: res.status >= 200 && res.status < 300 ? "healthy" : "unhealthy",
      http_status: res.status,
      detail: `HTTP ${res.status}`
    };
  } catch (error) {
    const code = error instanceof Error ? (error.name === "AbortError" ? "timeout" : error.name) : "error";
    return { target: name, outcome: "unreachable", http_status: null, detail: `transport failure: ${String(code).slice(0, 40)}` };
  } finally {
    clearTimeout(timer);
  }
}
