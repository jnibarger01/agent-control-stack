/**
 * Mission authority envelopes and strict narrowing.
 *
 * child authority = parent authority ∩ mission policy ∩ requested authority ∩ global policy
 *
 * Narrowing is intersection, never union, and it fails closed: a child that *asks* for something its parent does not
 * hold is denied with the reasons, not silently clipped, so an escalation attempt is visible and auditable. Wildcards
 * do not exist, privileged actions must be named explicitly and are never inherited by default, and a child can never
 * outlive its parent.
 */
import { stableHash } from "@agent-control-stack/shared";

/** Actions that stay explicitly representable and auditable, and are never inherited implicitly. */
export const PRIVILEGED_ACTIONS: ReadonlySet<string> = new Set(["privileged_exec", "admin_mode"]);

export interface AuthorityEnvelope {
  /** Action classes, for example `fs.read`, `shell.exec`, `privileged_exec`. */
  actions: string[];
  /** Resource scope as `/`-separated prefixes. A prefix covers itself and everything beneath it. */
  resources: string[];
  /** Tool names. */
  tools: string[];
  /** If present, only these worker ids may execute under this envelope. */
  workers?: string[];
  expiresAt: string;
}

export interface MissionAuthorityPolicy {
  /** Children never receive privileged actions unless this is true AND the parent holds them. Default false. */
  allowPrivilegedChildren?: boolean;
  deniedActions?: string[];
  /** Upper bound on a child's lifetime from the moment it is created. */
  maxChildTtlMs?: number;
}

/** What a child asks for. An omitted field means "inherit the parent's, minus what policy forbids". */
export interface AuthorityRequest {
  actions?: string[];
  resources?: string[];
  tools?: string[];
  workers?: string[];
  expiresAt?: string;
}

export type NarrowResult = { ok: true; envelope: AuthorityEnvelope } | { ok: false; reasons: string[] };

const NAME = /^[a-z][a-z0-9_.:-]{0,63}$/u;

const unique = (values: readonly string[]): string[] => [...new Set(values)].sort();

/** Normalize a resource prefix, or return undefined if it is not a safe, wildcard-free path. */
export function normalizeResource(value: string): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) return undefined;
  if (value.includes("\\") || value.includes("*") || value.includes("\0")) return undefined;
  const segments = value.split("/").filter((segment) => segment !== "");
  if (segments.length === 0 || segments.some((segment) => segment === ".." || segment === ".")) return undefined;
  return `${value.startsWith("/") ? "/" : ""}${segments.join("/")}`;
}

/** True if `child` equals `parent` or lies beneath it, compared by whole path segments. */
export function resourceCovered(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export function validateEnvelope(envelope: AuthorityEnvelope): string[] {
  const problems: string[] = [];
  const names = (label: string, values: readonly string[]) => {
    for (const value of values) if (!NAME.test(value)) problems.push(`${label}_invalid:${String(value).slice(0, 40)}`);
  };
  if (envelope.actions.length === 0) problems.push("actions_empty");
  names("action", envelope.actions);
  names("tool", envelope.tools);
  for (const worker of envelope.workers ?? [])
    if (!NAME.test(worker)) problems.push(`worker_invalid:${worker.slice(0, 40)}`);
  for (const resource of envelope.resources)
    if (normalizeResource(resource) === undefined) problems.push(`resource_invalid:${resource.slice(0, 40)}`);
  if (Number.isNaN(Date.parse(envelope.expiresAt))) problems.push("expiry_invalid");
  return problems;
}

export function canonicalEnvelope(envelope: AuthorityEnvelope): AuthorityEnvelope {
  return {
    actions: unique(envelope.actions),
    resources: unique(envelope.resources.map((resource) => normalizeResource(resource) ?? resource)),
    tools: unique(envelope.tools),
    ...(envelope.workers ? { workers: unique(envelope.workers) } : {}),
    expiresAt: new Date(envelope.expiresAt).toISOString()
  };
}

export function envelopeHash(envelope: AuthorityEnvelope): string {
  return stableHash({ domain: "acs.authority-envelope.v1", envelope: canonicalEnvelope(envelope) });
}

export function isExpired(envelope: AuthorityEnvelope, now: string): boolean {
  return Date.parse(envelope.expiresAt) <= Date.parse(now);
}

export function narrowAuthority(input: {
  parent: AuthorityEnvelope;
  policy?: MissionAuthorityPolicy;
  requested?: AuthorityRequest;
  now: string;
}): NarrowResult {
  const { parent, requested } = input;
  const policy = input.policy ?? {};
  const reasons: string[] = [];
  const parentProblems = validateEnvelope(parent);
  if (parentProblems.length > 0) return { ok: false, reasons: parentProblems.map((problem) => `parent_${problem}`) };
  if (isExpired(parent, input.now)) return { ok: false, reasons: ["authority_expired"] };

  const denied = new Set(policy.deniedActions ?? []);
  const privilegedAllowed = policy.allowPrivilegedChildren === true;
  const parentActions = new Set(parent.actions);

  // actions: explicit requests are checked (escalation is denied); inheritance drops what policy forbids.
  let actions: string[];
  if (requested?.actions) {
    for (const action of requested.actions) {
      if (!NAME.test(action)) reasons.push(`action_invalid:${String(action).slice(0, 40)}`);
      else if (!parentActions.has(action)) reasons.push(`action_not_in_parent:${action}`);
      else if (denied.has(action)) reasons.push(`action_denied_by_mission_policy:${action}`);
      else if (PRIVILEGED_ACTIONS.has(action) && !privilegedAllowed)
        reasons.push(`privileged_child_not_allowed:${action}`);
    }
    actions = unique(requested.actions);
  } else {
    actions = unique(
      parent.actions.filter((action) => !denied.has(action) && !(PRIVILEGED_ACTIONS.has(action) && !privilegedAllowed))
    );
  }

  let resources: string[];
  if (requested?.resources) {
    resources = [];
    for (const resource of requested.resources) {
      const normalized = normalizeResource(resource);
      if (normalized === undefined) reasons.push(`resource_invalid:${String(resource).slice(0, 40)}`);
      else if (!parent.resources.some((held) => resourceCovered(normalizeResource(held) ?? held, normalized))) {
        reasons.push(`resource_not_in_parent:${normalized}`);
      } else resources.push(normalized);
    }
    resources = unique(resources);
  } else resources = unique(parent.resources.map((resource) => normalizeResource(resource) ?? resource));

  let tools: string[];
  if (requested?.tools) {
    const held = new Set(parent.tools);
    for (const tool of requested.tools) {
      if (!NAME.test(tool)) reasons.push(`tool_invalid:${String(tool).slice(0, 40)}`);
      else if (!held.has(tool)) reasons.push(`tool_not_in_parent:${tool}`);
    }
    tools = unique(requested.tools);
  } else tools = unique(parent.tools);

  let workers: string[] | undefined = parent.workers ? unique(parent.workers) : undefined;
  if (requested?.workers) {
    for (const worker of requested.workers) {
      if (!NAME.test(worker)) reasons.push(`worker_invalid:${String(worker).slice(0, 40)}`);
      else if (parent.workers && !parent.workers.includes(worker)) reasons.push(`worker_not_in_parent:${worker}`);
    }
    workers = unique(requested.workers);
  }

  let expires = Date.parse(parent.expiresAt);
  if (policy.maxChildTtlMs !== undefined) expires = Math.min(expires, Date.parse(input.now) + policy.maxChildTtlMs);
  if (requested?.expiresAt !== undefined) {
    const asked = Date.parse(requested.expiresAt);
    if (Number.isNaN(asked)) reasons.push("expiry_invalid");
    else if (asked > Date.parse(parent.expiresAt)) reasons.push("expiry_exceeds_parent");
    else expires = Math.min(expires, asked);
  }
  if (actions.length === 0) reasons.push("no_authority_remains");
  if (expires <= Date.parse(input.now)) reasons.push("authority_expired");
  if (reasons.length > 0) return { ok: false, reasons };

  return {
    ok: true,
    envelope: canonicalEnvelope({
      actions,
      resources,
      tools,
      ...(workers ? { workers } : {}),
      expiresAt: new Date(expires).toISOString()
    })
  };
}

/** True if `child` holds nothing `parent` does not. Used to assert the narrowing invariant after the fact. */
export function isSubsetOf(child: AuthorityEnvelope, parent: AuthorityEnvelope): boolean {
  const held = (list: readonly string[] | undefined, value: string) => (list ?? []).includes(value);
  return (
    child.actions.every((action) => held(parent.actions, action)) &&
    child.tools.every((tool) => held(parent.tools, tool)) &&
    child.resources.every((resource) => parent.resources.some((held) => resourceCovered(held, resource))) &&
    (parent.workers === undefined ||
      (child.workers !== undefined && child.workers.every((worker) => held(parent.workers, worker)))) &&
    Date.parse(child.expiresAt) <= Date.parse(parent.expiresAt)
  );
}
