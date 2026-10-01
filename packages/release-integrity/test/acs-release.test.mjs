import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReleaseMetadata, verifyRelease } from "../src/index.js";

const commit = "a".repeat(40);

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "acs-release-integrity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const version = "v24.18.0";
  const nodePath = join(root, "_node", version, "bin/node");
  mkdirSync(join(root, "_node", version, "bin"), { recursive: true });
  writeFileSync(nodePath, `#!/bin/sh\necho ${version}\n`);
  chmodSync(nodePath, 0o755);
  const stage = join(root, "_staging", "acs-stage");
  mkdirSync(join(stage, "apps/gateway/dist"), { recursive: true });
  mkdirSync(join(stage, "packages/shared/dist"), { recursive: true });
  mkdirSync(join(stage, "node_modules/@agent-control-stack"), { recursive: true });
  writeFileSync(join(stage, "apps/gateway/dist/cli.js"), "export {};\n");
  writeFileSync(join(stage, "packages/shared/dist/index.js"), "export {};\n");
  writeFileSync(join(stage, "package.json"), "{}\n");
  writeFileSync(join(stage, "package-lock.json"), "{}\n");
  writeFileSync(join(stage, "node_modules/dependency.js"), "export {};\n");
  symlinkSync("../../packages/shared", join(stage, "node_modules/@agent-control-stack/shared"));
  return { root, stage, nodePath };
}

test("ACS release verifies runtime, manifest, dependencies and pinned Node", (t) => {
  const { root, stage, nodePath } = fixture(t);
  const created = createReleaseMetadata(stage, { commit, nodePath, component: "acs" });
  assert.equal(verifyRelease(stage, { allowStaging: true }).runtimeIdentityDigest, created.runtimeIdentityDigest);
  mkdirSync(join(root, "acs"));
  const published = join(root, "acs", `${commit.slice(0, 7)}-integrity`);
  renameSync(stage, published);
  assert.equal(verifyRelease(published).dependencyDigest, created.dependencyDigest);
  assert.throws(() => verifyRelease(stage, { allowStaging: true }), /ENOENT/);
  writeFileSync(join(published, "packages/shared/dist/index.js"), "tampered\n");
  assert.throws(() => verifyRelease(published), /manifest mismatch/);
});

test("ACS release rejects dependency and pinned Node drift", (t) => {
  const { stage, nodePath } = fixture(t);
  createReleaseMetadata(stage, { commit, nodePath, component: "acs" });
  writeFileSync(join(stage, "node_modules/dependency.js"), "tampered\n");
  assert.throws(() => verifyRelease(stage, { allowStaging: true }), /dependencies mismatch/);
  writeFileSync(join(stage, "node_modules/dependency.js"), "export {};\n");
  writeFileSync(nodePath, "#!/bin/sh\necho v24.18.0\n# tampered\n");
  assert.throws(() => verifyRelease(stage, { allowStaging: true }), /pinned Node identity mismatch/);
});

test("ACS release refuses escaping workspace links", (t) => {
  const { stage, nodePath } = fixture(t);
  symlinkSync("/etc/passwd", join(stage, "node_modules/escape"));
  assert.throws(() => createReleaseMetadata(stage, { commit, nodePath, component: "acs" }), /symlink escapes root/);
});

test("metadata creation cannot reseal changed release bytes", (t) => {
  const { stage, nodePath } = fixture(t);
  createReleaseMetadata(stage, { commit, nodePath, component: "acs" });
  const manifest = readFileSync(join(stage, "RELEASE-MANIFEST.json"));
  const metadata = readFileSync(join(stage, "RELEASE.json"));
  writeFileSync(join(stage, "apps/gateway/dist/cli.js"), "tampered\n");
  assert.throws(() => createReleaseMetadata(stage, { commit, nodePath, component: "acs" }), /metadata already exists/);
  assert.deepEqual(readFileSync(join(stage, "RELEASE-MANIFEST.json")), manifest);
  assert.deepEqual(readFileSync(join(stage, "RELEASE.json")), metadata);
  assert.throws(() => verifyRelease(stage, { allowStaging: true }), /manifest mismatch/);
});

for (const file of ["RELEASE.json", "RELEASE-MANIFEST.json"]) {
  test(`metadata creation preserves an existing partial ${file}`, (t) => {
    const { stage, nodePath } = fixture(t);
    writeFileSync(join(stage, file), "existing partial artifact\n");
    // Refusal precedes any attempt to execute the configured binary.
    assert.throws(() => createReleaseMetadata(stage, { commit, nodePath: `${nodePath}-missing`, component: "acs" }), /metadata already exists/);
    assert.equal(readFileSync(join(stage, file), "utf8"), "existing partial artifact\n");
  });

  test(`metadata creation refuses a dangling ${file} link`, (t) => {
    const { stage, nodePath } = fixture(t);
    symlinkSync("missing-target", join(stage, file));
    assert.throws(() => createReleaseMetadata(stage, { commit, nodePath, component: "acs" }), /metadata already exists/);
  });
}
