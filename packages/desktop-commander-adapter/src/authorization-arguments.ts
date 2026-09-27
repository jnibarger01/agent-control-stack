import { ControlStackError } from "@agent-control-stack/shared";
import {
  DC_TRANSPORT_METADATA_ARGUMENT_KEYS as MANIFEST_TRANSPORT_METADATA_ARGUMENT_KEYS,
  DC_TRANSPORT_METADATA_VALUES
} from "@agent-control-stack/dc-tool-manifest";

/**
 * Canonical `authorizationArguments` contract (acs.dc.v1).
 *
 * See docs/protocol/dc-authorization-arguments.md. In short:
 *
 *  - `authorizationArguments` are the exact arguments ACS binds into a
 *    capability (`payload.normalizedArguments`) and the exact arguments Desktop
 *    Commander must verify for the delivered request.
 *  - Transport-metadata keys (currently only `origin`) are NOT authorization
 *    arguments. They are validated, then removed, before ACS normalization and
 *    before Desktop Commander structural verification. Both sides use the same
 *    key list, owned by @agent-control-stack/dc-tool-manifest and projected into
 *    contracts/desktop-commander/authorization-arguments.v1.json.
 *  - The delivered request carries the bound arguments verbatim (plus, at most,
 *    the transport-metadata keys the client supplied). ACS's semantic
 *    normalization (canonical realpath'd paths, fixed-dir executable resolution)
 *    is therefore what executes; Desktop Commander never re-derives it.
 */

export const DC_TRANSPORT_METADATA_ARGUMENT_KEYS = MANIFEST_TRANSPORT_METADATA_ARGUMENT_KEYS;
const TRANSPORT_METADATA_VALUES: Readonly<Record<string, readonly string[]>> = DC_TRANSPORT_METADATA_VALUES;

export interface SplitToolArguments {
  /** Everything that is authorization-relevant; input to per-tool normalization. */
  readonly authorizationInput: Record<string, unknown>;
  /** Validated non-authoritative telemetry metadata, never bound. */
  readonly transportMetadata: Record<string, string>;
}

/**
 * Remove (after validating) transport-metadata keys from raw tool arguments.
 * An invalid transport-metadata value is a deterministic argument error: it is
 * never silently dropped, so both sides reject the same inputs.
 */
export function splitTransportMetadata(raw: Record<string, unknown>): SplitToolArguments {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new ControlStackError("desktop_commander_argument_invalid", "Desktop Commander arguments must be an object");
  }
  const authorizationInput: Record<string, unknown> = {};
  const transportMetadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if ((DC_TRANSPORT_METADATA_ARGUMENT_KEYS as readonly string[]).includes(key)) {
      const allowed = TRANSPORT_METADATA_VALUES[key] ?? [];
      if (typeof value !== "string" || !allowed.includes(value)) {
        throw new ControlStackError(
          "desktop_commander_argument_invalid",
          `transport metadata '${key}' must be one of ${allowed.map((entry) => `"${entry}"`).join(", ")}`
        );
      }
      transportMetadata[key] = value;
      continue;
    }
    // JSON cannot carry `undefined`; an in-process caller's undefined is "absent".
    if (value === undefined) continue;
    authorizationInput[key] = value;
  }
  return { authorizationInput, transportMetadata };
}
