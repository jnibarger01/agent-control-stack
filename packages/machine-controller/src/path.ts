import { realpathSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { ControlStackError } from "@agent-control-stack/shared";
import type { MachineControllerConfig } from "./config.js";

const restrictedPathPattern =
  /(^|\/)(\.env(\.|$)|id_rsa$|id_ed25519$|\.ssh(\/|$)|\.gnupg(\/|$)|\.aws\/credentials$|credentials(\.json)?$|token(\.json)?$)/i;

export interface SafePath {
  requestedPath: string;
  absolutePath: string;
  realPath: string;
}

export function resolveSafePath(
  config: MachineControllerConfig,
  requestedPath: string,
  options: { cwd?: string; allowRestricted?: boolean } = {}
): SafePath {
  const base = options.cwd ? resolve(options.cwd) : config.paths.allow[0];
  const absolutePath = isAbsolute(requestedPath) ? resolve(requestedPath) : resolve(base, requestedPath);
  const realPath = realpathSync(absolutePath);

  if (!isInsideAny(config.paths.allow, realPath)) {
    throw new ControlStackError("path_outside_allowlist", `path is outside allowed roots: ${requestedPath}`);
  }
  if (isInsideAny(config.paths.deny, realPath)) {
    throw new ControlStackError("path_denied", `path is denied by config: ${requestedPath}`);
  }
  if (!options.allowRestricted && (restrictedPathPattern.test(requestedPath) || restrictedPathPattern.test(realPath))) {
    throw new ControlStackError("path_restricted", `credential-like path is denied: ${requestedPath}`);
  }

  return { requestedPath, absolutePath, realPath };
}

export function isInside(root: string, target: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  return normalizedTarget === normalizedRoot || normalizedTarget.startsWith(`${normalizedRoot}${sep}`);
}

function isInsideAny(roots: string[], target: string): boolean {
  return roots.some((root) => isInside(root, target));
}
