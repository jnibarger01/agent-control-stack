/**
 * Mission Control wave-2 plan item #18 (fail-closed UI states): one gate for
 * every client control that can mutate server state, so a control added later
 * cannot silently skip the stale-stream gate.
 *
 * The server stays the only authority; the gate exists to avoid dead clicks and
 * to keep a stale dashboard from submitting anything while the live stream is
 * down.
 *
 * The selectors are attribute-based so live fragment patches are covered too.
 * `mutation-gate.test.ts` asserts every entry matches a real control in the
 * rendered page, which is what keeps this list honest.
 *
 * Deliberately excluded (documented so the list stays reviewable):
 * - `#composer-preview-button`: `POST /dashboard/policy-preview` creates nothing
 *   and appends no audit event.
 * - `#theme-toggle` / `#notifications-toggle`: local preferences only.
 * - `#events-pause` / `#events-load-older`: client-side buffer and a read route.
 */
export const MUTATING_CONTROL_SELECTORS = [
  "[data-approve]",
  "[data-reject]",
  "[data-unblock]",
  "[data-work-control]",
  "#task-form button[type=submit]",
  "input[data-execution-mode]"
] as const;

/** One CSS selector matching every mutating control. */
export const MUTATING_CONTROL_SELECTOR = MUTATING_CONTROL_SELECTORS.join(",");

/** Marker for controls the gate disabled, so a reconnect can restore them. */
export const MUTATION_GATE_MARKER_ATTRIBUTE = "data-mutation-gate-disabled";
/** Records a control the server render had already disabled before the gate ran. */
export const MUTATION_GATE_WAS_DISABLED_ATTRIBUTE = "data-mutation-gate-was-disabled";
