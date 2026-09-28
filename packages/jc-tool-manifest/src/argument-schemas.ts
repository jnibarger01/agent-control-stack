import { isAbsolute, normalize } from "node:path";
import { z } from "zod";

/**
 * Strict per-tool argument schemas for the Jace Commander (`acs.jc.v1`) tool
 * surface. Canonical source: this file. Both ACS
 * (`packages/desktop-commander-adapter`) and Jace Commander itself
 * (`vendor/desktop-commander/src/jace-commander`) must validate identical
 * shapes; the root drift test enforces it.
 *
 * Unknown keys are rejected (`z.strictObject`). No defaults or coercion:
 * whatever the caller sends is exactly what gets hashed and signed.
 */

const ID = z.string().regex(/^[A-Za-z0-9._:-]{1,128}$/u);
const ABSOLUTE = z
  .string()
  .min(1)
  .max(4096)
  .refine((value) => isAbsolute(value) && !value.includes("\0"), "must be an absolute path");

export const JC_TOOL_NAMES = Object.freeze([
  "jc_status",
  "acs_read",
  "acs_submit_mission",
  "swarm_read",
  "visualizer_read",
  "mission_router_list",
  "looptrace_verify",
  "privileged_exec"
] as const);
export type JcToolName = (typeof JC_TOOL_NAMES)[number];

export const JC_TOOL_ARGUMENT_SCHEMAS: Readonly<Record<JcToolName, z.ZodType>> = Object.freeze({
  jc_status: z.strictObject({}),
  acs_read: z.strictObject({
    view: z.enum(["health", "work-items", "work-item"]),
    id: ID.optional(),
    status: z.string().min(1).max(64).optional()
  }),
  acs_submit_mission: z.strictObject({
    title: z.string().min(1).max(200),
    intent: z.string().min(1).max(8000),
    target: z.record(z.string(), z.unknown()),
    requestedActions: z.array(z.record(z.string(), z.unknown())).max(32).optional(),
    risk: z.enum(["low", "medium", "high", "critical"]).optional(),
    correlationId: ID.optional()
  }),
  swarm_read: z.strictObject({
    view: z.enum(["health", "mission-control", "runs", "status", "task"]),
    taskId: ID.optional()
  }),
  visualizer_read: z.strictObject({
    view: z.enum(["system-status", "runtimes", "executions", "approvals", "alerts", "agents"])
  }),
  mission_router_list: z.strictObject({}),
  looptrace_verify: z.strictObject({ path: ABSOLUTE }),
  privileged_exec: z.strictObject({
    argv: z
      .array(
        z
          .string()
          .max(8192)
          .refine((value) => !value.includes("\0"), "argv entries must not contain NUL")
      )
      .min(1)
      .max(256)
      .refine(
        (argv) => isAbsolute(argv[0]!) && normalize(argv[0]!) === argv[0],
        "argv[0] must be a normalized absolute path"
      ),
    cwd: ABSOLUTE.optional(),
    timeoutMs: z.number().int().min(1).max(600_000).optional(),
    stdin: z
      .string()
      .max(64 * 1024)
      .optional()
  })
});
