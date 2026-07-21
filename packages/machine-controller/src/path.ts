import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  containmentPlatform,
  isPathContained,
  type ContainmentPlatform,
  resolveContainmentPath
} from "@agent-control-stack/shared";
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
  const realPath = resolveExistingPath(absolutePath);

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

export function isInside(root: string, target: string, platform: ContainmentPlatform = containmentPlatform()): boolean {
  return isPathContained(resolveContainmentPath(root, platform), resolveContainmentPath(target, platform), platform);
}

function isInsideAny(roots: string[], target: string): boolean {
  return roots.some((root) => isInside(root, target));
}

function resolveExistingPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(path);
    if (parent === path) {
      throw new ControlStackError("path_invalid", `path cannot be resolved: ${path}`);
    }
    return join(resolveExistingPath(parent), basename(path));
  }
}
