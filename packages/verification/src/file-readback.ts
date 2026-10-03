import { constants, openSync, closeSync, fstatSync, readSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { ControlStackError, stableHash } from "@agent-control-stack/shared";
import { z } from "zod";

export const fileReadbackExpectationSchema = z
  .object({
    path: z.string().min(1).max(4_096).optional(),
    content: z.string().max(1_048_576).optional(),
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    exists: z.boolean().optional()
  })
  .strict()
  .refine(
    (value) => value.content !== undefined || value.sha256 !== undefined || value.exists !== undefined,
    "file verification needs an expected observation"
  );

/** Independent observation. No worker output or model assertion is evidence here. */
export function verifyFileReadback(path: string, expectation: unknown, assertCanonicalPath: (path: string) => string) {
  const expected = fileReadbackExpectationSchema.parse(expectation);
  const canonical = assertCanonicalPath(path);
  const resourceHash = stableHash({ domain: "acs.verification.resource.v1", path: canonical });
  if (process.platform !== "linux")
    throw new ControlStackError("verification_runtime_unsupported", "descriptor containment needs Linux procfs");
  let fd: number;
  try {
    fd = openSync(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return {
        resourceHash,
        exists: false,
        passed: expected.exists === false && expected.content === undefined && expected.sha256 === undefined
      };
    throw new ControlStackError("verification_readback_failed", "verification resource could not be opened safely");
  }
  try {
    // Check the opened object, not just a path observed before open(). This also
    // rejects an ancestor replaced with a symlink between validation and open.
    const resolved = realpathSync(`/proc/self/fd/${fd}`);
    if (assertCanonicalPath(resolved) !== canonical)
      throw new ControlStackError("verification_resource_changed", "opened resource differs from approved path");
    const before = fstatSync(fd, { bigint: true });
    const limit = 1_048_576;
    if (!before.isFile() || before.size > BigInt(limit))
      throw new ControlStackError("verification_resource_limit", "verification requires a bounded regular file");
    const buffer = Buffer.alloc(limit + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = readSync(fd, buffer, length, buffer.length - length, length);
      if (!read) break;
      length += read;
    }
    const after = fstatSync(fd, { bigint: true });
    if (
      length > limit ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    )
      throw new ControlStackError("verification_resource_changed", "resource changed during verification");
    const bytes = buffer.subarray(0, length);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const expectedContent = expected.content === undefined ? undefined : Buffer.from(expected.content);
    return {
      resourceHash,
      exists: true,
      bytes: length,
      sha256,
      passed:
        expected.exists !== false &&
        (expected.sha256 === undefined || expected.sha256 === sha256) &&
        (expectedContent === undefined || bytes.equals(expectedContent))
    };
  } finally {
    closeSync(fd);
  }
}
