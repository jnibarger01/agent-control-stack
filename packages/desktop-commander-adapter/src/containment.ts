import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";

/**
 * Phase 4 - path / cwd containment.
 *
 * Every path-bearing Desktop Commander argument is canonicalised and proven to
 * resolve inside an ACS allow root before the MCP call. Symlinks in the existing
 * prefix are resolved (so a symlink cannot smuggle a path out of the allow
 * root); `..` escapes are rejected; credential/system paths are denied; targets
 * that do not exist yet (a new file for `write_file`) are contained by their
 * deepest existing ancestor.
 *
 * ACS is authoritative here. Desktop Commander's own `allowedDirectories` is a
 * defence-in-depth layer, not the decision point (its shipped default is
 * unrestricted).
 */

export interface ContainmentConfig {
  allowedRoots: readonly string[];
  deniedRoots: readonly string[];
}

// Credential / system paths are denied regardless of allow roots. Mirrors the
// pattern in packages/policy-gate/src/rules.ts and machine-controller/src/path.ts.
const restrictedPathPattern =
  /(^|\/)(\.env(\.|$)|\.git\/config$|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.gnupg(\/|$)|\.aws\/credentials$|\.aws\/config$|\.kube\/config$|\.npmrc$|\.netrc$|credentials(\.json)?$|token(\.json)?$|\.docker\/config\.json$)/i;

export interface ContainedPath {
  requested: string;
  canonical: string;
}

function canonicaliseExisting(target: string): string {
  // Resolve the deepest existing ancestor with realpath, then re-append the
  // not-yet-existing tail. This defeats symlink escapes in the existing prefix.
  let current = target;
  const tail: string[] = [];
  // Guard against pathological inputs.
  for (let i = 0; i < 4096; i += 1) {
    try {
      const real = realpathSync(current);
      return tail.length > 0 ? resolve(real, ...tail.reverse()) : real;
    } catch {
      const parent = resolve(current, "..");
      if (parent === current) {
        // Reached the filesystem root without an existing ancestor.
        return tail.length > 0 ? resolve(current, ...tail.reverse()) : current;
      }
      tail.push(current.slice(parent.length + 1));
      current = parent;
    }
  }
  throw new ControlStackError("desktop_commander_path_unresolvable", `path could not be canonicalised: ${target}`);
}

function isInside(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}${sep}`);
}

/**
 * Contain a single path. `baseCwd` (already contained) is the resolution base
 * for relative paths.
 */
export function containPath(config: ContainmentConfig, requested: string, baseCwd?: string): ContainedPath {
  if (typeof requested !== "string" || requested.length === 0) {
    throw new ControlStackError("desktop_commander_path_invalid", "path must be a non-empty string");
  }
  if (requested.includes("\0")) {
    throw new ControlStackError("desktop_commander_path_invalid", "path must not contain NUL");
  }
  if (/[\r\n]/.test(requested)) {
    throw new ControlStackError("desktop_commander_path_invalid", "path must not contain newlines");
  }
  // Defence in depth: reject any explicit parent-traversal segment in the raw
  // input even though canonicalisation would also collapse it.
  if (requested.split(/[/\\]/).some((segment) => segment === "..")) {
    throw new ControlStackError("desktop_commander_path_escape", `path contains a parent traversal: ${requested}`);
  }

  const base = baseCwd ? resolve(baseCwd) : config.allowedRoots[0];
  if (base === undefined) {
    throw new ControlStackError("desktop_commander_path_no_root", "no Desktop Commander allow root is configured");
  }
  const absolute = isAbsolute(requested) ? resolve(requested) : resolve(base, requested);
  const canonical = canonicaliseExisting(absolute);

  if (!config.allowedRoots.some((root) => isInside(root, canonical))) {
    throw new ControlStackError(
      "desktop_commander_path_outside_allow_root",
      `path resolves outside every allow root: ${requested}`
    );
  }
  if (config.deniedRoots.some((root) => isInside(root, canonical))) {
    throw new ControlStackError("desktop_commander_path_denied", `path resolves inside a denied root: ${requested}`);
  }
  if (restrictedPathPattern.test(requested) || restrictedPathPattern.test(canonical)) {
    throw new ControlStackError("desktop_commander_path_credential", `credential/system path is denied: ${requested}`);
  }

  return { requested, canonical };
}

/** Contain a working directory - it must additionally already exist. */
export function containCwd(config: ContainmentConfig, requested: string): ContainedPath {
  const contained = containPath(config, requested);
  try {
    realpathSync(contained.canonical);
  } catch {
    throw new ControlStackError("desktop_commander_cwd_missing", `working directory does not exist: ${requested}`);
  }
  return contained;
}
