import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

type PackageManifest = {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  overrides?: Record<string, unknown>;
};

type Lockfile = {
  packages: Record<string, { version?: string }>;
};

const ROOT = new URL("..", import.meta.url).pathname;

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, "utf8")) as T;
}

function workspaceManifests(): Array<{ path: string; manifest: PackageManifest }> {
  const found: Array<{ path: string; manifest: PackageManifest }> = [
    { path: "package.json", manifest: readJson<PackageManifest>(join(ROOT, "package.json")) }
  ];
  for (const directory of ["apps", "packages"]) {
    for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const relative = join(directory, entry.name, "package.json");
      found.push({ path: relative, manifest: readJson<PackageManifest>(join(ROOT, relative)) });
    }
  }
  return found;
}

function rangeSatisfiedBy(range: string, version: string): boolean {
  if (range === version) return true;
  const caret = /^(\d+)\.(\d+)\.(\d+)$/.exec(range.startsWith("^") ? range.slice(1) : "");
  const locked = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!range.startsWith("^") || caret === null || locked === null) return false;
  const wanted = caret.slice(1).map(Number);
  const actual = locked.slice(1).map(Number);
  if (actual[0] !== wanted[0]) return false;
  if ((actual[1] ?? 0) !== (wanted[1] ?? 0)) return (actual[1] ?? 0) > (wanted[1] ?? 0);
  return (actual[2] ?? 0) >= (wanted[2] ?? 0);
}

describe("fastify security override", () => {
  it("matches the locked fastify version required by npm ci", () => {
    const root = readJson<PackageManifest>(join(ROOT, "package.json"));
    const lock = readJson<Lockfile>(join(ROOT, "package-lock.json"));
    const override = root.overrides?.fastify;
    const locked = lock.packages["node_modules/fastify"]?.version;

    expect(override, "root overrides.fastify must be an exact version").toEqual(locked);
    expect(locked).toMatch(/^\d+\.\d+\.\d+$/);

    const mismatches = workspaceManifests().flatMap(({ path, manifest }) => {
      const declared = [manifest.dependencies?.fastify, manifest.devDependencies?.fastify].filter(
        (range): range is string => range !== undefined
      );
      return declared
        .filter((range) => !rangeSatisfiedBy(range, String(locked)))
        .map((range) => `${path} declares ${range} but lockfile resolved ${locked}`);
    });
    expect(mismatches).toEqual([]);
  });
});
