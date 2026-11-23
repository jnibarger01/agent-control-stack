#!/usr/bin/env node
// Builds the Rust native artifacts for the verified Linux x86-64 glibc target and installs
// the graph addon into packages/integration-manager/native. Explicit only: nothing runs this
// on install. Fails closed on any other platform, on a failed cargo build, or on an addon
// whose ABI does not match the TypeScript bridge.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const graphManifest = join(root, "rust/integration-graph/Cargo.toml");
const supervisorManifest = join(root, "rust/scope-supervisor/Cargo.toml");
const graphLibrary = join(root, "rust/integration-graph/target/release/libacs_integration_graph.so");
const graphAddonBuild = join(root, "rust/integration-graph/acs_integration_graph.node");
const graphAddonInstalled = join(root, "packages/integration-manager/native/acs_integration_graph.node");
const bridgePath = join(root, "packages/integration-manager/native/bridge.cjs");
const supervisorBinary = join(root, "rust/scope-supervisor/target/release/acs-scope-supervisor");
const coreVerifierManifest = join(root, "rust/acs-core/Cargo.toml");
const coreVerifierBinary = join(root, "rust/acs-core/target/release/acs-audit-verify");
const coreManifest = join(root, "rust/acs-core-node/Cargo.toml");
const coreLibrary = join(root, "rust/acs-core-node/target/release/libacs_core_node.so");
const coreAddonInstalled = join(root, "packages/shared/native/acs_core.node");

function fail(message) {
  console.error(`build:native: ${message}`);
  process.exit(1);
}

function cargoBuild(manifest) {
  const result = spawnSync("cargo", ["build", "--locked", "--release", "--manifest-path", manifest], {
    cwd: root,
    stdio: "inherit",
    shell: false
  });
  if (result.error) fail(`cargo could not start: ${result.error.code ?? "error"}`);
  if (result.status !== 0) fail(`cargo build failed for ${manifest.replace(`${root}/`, "")} (exit ${result.status})`);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

if (process.platform !== "linux" || process.arch !== "x64") {
  fail(
    `native build is verified only for linux x64 glibc (this host: ${process.platform} ${process.arch}). ` +
      "Other targets keep the TypeScript backend."
  );
}

cargoBuild(graphManifest);
if (!existsSync(graphLibrary)) fail(`expected build output is missing: ${graphLibrary}`);
mkdirSync(dirname(graphAddonInstalled), { recursive: true });
copyFileSync(graphLibrary, graphAddonBuild);
copyFileSync(graphAddonBuild, graphAddonInstalled);

// Verify the installed addon before reporting success: ABI must match the TypeScript bridge.
const require = createRequire(import.meta.url);
let bridge;
try {
  const adapter = require(bridgePath);
  bridge = adapter.createGraphBridge(require(graphAddonInstalled));
} catch (error) {
  fail(`installed addon failed ABI verification: ${error instanceof Error ? error.name : "error"}`);
}
if (typeof bridge?.analyzeDependencies !== "function") fail("installed addon did not expose the graph bridge");

cargoBuild(supervisorManifest);
if (!existsSync(supervisorBinary)) fail(`expected build output is missing: ${supervisorBinary}`);
if (!(statSync(supervisorBinary).mode & 0o111)) fail("scope supervisor binary is not executable");

cargoBuild(coreVerifierManifest);
if (!existsSync(coreVerifierBinary)) fail(`expected build output is missing: ${coreVerifierBinary}`);
if (!(statSync(coreVerifierBinary).mode & 0o111)) fail("audit verifier binary is not executable");

cargoBuild(coreManifest);
if (!existsSync(coreLibrary)) fail(`expected build output is missing: ${coreLibrary}`);
mkdirSync(dirname(coreAddonInstalled), { recursive: true });
copyFileSync(coreLibrary, coreAddonInstalled);
// The core addon must report the ABI version the TypeScript selector expects.
let coreAbi;
try {
  coreAbi = require(coreAddonInstalled).coreAbiVersion();
} catch {
  fail("installed core addon failed to load");
}
if (typeof require(coreAddonInstalled).verifyAuditDatabase !== "function" || coreAbi !== 1) {
  fail(`installed core addon ABI ${coreAbi} does not match the expected version 1`);
}

console.log(
  JSON.stringify({
    target: "x86_64-unknown-linux-gnu",
    graphAddon: { path: graphAddonInstalled.replace(`${root}/`, ""), sha256: sha256(graphAddonInstalled) },
    scopeSupervisor: { path: supervisorBinary.replace(`${root}/`, ""), sha256: sha256(supervisorBinary) },
    coreAddon: { path: coreAddonInstalled.replace(`${root}/`, ""), sha256: sha256(coreAddonInstalled) }
  })
);
