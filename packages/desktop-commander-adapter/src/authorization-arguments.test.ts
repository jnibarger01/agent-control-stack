import {
  accessSync,
  constants as fsConstants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { strictCanonicalJsonV1 } from "@agent-control-stack/shared";
import { normalizeInvocation } from "./arguments.js";
import { DC_TRANSPORT_METADATA_ARGUMENT_KEYS, splitTransportMetadata } from "./authorization-arguments.js";
import { desktopCommanderRequiredScopes } from "./capability.js";
import {
  allowlistedDesktopCommanderToolNames,
  desktopCommanderManagedToolDispositions,
  desktopCommanderToolPolicy
} from "./tool-policy.js";

const contractsDir = new URL("../../../contracts/desktop-commander/", import.meta.url);
const fixture = JSON.parse(readFileSync(new URL("authorization-arguments.v1.json", contractsDir), "utf8")) as {
  transportMetadataKeys: string[];
  transportMetadataValues: Record<string, string[]>;
  fixtureFilesystem: { directories: string[]; symlinks: Record<string, string> };
  cases: { name: string; tool: string; raw: unknown; authorizationArguments: unknown; delivered: unknown }[];
  rejectedByAcs: { name: string; tool: string; raw: unknown }[];
};
const coverage = JSON.parse(readFileSync(new URL("managed-tool-coverage.v1.json", contractsDir), "utf8")) as {
  tools: Record<string, { toolClass: string; managed: string; scopes?: string[]; requiresApproval?: boolean }>;
};

const root = realpathSync(mkdtempSync(join(tmpdir(), "acs-dc-authz-args-")));
for (const dir of fixture.fixtureFilesystem.directories) mkdirSync(join(root, dir), { recursive: true });
for (const [link, target] of Object.entries(fixture.fixtureFilesystem.symlinks))
  symlinkSync(join(root, target), join(root, link));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const containment = { allowedRoots: [root], deniedRoots: [] };

function fixedDirExecutable(name: string): string {
  for (const dir of ["/usr/bin", "/bin", "/usr/local/bin"]) {
    try {
      accessSync(join(dir, name), fsConstants.X_OK);
      return join(dir, name);
    } catch {
      // try the next fixed directory
    }
  }
  throw new Error(`fixture executable not found: ${name}`);
}

function substitute(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll("${ROOT}", root)
      .replace(/\$\{BIN:([a-z0-9]+)\}/gu, (_, name: string) => fixedDirExecutable(name));
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry)]));
  }
  return value;
}

/** What the managed gateway delivers: the bound arguments plus the client's transport metadata. */
function deliveredFor(bound: Record<string, unknown>, raw: Record<string, unknown>): Record<string, unknown> {
  return { ...bound, ...splitTransportMetadata(raw).transportMetadata };
}

describe("authorizationArguments contract (acs.dc.v1)", () => {
  it("pins the transport-metadata key list to the shared fixture", () => {
    expect([...DC_TRANSPORT_METADATA_ARGUMENT_KEYS]).toEqual(fixture.transportMetadataKeys);
    for (const [key, values] of Object.entries(fixture.transportMetadataValues)) {
      for (const value of values) expect(splitTransportMetadata({ [key]: value }).transportMetadata[key]).toBe(value);
    }
  });

  for (const testCase of fixture.cases) {
    it(`normalizes: ${testCase.name}`, () => {
      const raw = substitute(testCase.raw) as Record<string, unknown>;
      const expected = substitute(testCase.authorizationArguments);
      const invocation = normalizeInvocation(testCase.tool, raw, containment);
      // Deep structural equality over the exact strict canonical bytes the
      // capability signature covers and Desktop Commander compares.
      expect(strictCanonicalJsonV1(invocation.validatedArguments)).toBe(strictCanonicalJsonV1(expected));
      expect(deliveredFor(invocation.validatedArguments, raw)).toEqual(substitute(testCase.delivered));
      // Idempotent for path/scalar arguments. Command arguments are
      // deliberately NOT re-normalizable (an absolute executable is rejected as
      // input); that is safe because Desktop Commander never re-normalizes, it
      // compares the delivered bytes against the bound bytes.
      if (desktopCommanderToolPolicy(testCase.tool)!.commandArgs.length > 0) return;
      const again = normalizeInvocation(testCase.tool, deliveredFor(invocation.validatedArguments, raw), containment);
      expect(strictCanonicalJsonV1(again.validatedArguments)).toBe(strictCanonicalJsonV1(expected));
    });
  }

  for (const testCase of fixture.rejectedByAcs) {
    it(`rejects deterministically: ${testCase.name}`, () => {
      expect(() =>
        normalizeInvocation(testCase.tool, substitute(testCase.raw) as Record<string, unknown>, containment)
      ).toThrow(expect.objectContaining({ code: "desktop_commander_argument_invalid" }));
    });
  }

  it("never materializes defaults: every allowlisted schema round-trips an omitted optional as omitted", () => {
    for (const name of allowlistedDesktopCommanderToolNames()) {
      const schema = desktopCommanderToolPolicy(name)!.argsSchema;
      // A zod default() would surface as a key present in the parse output
      // that was absent from the input.
      const probe = schema.safeParse({});
      if (probe.success) expect(Object.keys(probe.data as object), name).toEqual([]);
    }
  });
});

describe("managed tool-policy coverage (acs.dc.v1)", () => {
  it("has an explicit disposition for every pinned Desktop Commander tool, and nothing else", () => {
    const dispositions = desktopCommanderManagedToolDispositions();
    expect(dispositions.map((entry) => entry.name)).toEqual(Object.keys(coverage.tools).sort());
    for (const entry of dispositions) {
      const pinned = coverage.tools[entry.name]!;
      expect({ toolClass: entry.toolClass, managed: entry.managed }, entry.name).toEqual({
        toolClass: pinned.toolClass,
        managed: pinned.managed
      });
      const policy = desktopCommanderToolPolicy(entry.name);
      if (entry.managed === "capability") {
        expect(policy, entry.name).toBeDefined();
        expect(desktopCommanderRequiredScopes(entry.name), entry.name).toEqual(pinned.scopes);
        expect(policy!.requiresApproval, entry.name).toBe(pinned.requiresApproval);
        // Write/process tools keep ACS capability + approval requirements.
        if (entry.toolClass !== "read_only") expect(policy!.requiresApproval, entry.name).toBe(true);
        else expect(policy!.requiresApproval, entry.name).toBe(false);
      } else {
        expect(policy, entry.name).toBeUndefined();
      }
    }
  });

  it("every allowlisted policy is a capability disposition", () => {
    const capabilityTools = desktopCommanderManagedToolDispositions()
      .filter((entry) => entry.managed === "capability")
      .map((entry) => entry.name);
    expect(allowlistedDesktopCommanderToolNames()).toEqual(capabilityTools);
  });

  it("get_runtime_identity is a read-only identity primitive", () => {
    const policy = desktopCommanderToolPolicy("get_runtime_identity")!;
    expect(policy.riskClass).toBe("read_only");
    expect(policy.requiresApproval).toBe(false);
    expect(policy.argsSchema.safeParse({}).success).toBe(true);
    expect(policy.argsSchema.safeParse({ token: "x" }).success).toBe(false);
  });
});
