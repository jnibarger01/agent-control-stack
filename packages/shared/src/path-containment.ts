import { posix, win32 } from "node:path";

export type ContainmentPlatform = "posix" | "win32";

export function containmentPlatform(platform: NodeJS.Platform = process.platform): ContainmentPlatform {
  return platform === "win32" ? "win32" : "posix";
}

export function resolveContainmentPath(input: string, platform: ContainmentPlatform = containmentPlatform()): string {
  const pathApi = platform === "win32" ? win32 : posix;
  const resolved = pathApi.resolve(input);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function isPathContained(
  root: string,
  target: string,
  platform: ContainmentPlatform = containmentPlatform()
): boolean {
  const pathApi = platform === "win32" ? win32 : posix;
  const normalizedRoot = resolveContainmentPath(root, platform);
  const normalizedTarget = resolveContainmentPath(target, platform);
  const relative = pathApi.relative(normalizedRoot, normalizedTarget);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${pathApi.sep}`) && !pathApi.isAbsolute(relative));
}
