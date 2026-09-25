#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, readdirSync, realpathSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

const releaseFile = "RELEASE.json";
const manifestFile = "RELEASE-MANIFEST.json";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const digest = (value) => sha256(JSON.stringify(value));

function assertReleaseDirectory(directory, allowStaging = false) {
  if (!isAbsolute(directory) || realpathSync(directory) !== directory || !lstatSync(directory).isDirectory()) {
    throw new Error("release must be a real absolute directory");
  }
  const component = basename(dirname(directory));
  if (component !== "acs" && !(allowStaging && component === "_staging")) {
    throw new Error("release is outside the ACS published directory");
  }
}

function entries(root, relative = "", allowedRoot = root) {
  const result = [];
  for (const name of readdirSync(join(root, relative)).sort()) {
    const path = relative ? `${relative}/${name}` : name;
    const absolute = join(root, path);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) result.push(...entries(root, path, allowedRoot));
    else if (stat.isFile()) result.push({ path, sha256: sha256(readFileSync(absolute)) });
    else if (stat.isSymbolicLink()) {
      const target = readlinkSync(absolute);
      const resolved = resolve(dirname(absolute), target);
      if (resolved !== allowedRoot && !resolved.startsWith(`${allowedRoot}${sep}`)) {
        throw new Error(`release symlink escapes root: ${path}`);
      }
      result.push({ path, link: target });
    } else throw new Error(`unsupported release entry: ${path}`);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function sourceFiles(directory) {
  const result = [];
  for (const name of readdirSync(directory).sort()) {
    if (name === "node_modules" || name === releaseFile || name === manifestFile) continue;
    const absolute = join(directory, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) result.push(...entries(directory, name));
    else if (stat.isFile()) result.push({ path: name, sha256: sha256(readFileSync(absolute)) });
    else throw new Error(`unsupported release entry: ${name}`);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path, "en"));
}

function dependencyFiles(directory) {
  const root = join(directory, "node_modules");
  if (!lstatSync(root).isDirectory() || realpathSync(root) !== root) throw new Error("release dependencies missing");
  return entries(root, "", directory);
}

function nodeIdentity(directory, path, version) {
  const root = dirname(dirname(directory));
  const expected = join(root, "_node", version, "bin/node");
  if (path !== expected || !/^v\d+\.\d+\.\d+$/.test(version)) throw new Error("pinned Node path invalid");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || realpathSync(path) !== path) {
    throw new Error("pinned Node binary invalid");
  }
  const actual = execFileSync(path, ["--version"], { encoding: "utf8", timeout: 5000 }).trim();
  if (actual !== version) throw new Error("pinned Node version mismatch");
  return { path, version, sha256: sha256(readFileSync(path)) };
}

function runtimeIdentity(files, nodeVersion) {
  const runtime = files.filter(({ path }) =>
    path === "package.json" || path === "package-lock.json" ||
    /^apps\/[^/]+\/dist\//.test(path) || /^packages\/[^/]+\/dist\//.test(path)
  );
  if (!runtime.some(({ path }) => path === "apps/gateway/dist/cli.js") ||
      !runtime.some(({ path }) => path === "package-lock.json") ||
      runtime.some(({ link }) => link !== undefined)) {
    throw new Error("ACS runtime inputs missing or linked");
  }
  return digest({ nodeVersion, files: runtime });
}

function readJson(directory, file) {
  const path = join(directory, file);
  if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error(`${file} invalid`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function createReleaseMetadata(directory, commit, nodePath) {
  assertReleaseDirectory(directory, true);
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("Git commit invalid");
  const version = basename(dirname(dirname(nodePath)));
  const node = nodeIdentity(directory, nodePath, version);
  const files = sourceFiles(directory);
  const manifest = { schemaVersion: 1, files };
  const release = {
    schemaVersion: 1,
    component: "acs",
    commit,
    node,
    runtimeIdentityDigest: runtimeIdentity(files, version),
    fullManifestDigest: digest(manifest),
    dependencyDigest: digest(dependencyFiles(directory))
  };
  writeFileSync(join(directory, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(directory, releaseFile), `${JSON.stringify(release, null, 2)}\n`);
  return release;
}

export function verifyRelease(directory, allowStaging = false) {
  assertReleaseDirectory(directory, allowStaging);
  const release = readJson(directory, releaseFile);
  const manifest = readJson(directory, manifestFile);
  if (release.schemaVersion !== 1 || release.component !== "acs" ||
      !/^[a-f0-9]{40}$/.test(release.commit) ||
      (!allowStaging && !basename(directory).startsWith(release.commit.slice(0, 7)))) {
    throw new Error("ACS release metadata invalid");
  }
  const node = nodeIdentity(directory, release.node?.path, release.node?.version);
  if (JSON.stringify(node) !== JSON.stringify(release.node)) throw new Error("pinned Node identity mismatch");
  const files = sourceFiles(directory);
  const expectedManifest = { schemaVersion: 1, files };
  if (JSON.stringify(manifest) !== JSON.stringify(expectedManifest) ||
      digest(manifest) !== release.fullManifestDigest) throw new Error("ACS release manifest mismatch");
  if (runtimeIdentity(files, node.version) !== release.runtimeIdentityDigest) {
    throw new Error("ACS runtime identity mismatch");
  }
  if (digest(dependencyFiles(directory)) !== release.dependencyDigest) {
    throw new Error("ACS release dependencies mismatch");
  }
  return release;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(new URL(import.meta.url).pathname)) {
  try {
    const [mode, directory, commit, nodePath] = process.argv.slice(2);
    const release = mode === "create" && nodePath
      ? createReleaseMetadata(directory, commit, nodePath)
      : mode === "verify" && !commit
        ? verifyRelease(directory)
        : mode === "verify" && commit === "--allow-staging"
          ? verifyRelease(directory, true)
          : (() => { throw new Error("usage: release-integrity.mjs create <dir> <commit> <node> | verify <dir> [--allow-staging]"); })();
    console.log(JSON.stringify(release));
  } catch (error) {
    console.error(`ACS release integrity: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  }
}
