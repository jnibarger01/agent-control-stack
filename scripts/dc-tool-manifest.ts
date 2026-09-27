/**
 * Generate or check the Desktop Commander tool-contract artifacts derived from
 * @agent-control-stack/dc-tool-manifest (ADR 0019).
 *
 *   tsx scripts/dc-tool-manifest.ts --check   # CI: fail on any drift
 *   tsx scripts/dc-tool-manifest.ts           # rewrite the generated files
 *
 * Generated (byte-for-byte, Prettier-formatted with the repo config):
 *   contracts/desktop-commander/managed-tool-coverage.v1.json
 *   vendor/desktop-commander/test/fixtures/acs-managed-tool-coverage.v1.json
 *
 * Checked (manifest-owned fields; the conformance cases stay hand-written):
 *   contracts/desktop-commander/authorization-arguments.v1.json
 *   vendor/desktop-commander/test/fixtures/acs-authorization-arguments.v1.json (byte-identical copy)
 *
 * Desktop Commander's own suite pins the SHA-256 of both fixtures, so a real
 * contract change must also update test/test-managed-authorization-contract.js
 * in vendor/desktop-commander; this script reports the new digests.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  AUTHORIZATION_ARGUMENTS_PATH,
  MANAGED_TOOL_COVERAGE_PATH,
  authorizationArgumentsMetadata,
  dcCapabilityToolContract,
  managedToolCoverageDocument
} from "../packages/dc-tool-manifest/src/index.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.includes("--check");
const DC_FIXTURES = "vendor/desktop-commander/test/fixtures";
const failures: string[] = [];

async function renderJson(relativePath: string, value: unknown): Promise<string> {
  const filepath = resolve(repositoryRoot, relativePath);
  const config = (await resolveConfig(filepath)) ?? {};
  return format(JSON.stringify(value, null, 2), { ...config, parser: "json", filepath });
}

async function readText(relativePath: string): Promise<string> {
  return readFile(resolve(repositoryRoot, relativePath), "utf8");
}

async function emit(relativePath: string, expected: string): Promise<void> {
  const actual = await readText(relativePath).catch(() => undefined);
  if (actual === expected) return;
  if (checkOnly) {
    failures.push(`${relativePath} is out of date with the dc-tool-manifest; run npm run dc-contracts:generate`);
    return;
  }
  await writeFile(resolve(repositoryRoot, relativePath), expected);
  console.log(`wrote ${relativePath}`);
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

// 1. managed-tool coverage: fully generated.
const coverage = await renderJson(MANAGED_TOOL_COVERAGE_PATH, managedToolCoverageDocument());
await emit(MANAGED_TOOL_COVERAGE_PATH, coverage);
await emit(`${DC_FIXTURES}/acs-managed-tool-coverage.v1.json`, coverage);

// 2. authorization arguments: manifest-owned fields + case tool names.
const authorizationText = await readText(AUTHORIZATION_ARGUMENTS_PATH);
const authorization = JSON.parse(authorizationText) as {
  transportMetadataKeys: unknown;
  transportMetadataValues: unknown;
  cases: Array<{ name: string; tool: string }>;
};
const metadata = authorizationArgumentsMetadata();
if (JSON.stringify(authorization.transportMetadataKeys) !== JSON.stringify(metadata.transportMetadataKeys)) {
  failures.push(`${AUTHORIZATION_ARGUMENTS_PATH}: transportMetadataKeys differ from the manifest`);
}
if (JSON.stringify(authorization.transportMetadataValues) !== JSON.stringify(metadata.transportMetadataValues)) {
  failures.push(`${AUTHORIZATION_ARGUMENTS_PATH}: transportMetadataValues differ from the manifest`);
}
for (const testCase of authorization.cases) {
  if (!dcCapabilityToolContract(testCase.tool)) {
    failures.push(
      `${AUTHORIZATION_ARGUMENTS_PATH}: case "${testCase.name}" names non-capability tool ${testCase.tool}`
    );
  }
}
await emit(`${DC_FIXTURES}/acs-authorization-arguments.v1.json`, authorizationText);

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}
console.log(
  [
    `dc-tool-manifest artifacts ${checkOnly ? "verified" : "up to date"}.`,
    `  acs-authorization-arguments.v1.json sha256 ${sha256(authorizationText)}`,
    `  acs-managed-tool-coverage.v1.json   sha256 ${sha256(coverage)}`
  ].join("\n")
);
