import { createHash, randomUUID } from "node:crypto";
import { ControlStackError, domainHash, stableHash } from "@agent-control-stack/shared";
import {
  committedCuaReceipts,
  cuaActionHash,
  cuaCheckpointReceiptHash,
  cuaReceiptKind,
  cuaResultHash,
  verifyCuaCheckpoints,
  type CuaCheckpointRow
} from "./cua-evidence.js";
import type { CuaAction, CuaActionType } from "./mission-model.js";
import { parseWorkUnitPayload } from "./mission-model.js";
import type { CodingMissionStore } from "./store.js";
import {
  boundedText,
  resultBase,
  type DispatchEnvelope,
  type ExecutionClaim,
  type ExecutionReceipt,
  type ResultEnvelope,
  type WorkUnitExecutorAdapter
} from "./worker-execution.js";

/**
 * Subset of Playwright's Page. A real Page already has these members; this package does not depend on playwright.
 * screenshot returns PNG bytes (Playwright's default) the caller size-checks, hashes and drops. It must not retain them.
 */
export interface CuaPage {
  url(): string;
  screenshot(): Promise<Uint8Array>;
  locator(selector: string): {
    click(): Promise<void>;
    fill(text: string): Promise<void>;
  };
  mouse: {
    wheel(dx: number, dy: number): Promise<void>;
  };
  goto(url: string): Promise<unknown>;
  close(): Promise<void>;
  /** The browser context the page lives in. The origin allowlist is enforced on the whole context. */
  context(): CuaBrowserContext;
}

/** Subset of Playwright's Route. */
export interface CuaRoute {
  request(): { url(): string };
  continue(): Promise<void>;
  abort(errorCode?: string): Promise<void>;
}

/** Subset of Playwright's WebSocketRoute. */
export interface CuaWebSocketRoute {
  url(): string;
  connectToServer(): unknown;
  close(options?: { code?: number; reason?: string }): Promise<void>;
}

/**
 * Subset of Playwright's BrowserContext: request and WebSocket interception, the set of open pages (including
 * popups) and its service workers. Providers should create the context with `serviceWorkers: "block"`: requests a
 * service worker makes are not seen by `route`, so any service worker in the context makes the session uncertain.
 */
export interface CuaBrowserContext {
  route(url: string, handler: (route: CuaRoute) => unknown): Promise<void>;
  /** `route` does not govern WebSockets; without this hook the session fails closed. */
  routeWebSocket(url: string | RegExp, handler: (ws: CuaWebSocketRoute) => unknown): Promise<void>;
  serviceWorkers(): unknown[];
  pages(): CuaPage[];
  on(event: "page", listener: (page: CuaPage) => void): unknown;
  /** Removes a listener added with `on`, so a reused context keeps no listener from a closed session. */
  off(event: "page", listener: (page: CuaPage) => void): unknown;
}

export interface CuaBrowserProvider {
  open(application: string): Promise<CuaPage>;
}

/** Who a typed secret is resolved for. Every field comes from the fenced dispatch, never from the payload. */
export interface CuaSecretPrincipal {
  workerId: string;
  missionId: string;
  unitId: string;
  attemptId: string;
  application: string;
}

/** Resolves a `secretRef` at execution time. The value is used for one fill and never persisted or returned. */
export interface CuaSecretResolver {
  resolve(secretRef: string, principal: CuaSecretPrincipal): Promise<string>;
}

/** Structural subset of secret-broker's SecretBroker and SecretHandle, so this package needs no new dependency. */
export interface CuaSecretBroker {
  lease(request: {
    scope: string;
    ttlMs: number;
    principal: { workerId: string; workItemId: string; attemptId: string; engineId: string };
    purpose: string;
    maxUses?: number;
  }): Promise<CuaSecretHandle>;
  revoke(handle: CuaSecretHandle): Promise<void>;
}
export interface CuaSecretHandle {
  injectInto(
    env: Record<string, string | undefined>,
    redeemer: { workerId: string; workItemId: string; attemptId: string; engineId: string }
  ): void;
}

export const CUA_SECRET_WORK_ITEM_HASH_DOMAIN = "acs.cua-secret-work-item.v1";

/**
 * The broker principal's work-item id for a CUA unit: a domain-separated SHA-256 of the (missionId, unitId) pair.
 * Deterministic, 68 characters (inside the broker's 128-character identifier limit for any valid ids), and
 * collision-safe: the pair is hashed as canonical JSON, so ("a:b", "c") and ("a", "b:c") differ.
 */
export function cuaSecretWorkItemId(missionId: string, unitId: string): string {
  return `cua:${domainHash(CUA_SECRET_WORK_ITEM_HASH_DOMAIN, { missionId, unitId })}`;
}

/**
 * A CuaSecretResolver backed by the secret broker: lease the scope for this attempt, redeem it once into a private
 * object, and revoke the lease. `envName` maps a scope to the variable the broker injects it as (default: the scope).
 */
export function secretBrokerCuaResolver(
  broker: CuaSecretBroker,
  options: { ttlMs?: number; envName?: (scope: string) => string } = {}
): CuaSecretResolver {
  return {
    async resolve(secretRef, principal) {
      const leasePrincipal = {
        workerId: principal.workerId,
        workItemId: cuaSecretWorkItemId(principal.missionId, principal.unitId),
        attemptId: principal.attemptId,
        engineId: principal.application
      };
      const handle = await broker.lease({
        scope: secretRef,
        ttlMs: options.ttlMs ?? 60_000,
        principal: leasePrincipal,
        purpose: "cua-type-secret",
        maxUses: 1
      });
      try {
        const sink: Record<string, string | undefined> = {};
        handle.injectInto(sink, leasePrincipal);
        const value = sink[options.envName?.(secretRef) ?? secretRef];
        if (typeof value !== "string" || value.length === 0) {
          throw new ControlStackError("cua_secret_unavailable", "secret reference did not resolve");
        }
        return value;
      } finally {
        await broker.revoke(handle).catch(() => undefined);
      }
    }
  };
}

/**
 * Re-reads the live authority for a CUA attempt from the store at the browser boundary. MissionAuthorityLedger
 * implements it. It must never return a cached or caller-supplied verdict.
 */
export interface CuaAuthorityRecheck {
  browserAuthorityVerdict(input: {
    missionId: string;
    unitId: string;
    origins: readonly string[];
    applications: readonly string[];
    deadlineAt: string | undefined;
  }): { ok: true } | { ok: false; reason: string };
  /**
   * Re-reads whether the live authority for this attempt grants `secret.read` and covers exactly this secret as a
   * `{ kind: "secret" }` resource. Without it (or when it throws or refuses) a `secretRef` is never leased.
   */
  secretAuthorityVerdict?(input: {
    missionId: string;
    unitId: string;
    secretRef: string;
  }): { ok: true } | { ok: false; reason: string };
}

/** The read side of MissionAuthorityLedger this package needs, structurally (no import cycle). */
export interface CuaMissionAuthorityReader extends CuaAuthorityRecheck {
  missionAuthority(missionId: string): { definition: CuaGrantDefinition } | undefined;
  unitAuthority(missionId: string, unitId: string): { definition: CuaGrantDefinition } | undefined;
}
interface CuaGrantDefinition {
  scope: ReadonlyArray<{ kind: string; id: string }>;
  maximumPrivileges: readonly string[];
}

/**
 * The live CUA authority re-check backed by MissionAuthorityLedger: the browser verdict is the ledger's own, and the
 * secret verdict re-reads the attempt's effective authority (the derived unit's record, or the mission's for a root
 * unit) and requires `secret.read` plus an exact `{ kind: "secret", id: secretRef }` resource. Any doubt refuses.
 */
export function missionCuaAuthority(ledger: CuaMissionAuthorityReader, store: CodingMissionStore): CuaAuthorityRecheck {
  return {
    browserAuthorityVerdict: (input) => ledger.browserAuthorityVerdict(input),
    secretAuthorityVerdict(input) {
      const refuse = { ok: false as const, reason: "cua_secret_not_granted" };
      try {
        const unit = store.workUnits(input.missionId).find((candidate) => candidate.unitId === input.unitId);
        if (!unit) return refuse;
        const definition = unit.parentUnitId
          ? ledger.unitAuthority(input.missionId, input.unitId)?.definition
          : ledger.missionAuthority(input.missionId)?.definition;
        if (!definition) return refuse;
        const granted =
          definition.maximumPrivileges.includes("secret.read") &&
          definition.scope.some((resource) => resource.kind === "secret" && resource.id === input.secretRef);
        return granted ? { ok: true } : refuse;
      } catch {
        return refuse;
      }
    }
  };
}

export interface CuaExecutionOptions {
  /**
   * Live authority re-check, run before opening the browser and before every action. Required: without it every CUA
   * script is refused before any browser call.
   */
  authority?: CuaAuthorityRecheck;
  /** Resolves `secretRef` type actions. Without it, a script that types a secret is refused before any action. */
  secrets?: CuaSecretResolver;
  /** Deadline for every single browser call (open, route setup, action, close). Default 30s. */
  actionTimeoutMs?: number;
  /** Lease on the per-attempt execution lock, renewed at every checkpoint. Default max(5 min, 4 x actionTimeoutMs). */
  lockTtlMs?: number;
  /** Largest screenshot accepted, in bytes, checked before hashing. Default 8 MiB. */
  maxScreenshotBytes?: number;
  /** Largest screenshot width or height, in pixels, read from the PNG header before hashing. Default 8192. */
  maxScreenshotDimension?: number;
  /** Largest screenshot width x height. Default 8192 x 4096. */
  maxScreenshotPixels?: number;
}

const DEFAULT_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
const DEFAULT_MAX_SCREENSHOT_DIMENSION = 8192;
const DEFAULT_MAX_SCREENSHOT_PIXELS = 8192 * 4096;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * Width and height from a PNG's IHDR chunk (signature, length 13, "IHDR", then big-endian width and height), or
 * undefined when the bytes are not a PNG. Constant time: only the first 24 bytes are read.
 */
function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24) return undefined;
  if (PNG_SIGNATURE.some((byte, index) => bytes[index] !== byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, 24);
  if (view.getUint32(8) !== 13) return undefined;
  if (String.fromCharCode(bytes[12]!, bytes[13]!, bytes[14]!, bytes[15]!) !== "IHDR") return undefined;
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const DEFAULT_ACTION_TIMEOUT_MS = 30_000;

/** A browser call that hit its deadline or the abort signal. Its effect is unknown. */
class CuaInterrupted extends Error {
  constructor(readonly reason: "timeout" | "aborted") {
    super(`cua browser call ${reason}`);
  }
}

/** True when a URL is about:blank or on an exact allowlisted http(s) origin. */
function requestAllowed(url: string, origins: readonly string[]): boolean {
  if (url === "about:blank") return true;
  const origin = pageOrigin(url);
  return origin !== null && origin !== "about:blank" && origins.includes(origin);
}

/** True when a WebSocket URL is ws(s) on an allowlisted origin: ws maps to http and wss to https, no credentials. */
function webSocketAllowed(url: string, origins: readonly string[]): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.username !== "" || parsed.password !== "") return false;
  const scheme = parsed.protocol === "wss:" ? "https:" : parsed.protocol === "ws:" ? "http:" : undefined;
  if (!scheme) return false;
  const port = parsed.port === "" ? "" : `:${parsed.port}`;
  let origin: string;
  try {
    origin = new URL(`${scheme}//${parsed.hostname}${port}`).origin;
  } catch {
    return false;
  }
  return origins.includes(origin);
}

/** Per-session state for the browser boundary. */
interface CuaSession {
  page: CuaPage;
  context: CuaBrowserContext;
  /** Set when any page other than the governed page appeared in the context (a popup or window.open). */
  foreignPage: boolean;
  /** Pages already in the context when the session opened (a reused or persistent profile). Never closed or counted. */
  preexisting: ReadonlySet<CuaPage>;
  /** Pages that appeared in the context during the session. Closed with the session. */
  created: Set<CuaPage>;
  /** Unsubscribes this session's "page" listener. Set once the listener is registered. */
  detach?: () => void;
  /** Set when the session closes; a listener that outlives its removal then ignores every page. */
  closed: boolean;
}

/**
 * Opens a Playwright-shaped page and starts it at about:blank before any governed action. `connect` should create the
 * page's context with `serviceWorkers: "block"`; a context with a running service worker is refused or made uncertain.
 */
export class PlaywrightCuaBrowser implements CuaBrowserProvider {
  constructor(private readonly connect: (application: string) => Promise<CuaPage>) {}

  async open(application: string): Promise<CuaPage> {
    const page = await this.connect(application);
    try {
      await page.goto("about:blank");
    } catch (error) {
      try {
        await page.close();
      } catch {
        // A close failure must not hide the about:blank reset error.
      }
      throw error;
    }
    return page;
  }
}

const MUTATING: ReadonlySet<CuaActionType> = new Set(["click", "type", "scroll", "navigate"]);

type CheckpointRow = CuaCheckpointRow;
const CHECKPOINT_COLUMNS = `attempt_id, mission_id, unit_id, unit_attempt, worker_id, claim_token_hash, fencing_token,
  sequence, action_type, action_hash, state, screenshot_hash, receipt_hash, origin, application`;

interface ActionEffect {
  origin: string | null;
  screenshotHash?: string;
  uncertain: boolean;
}

const receiptKind = cuaReceiptKind;

function sha256Bytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function pageOrigin(url: string): string | null {
  if (url === "about:blank") return "about:blank";
  try {
    const parsed = new URL(url);
    if (parsed.username !== "" || parsed.password !== "") return null;
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    return null;
  }
}

function approvedNavigation(url: string, origins: readonly string[]): { href: string; origin: string } | undefined {
  if (origins.length === 0) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return undefined;
  if (parsed.username !== "" || parsed.password !== "") return undefined;
  if (!origins.includes(parsed.origin)) return undefined;
  return { href: parsed.href, origin: parsed.origin };
}

function landingUncertain(
  type: CuaActionType,
  url: string,
  origins: readonly string[],
  requireAllowlisted: boolean
): boolean {
  if (type === "observe" && !requireAllowlisted && url === "about:blank") return false;
  const origin = pageOrigin(url);
  return origin === null || origin === "about:blank" || !origins.includes(origin);
}

function isFenceError(error: unknown): boolean {
  return (
    error instanceof ControlStackError &&
    (error.code === "coding_mission_claim_conflict" ||
      error.code === "execution_attempt_conflict" ||
      error.code === "cua_execution_lock_lost")
  );
}

/**
 * Runs the actions already on a cua work-unit payload. It does not plan actions,
 * mint capabilities, or consult a second approval store. The live claim fence is
 * rechecked in the same transaction as each checkpoint write.
 */
export class CuaExecutionAdapter implements WorkUnitExecutorAdapter {
  readonly lane = "cua" as const;

  constructor(
    private readonly store: CodingMissionStore,
    private readonly browser: CuaBrowserProvider,
    private readonly application: string,
    private readonly now: () => string = () => new Date().toISOString(),
    private readonly options: CuaExecutionOptions = {}
  ) {}

  private get timeoutMs(): number {
    return this.options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS;
  }

  /** Race one browser call against the per-call deadline and the abort signal. */
  private async bounded<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new CuaInterrupted("aborted");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const pending = Promise.resolve().then(work);
    // The losing call may still settle later; its outcome is already recorded as uncertain.
    pending.catch(() => undefined);
    try {
      return await Promise.race([
        pending,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new CuaInterrupted("timeout")), this.timeoutMs);
          // Defer by one task so a call that already settled when the abort fired reports its real outcome.
          onAbort = () => setTimeout(() => reject(new CuaInterrupted("aborted")), 0);
          signal?.addEventListener("abort", onAbort, { once: true });
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Open the governed page and enforce the origin allowlist on its whole context before any action. */
  private async openSession(origins: readonly string[], signal?: AbortSignal): Promise<CuaSession> {
    const page = await this.bounded(() => this.browser.open(this.application), signal);
    const session: CuaSession = {
      page,
      context: undefined as unknown as CuaBrowserContext,
      foreignPage: false,
      preexisting: new Set(),
      created: new Set(),
      closed: false
    };
    try {
      if (typeof page.context !== "function") {
        throw new ControlStackError("cua_context_unavailable", "browser page exposes no context");
      }
      session.context = page.context();
      // Snapshot the tabs that predate this session so cleanup and escape detection only consider pages it created.
      session.preexisting = new Set(session.context.pages().filter((candidate) => candidate !== page));
      const context = session.context;
      // Without a way to remove the listener, a reused context would keep closing later sessions' pages: fail closed.
      if (typeof context.off !== "function") {
        throw new ControlStackError("cua_context_unavailable", "browser context cannot remove a page listener");
      }
      const onPage = (opened: CuaPage) => {
        if (session.closed || opened === page || session.preexisting.has(opened)) return;
        session.created.add(opened);
        session.foreignPage = true;
        void Promise.resolve()
          .then(() => opened.close())
          .catch(() => undefined);
      };
      context.on("page", onPage);
      session.detach = () => context.off("page", onPage);
      await this.bounded(
        () =>
          session.context.route("**/*", (route) =>
            requestAllowed(route.request().url(), origins) ? route.continue() : route.abort("blockedbyclient")
          ),
        signal
      );
      // WebSockets bypass `route`, so they get their own allowlist; a context that cannot route them fails closed.
      if (typeof context.routeWebSocket !== "function") {
        throw new ControlStackError("cua_context_unavailable", "browser context cannot govern WebSockets");
      }
      await this.bounded(
        () =>
          context.routeWebSocket(/.*/u, (ws) => {
            let allowed: boolean;
            try {
              allowed = webSocketAllowed(ws.url(), origins);
            } catch {
              allowed = false;
            }
            if (allowed) return ws.connectToServer();
            return ws.close({ code: 1008, reason: "blocked by CUA origin allowlist" }).catch(() => undefined);
          }),
        signal
      );
      // Service-worker traffic bypasses the context route: a context that already runs one is not governable.
      if (this.serviceWorkerPresent(session)) {
        throw new ControlStackError("cua_context_unavailable", "browser context runs a service worker");
      }
    } catch (error) {
      await this.closeSession(session);
      throw error;
    }
    return session;
  }

  /**
   * True when any page other than the governed one appeared in the context (popups are closed as they open, and
   * their requests are already held to the allowlist by the context route). The governed page's own landing is
   * checked separately after every action.
   */
  private contextEscaped(session: CuaSession): boolean {
    if (session.foreignPage) return true;
    if (this.serviceWorkerPresent(session)) return true;
    let pages: CuaPage[];
    try {
      pages = session.context.pages();
    } catch {
      return true;
    }
    return pages.some((candidate) => candidate !== session.page && !session.preexisting.has(candidate));
  }

  /** True when the context runs (or may run) a service worker. A missing or throwing hook counts as present. */
  private serviceWorkerPresent(session: CuaSession): boolean {
    try {
      if (typeof session.context.serviceWorkers !== "function") return true;
      const workers = session.context.serviceWorkers();
      return !Array.isArray(workers) || workers.length > 0;
    } catch {
      return true;
    }
  }

  /**
   * Close the governed page and every page this session created, each bounded by the deadline. Tabs that were already
   * open in a reused context are left alone. A close failure never replaces a result.
   */
  private async closeSession(session: CuaSession): Promise<void> {
    session.closed = true;
    try {
      session.detach?.();
    } catch {
      // The closed flag already makes a listener that could not be removed inert.
    }
    const pages = new Set<CuaPage>([session.page, ...session.created]);
    try {
      if (session.context) {
        for (const candidate of session.context.pages()) {
          if (!session.preexisting.has(candidate)) pages.add(candidate);
        }
      }
    } catch {
      // Fall back to the governed page and the pages seen being created.
    }
    for (const candidate of pages) {
      try {
        await this.bounded(() => candidate.close());
      } catch {
        // A close failure or timeout must not replace a fenced result or invite a retry.
      }
    }
  }

  async execute(dispatch: DispatchEnvelope, signal?: AbortSignal, claim?: ExecutionClaim): Promise<ResultEnvelope> {
    if (dispatch.lane !== this.lane) {
      throw new ControlStackError("execution_lane_mismatch", `cua adapter cannot execute ${dispatch.lane}`);
    }
    // Only the live claim holder may open the browser: a missing or forged claim is refused before any side effect.
    if (!claim || stableHash(claim.claimToken) !== dispatch.claimTokenHash) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA execution requires the live claim token");
    }
    // One live executor per attempt: a second run cannot observe, settle or extend the first one's checkpoints.
    const owner = this.acquireLock(dispatch);
    try {
      return await this.executeLocked(dispatch, owner, signal);
    } finally {
      this.releaseLock(dispatch, owner);
    }
  }

  private get lockTtlMs(): number {
    return this.options.lockTtlMs ?? Math.max(5 * 60_000, 4 * this.timeoutMs);
  }

  /**
   * Single-host assumption (L2): lock expiry uses this process's clock. The store is embedded SQLite, whose `now` is
   * the same local clock, so there is no shared DB clock to use. Executors sharing a store need clock skew well under
   * lockTtlMs. Skew past that can only let a second host take the lock early, which the fence/owner checks turn into a
   * fail-closed cua_execution_lock_lost for the first run. See docs/mission-runtime.md.
   */
  private acquireLock(dispatch: DispatchEnvelope): string {
    const owner = randomUUID();
    const now = this.now();
    this.store.transaction(() => {
      const held = this.store.db
        .prepare("SELECT owner_id, expires_at FROM cua_execution_locks WHERE attempt_id = ?")
        .get(dispatch.attemptId) as { owner_id: string; expires_at: string } | undefined;
      if (held && Date.parse(held.expires_at) > Date.parse(now)) {
        throw new ControlStackError("cua_execution_in_progress", "another executor holds this CUA attempt");
      }
      this.store.db
        .prepare(
          `INSERT INTO cua_execution_locks (attempt_id, owner_id, expires_at) VALUES (?, ?, ?)
           ON CONFLICT (attempt_id) DO UPDATE SET owner_id = excluded.owner_id, expires_at = excluded.expires_at`
        )
        .run(dispatch.attemptId, owner, new Date(Date.parse(now) + this.lockTtlMs).toISOString());
    });
    return owner;
  }

  /** Inside a transaction: the caller must still own the attempt lock; extends its lease. */
  private renewLockInTransaction(dispatch: DispatchEnvelope, owner: string): void {
    const changed = this.store.db
      .prepare("UPDATE cua_execution_locks SET expires_at = ? WHERE attempt_id = ? AND owner_id = ?")
      .run(new Date(Date.parse(this.now()) + this.lockTtlMs).toISOString(), dispatch.attemptId, owner);
    if (changed.changes !== 1) {
      throw new ControlStackError("cua_execution_lock_lost", "this executor no longer owns the CUA attempt");
    }
  }

  private releaseLock(dispatch: DispatchEnvelope, owner: string): void {
    this.store.transaction(() => {
      this.store.db
        .prepare("DELETE FROM cua_execution_locks WHERE attempt_id = ? AND owner_id = ?")
        .run(dispatch.attemptId, owner);
    });
  }

  /**
   * The dispatch persisted for this attempt, after recomputing its hash and requiring the caller's envelope to equal it
   * canonically. Throws `cua_dispatch_missing`, `cua_dispatch_integrity` or `cua_dispatch_mismatch`.
   */
  private storedDispatch(dispatch: DispatchEnvelope): DispatchEnvelope {
    const row = this.store.db
      .prepare(
        "SELECT executor_lane, dispatch_hash, dispatch_json FROM work_unit_execution_attempts WHERE attempt_id = ?"
      )
      .get(dispatch.attemptId) as { executor_lane: string; dispatch_hash: string; dispatch_json: string } | undefined;
    if (!row || row.executor_lane !== this.lane || typeof row.dispatch_json !== "string") {
      throw new ControlStackError("cua_dispatch_missing", "no stored CUA dispatch for this attempt");
    }
    let stored: DispatchEnvelope;
    try {
      stored = JSON.parse(row.dispatch_json) as DispatchEnvelope;
    } catch {
      throw new ControlStackError("cua_dispatch_integrity", "stored CUA dispatch is unreadable");
    }
    if (
      !stored ||
      typeof stored !== "object" ||
      stableHash(stored) !== row.dispatch_hash ||
      stored.attemptId !== dispatch.attemptId ||
      stored.lane !== this.lane
    ) {
      throw new ControlStackError("cua_dispatch_integrity", "stored CUA dispatch does not match its recorded hash");
    }
    let suppliedHash: string;
    try {
      suppliedHash = stableHash(dispatch);
    } catch {
      suppliedHash = "";
    }
    if (suppliedHash !== row.dispatch_hash) {
      throw new ControlStackError("cua_dispatch_mismatch", "supplied CUA dispatch differs from the stored dispatch");
    }
    return stored;
  }

  /** The live authority verdict for this attempt, from the stored dispatch only. Any failure is a refusal code. */
  private authorityRefusal(
    stored: DispatchEnvelope,
    origins: readonly string[],
    applications: readonly string[]
  ): string | undefined {
    const checker = this.options.authority;
    if (!checker) return "cua_authority_unavailable";
    try {
      const verdict = checker.browserAuthorityVerdict({
        missionId: stored.missionId,
        unitId: stored.unitId,
        origins,
        applications,
        deadlineAt: stored.authority?.deadlineAt
      });
      if (verdict.ok === true) return undefined;
      return typeof verdict.reason === "string" && verdict.reason.startsWith("cua_")
        ? verdict.reason
        : "cua_authority_unavailable";
    } catch {
      return "cua_authority_unavailable";
    }
  }

  /** Whether the live authority grants this exact secret. No checker, a throw or any refusal fails closed. */
  private secretRefusal(stored: DispatchEnvelope, secretRef: string): string | undefined {
    const checker = this.options.authority;
    if (!checker || typeof checker.secretAuthorityVerdict !== "function") return "cua_secret_not_granted";
    try {
      const verdict = checker.secretAuthorityVerdict({
        missionId: stored.missionId,
        unitId: stored.unitId,
        secretRef
      });
      return verdict.ok === true ? undefined : "cua_secret_not_granted";
    } catch {
      return "cua_secret_not_granted";
    }
  }

  private async executeLocked(
    dispatch: DispatchEnvelope,
    owner: string,
    signal?: AbortSignal
  ): Promise<ResultEnvelope> {
    // The script, origin allowlist and application come only from the dispatch ACS stored for this attempt, never from
    // the caller's envelope. The stored dispatch must still hash to its recorded hash, and the caller's envelope must be
    // that exact dispatch; anything else fails closed before any browser call.
    const stored = this.storedDispatch(dispatch);
    // Resume uses persisted checkpoints only after verifying each against the persisted attempt and dispatch.
    const verified = verifyCuaCheckpoints(this.store.db, dispatch.attemptId, this.application);
    if (!verified.ok) {
      throw new ControlStackError("cua_checkpoint_integrity", `CUA checkpoint integrity failure: ${verified.defect}`);
    }
    const prior = verified.rows;
    if (prior.some((row) => row.state === "uncertain" || row.state === "planned")) {
      if (prior.some((row) => row.state === "planned")) this.settlePlanned(dispatch, owner);
      return this.unknownResult(dispatch, committedReceipts(this.checkpoints(dispatch.attemptId)));
    }
    if (prior.length > 0) {
      const receipts = committedReceipts(prior);
      const mutated = prior.some((row) => row.state === "committed" && MUTATING.has(row.action_type));
      if (signal?.aborted) return this.cancelled(dispatch, mutated, receipts);
      return this.unknownResult(dispatch, receipts);
    }
    if (signal?.aborted) return this.cancelled(dispatch, false, []);

    let payload;
    try {
      payload = parseWorkUnitPayload("cua", stored.payload ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : "cua payload is invalid";
      return this.failed(dispatch, "invalid_output", "cua_payload_invalid", message, []);
    }
    if (payload.kind !== "cua") {
      return this.failed(dispatch, "invalid_output", "cua_payload_invalid", "cua payload is required", []);
    }
    const applications = payload.allowedApplications ?? [];
    if (this.application.length === 0 || applications.length === 0 || !applications.includes(this.application)) {
      return this.failed(dispatch, "policy_denied", "cua_application_denied", "application is not allowlisted", []);
    }
    const origins = payload.allowedOrigins ?? [];
    const actions = payload.actions ?? [];
    if (actions.length === 0) {
      // No script is not success: the objective was not performed.
      return this.failed(dispatch, "invalid_output", "cua_payload_invalid", "cua script has no actions", []);
    }
    if (!this.options.secrets && actions.some((action) => action.type === "type" && "secretRef" in action)) {
      return this.failed(dispatch, "policy_denied", "cua_secret_unavailable", "no secret resolver is configured", []);
    }
    // Every secretRef must be granted (secret.read and that exact secret resource) before the browser opens.
    for (const action of actions) {
      if (action.type === "type" && "secretRef" in action) {
        const secretRefusal = this.secretRefusal(stored, action.secretRef);
        if (secretRefusal) {
          return this.failed(dispatch, "policy_denied", secretRefusal, "CUA authority does not grant this secret", []);
        }
      }
    }

    this.assertFence(dispatch, owner);
    let session: CuaSession | undefined;
    let page: CuaPage | undefined;
    let committedMutation = false;
    let requireAllowlisted = false;
    const receipts: ExecutionReceipt[] = [];
    try {
      for (const [sequence, action] of actions.entries()) {
        if (signal?.aborted) return this.cancelled(dispatch, committedMutation, receipts);
        const hash = cuaActionHash(action);
        if (page) {
          let liveUrl: string;
          try {
            liveUrl = page.url();
          } catch {
            return this.unknownResult(dispatch, receipts);
          }
          const freshBlank = liveUrl === "about:blank" && !requireAllowlisted;
          const navigateFromBlank = action.type === "navigate" && freshBlank;
          if (!navigateFromBlank && landingUncertain(action.type, liveUrl, origins, requireAllowlisted)) {
            return this.unknownResult(dispatch, receipts);
          }
        }
        const refusal = this.refusal(action, origins);
        if (refusal) {
          return this.failed(dispatch, "policy_denied", refusal, "CUA action refused", receipts);
        }
        if (
          !page &&
          action.type !== "navigate" &&
          landingUncertain(action.type, "about:blank", origins, requireAllowlisted)
        ) {
          return this.failed(
            dispatch,
            "policy_denied",
            "cua_origin_denied",
            "page origin is not allowlisted",
            receipts
          );
        }
        // Live authority re-check right before this browser step (the first one opens the browser): a grant revoked,
        // expired, past its dispatch deadline or narrowed since dispatch stops the script here.
        const authorityRefusal = this.authorityRefusal(stored, origins, applications);
        if (authorityRefusal) {
          return this.failed(
            dispatch,
            "policy_denied",
            authorityRefusal,
            "CUA authority no longer covers this attempt",
            receipts
          );
        }
        if (this.plan(dispatch, owner, action, sequence, hash) === "blocked") {
          this.settlePlanned(dispatch, owner);
          return this.unknownResult(dispatch, committedReceipts(this.checkpoints(dispatch.attemptId)));
        }
        if (!page) {
          try {
            session = await this.openSession(origins, signal);
            page = session.page;
          } catch (error) {
            if (isFenceError(error)) throw error;
            this.finish(dispatch, owner, sequence, action.type, hash, "uncertain", { uncertain: true, origin: null });
            if (error instanceof CuaInterrupted && error.reason === "aborted") {
              return this.cancelled(dispatch, true, receipts);
            }
            return this.unknownResult(dispatch, receipts);
          }
        }
        try {
          // Ownership (claim, attempt, fence and execution lock) is re-checked and the lock renewed immediately before
          // every browser action. A stale worker or an executor whose lock expired or was taken stops here, before acting.
          // The window between this check and the browser call cannot be closed; an effect inside it is uncertain.
          this.assertFence(dispatch, owner);
          // Authority is re-read after the browser is open and right before acting: opening can take long enough for a
          // grant to be revoked, expire or pass its deadline after the pre-plan check above. No action has run on this
          // checkpoint, but the browser was opened under it, so it is settled uncertain and the refusal is not retryable.
          // A secretRef is re-checked against the live grant right before it is leased.
          const liveRefusal =
            this.authorityRefusal(stored, origins, applications) ??
            (action.type === "type" && "secretRef" in action
              ? this.secretRefusal(stored, action.secretRef)
              : undefined);
          if (liveRefusal) {
            this.finish(dispatch, owner, sequence, action.type, hash, "uncertain", {
              uncertain: true,
              origin: pageOrigin(page.url())
            });
            return this.refusedAfterOpen(dispatch, liveRefusal, receipts);
          }
          const effect = await this.perform(dispatch, page, action, origins, requireAllowlisted, signal);
          if (session && this.contextEscaped(session)) effect.uncertain = true;
          if (effect.uncertain) {
            this.finish(dispatch, owner, sequence, action.type, hash, "uncertain", effect);
            return this.unknownResult(dispatch, receipts);
          }
          const receiptHash = this.finish(dispatch, owner, sequence, action.type, hash, "committed", effect);
          receipts.push({ kind: receiptKind(action.type), hash: receiptHash });
          if (MUTATING.has(action.type)) {
            committedMutation = true;
            requireAllowlisted = true;
          }
        } catch (error) {
          if (isFenceError(error)) throw error;
          let origin: string | null = null;
          try {
            origin = pageOrigin(page.url());
          } catch {
            origin = null;
          }
          this.finish(dispatch, owner, sequence, action.type, hash, "uncertain", { uncertain: true, origin });
          if (error instanceof CuaInterrupted && error.reason === "aborted") {
            return this.cancelled(dispatch, true, receipts);
          }
          return this.unknownResult(dispatch, receipts);
        }
        if (signal?.aborted) return this.cancelled(dispatch, committedMutation, receipts);
      }
      return this.succeeded(dispatch, receipts);
    } finally {
      if (session) await this.closeSession(session);
    }
  }

  private refusal(action: CuaAction, origins: readonly string[]): string | undefined {
    if (action.type === "navigate") {
      if (!approvedNavigation(action.url, origins)) {
        return action.url.trim().toLowerCase().startsWith("javascript:") ? "cua_scheme_denied" : "cua_origin_denied";
      }
      return undefined;
    }
    if (action.type !== "observe" && origins.length === 0) return "cua_origin_denied";
    return undefined;
  }

  private async perform(
    dispatch: DispatchEnvelope,
    page: CuaPage,
    action: CuaAction,
    origins: readonly string[],
    requireAllowlisted: boolean,
    signal?: AbortSignal
  ): Promise<ActionEffect> {
    let screenshotHash: string | undefined;
    if (action.type === "observe") {
      const bytes = await this.bounded(() => page.screenshot(), signal);
      if (!(bytes instanceof Uint8Array)) {
        throw new ControlStackError("cua_observation_invalid", "screenshot was not bytes");
      }
      this.assertScreenshotBounded(bytes);
      screenshotHash = sha256Bytes(bytes);
    } else if (action.type === "click") {
      await this.bounded(() => page.locator(action.selector).click(), signal);
    } else if (action.type === "type") {
      if ("secretRef" in action) {
        const resolver = this.options.secrets;
        if (!resolver) throw new ControlStackError("cua_secret_unavailable", "no secret resolver is configured");
        const principal: CuaSecretPrincipal = {
          workerId: dispatch.workerId,
          missionId: dispatch.missionId,
          unitId: dispatch.unitId,
          attemptId: dispatch.attemptId,
          application: this.application
        };
        // The resolved value lives only in this call frame: it is never hashed, stored, logged or returned.
        const value = await this.bounded(() => resolver.resolve(action.secretRef, principal), signal);
        await this.bounded(() => page.locator(action.selector).fill(value), signal);
      } else {
        await this.bounded(() => page.locator(action.selector).fill(action.text), signal);
      }
    } else if (action.type === "scroll") {
      await this.bounded(() => page.mouse.wheel(action.dx, action.dy), signal);
    } else {
      const approved = approvedNavigation(action.url, origins);
      if (!approved) return { uncertain: true, origin: null };
      await this.bounded(() => page.goto(approved.href), signal);
    }
    const url = page.url();
    return {
      uncertain: landingUncertain(action.type, url, origins, requireAllowlisted),
      origin: pageOrigin(url),
      ...(screenshotHash ? { screenshotHash } : {})
    };
  }

  /**
   * The full fence, then a lease renewal, in one transaction. Run immediately before every browser action, so a stale
   * executor (its claim, attempt, fencing token or execution lock gone or expired) stops before acting.
   */
  /**
   * Caps a screenshot before it is hashed: byte length first, then the PNG header's width, height and pixel count.
   * Anything over a cap, or not a PNG, fails the observe action (recorded uncertain) without hashing the bytes.
   */
  private assertScreenshotBounded(bytes: Uint8Array): void {
    const maxBytes = this.options.maxScreenshotBytes ?? DEFAULT_MAX_SCREENSHOT_BYTES;
    if (bytes.byteLength > maxBytes) {
      throw new ControlStackError("cua_observation_too_large", "screenshot exceeds the byte cap");
    }
    const size = pngDimensions(bytes);
    if (!size) throw new ControlStackError("cua_observation_invalid", "screenshot is not a PNG image");
    const maxDimension = this.options.maxScreenshotDimension ?? DEFAULT_MAX_SCREENSHOT_DIMENSION;
    const maxPixels = this.options.maxScreenshotPixels ?? DEFAULT_MAX_SCREENSHOT_PIXELS;
    if (
      size.width === 0 ||
      size.height === 0 ||
      size.width > maxDimension ||
      size.height > maxDimension ||
      size.width * size.height > maxPixels
    ) {
      throw new ControlStackError("cua_observation_too_large", "screenshot dimensions exceed the cap");
    }
  }

  private assertFence(dispatch: DispatchEnvelope, owner: string): void {
    this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch, owner);
      this.renewLockInTransaction(dispatch, owner);
    });
  }

  /**
   * Inside a transaction: the caller still holds the live claim, the started attempt and its fencing token, and still
   * owns an unexpired execution lock for the attempt. Any mismatch throws before the caller can act or write.
   */
  private assertFenceInTransaction(dispatch: DispatchEnvelope, owner: string): void {
    const lock = this.store.db
      .prepare("SELECT owner_id, expires_at FROM cua_execution_locks WHERE attempt_id = ?")
      .get(dispatch.attemptId) as { owner_id: string; expires_at: string } | undefined;
    const now = Date.parse(this.now());
    const expiresAt = lock ? Date.parse(lock.expires_at) : Number.NaN;
    if (
      !lock ||
      lock.owner_id !== owner ||
      !Number.isFinite(now) ||
      !Number.isFinite(expiresAt) ||
      !(expiresAt > now)
    ) {
      throw new ControlStackError("cua_execution_lock_lost", "this executor no longer owns a live CUA attempt lock");
    }
    const unit = this.store.db
      .prepare(
        `SELECT status, claim_token, worker_id, attempt
         FROM coding_operations WHERE mission_id = ? AND operation_id = ?`
      )
      .get(dispatch.missionId, dispatch.unitId) as
      { status: string; claim_token: string | null; worker_id: string | null; attempt: number } | undefined;
    if (
      !unit ||
      unit.status !== "running" ||
      unit.worker_id !== dispatch.workerId ||
      unit.attempt !== dispatch.unitAttempt ||
      !unit.claim_token ||
      stableHash(unit.claim_token) !== dispatch.claimTokenHash
    ) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fence does not match the live claim");
    }
    const attempt = this.store.db
      .prepare(
        `SELECT claim_token_hash, worker_id, unit_attempt, state, authority_json
         FROM work_unit_execution_attempts WHERE attempt_id = ?`
      )
      .get(dispatch.attemptId) as
      | {
          claim_token_hash: string;
          worker_id: string;
          unit_attempt: number;
          state: string;
          authority_json: string;
        }
      | undefined;
    if (
      !attempt ||
      attempt.state !== "started" ||
      attempt.claim_token_hash !== dispatch.claimTokenHash ||
      attempt.worker_id !== dispatch.workerId ||
      attempt.unit_attempt !== dispatch.unitAttempt
    ) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fence does not match the execution attempt");
    }
    let storedFence: unknown;
    try {
      storedFence = (JSON.parse(attempt.authority_json) as { fencingToken?: unknown }).fencingToken;
    } catch {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fencing token is unreadable");
    }
    const expected = dispatch.authority.fencingToken;
    const stored = typeof storedFence === "number" && Number.isInteger(storedFence) ? storedFence : undefined;
    if (stored !== expected) {
      throw new ControlStackError("coding_mission_claim_conflict", "CUA fencing token does not match");
    }
  }

  private plan(
    dispatch: DispatchEnvelope,
    owner: string,
    action: CuaAction,
    sequence: number,
    hash: string
  ): "inserted" | "blocked" {
    return this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch, owner);
      this.renewLockInTransaction(dispatch, owner);
      const existing = this.checkpoint(dispatch.attemptId, sequence);
      if (existing) return "blocked";
      if (sequence > 0) {
        const previous = this.checkpoint(dispatch.attemptId, sequence - 1);
        if (!previous || previous.state !== "committed") {
          throw new ControlStackError("coding_mission_claim_conflict", "CUA checkpoint sequence is not contiguous");
        }
      }
      this.store.db
        .prepare(
          `INSERT INTO cua_action_checkpoints (
             attempt_id, mission_id, unit_id, unit_attempt, worker_id, claim_token_hash, fencing_token,
             sequence, action_type, action_hash, state, screenshot_hash, receipt_hash, origin, application, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, NULL, ?, ?)`
        )
        .run(
          dispatch.attemptId,
          dispatch.missionId,
          dispatch.unitId,
          dispatch.unitAttempt,
          dispatch.workerId,
          dispatch.claimTokenHash,
          dispatch.authority.fencingToken ?? null,
          sequence,
          action.type,
          hash,
          cuaCheckpointReceiptHash({
            attemptId: dispatch.attemptId,
            sequence,
            application: this.application,
            actionType: action.type,
            actionHash: hash,
            state: "planned",
            origin: null,
            screenshotHash: null
          }),
          this.application,
          this.now()
        );
      return "inserted";
    });
  }

  private finish(
    dispatch: DispatchEnvelope,
    owner: string,
    sequence: number,
    actionType: CuaActionType,
    hash: string,
    state: "committed" | "uncertain",
    effect: ActionEffect
  ): string {
    const receiptHash = cuaCheckpointReceiptHash({
      attemptId: dispatch.attemptId,
      sequence,
      application: this.application,
      actionType,
      actionHash: hash,
      state,
      origin: effect.origin,
      screenshotHash: effect.screenshotHash ?? null
    });
    this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch, owner);
      this.renewLockInTransaction(dispatch, owner);
      const changed = this.store.db
        .prepare(
          `UPDATE cua_action_checkpoints
           SET state = ?, screenshot_hash = ?, receipt_hash = ?, origin = ?
           WHERE attempt_id = ? AND sequence = ? AND state = 'planned' AND action_hash = ?`
        )
        .run(state, effect.screenshotHash ?? null, receiptHash, effect.origin, dispatch.attemptId, sequence, hash);
      if (changed.changes !== 1) {
        throw new ControlStackError("coding_mission_claim_conflict", "CUA checkpoint could not be fenced");
      }
    });
    return receiptHash;
  }

  private settlePlanned(dispatch: DispatchEnvelope, owner: string): void {
    this.store.transaction(() => {
      this.assertFenceInTransaction(dispatch, owner);
      // Only the lock owner settles: a planned row left by an owner whose lock was released or expired.
      this.renewLockInTransaction(dispatch, owner);
      const planned = this.checkpoints(dispatch.attemptId).filter((row) => row.state === "planned");
      for (const row of planned) {
        const receiptHash = cuaCheckpointReceiptHash({
          attemptId: row.attempt_id,
          sequence: row.sequence,
          application: row.application,
          actionType: row.action_type,
          actionHash: row.action_hash,
          state: "uncertain",
          origin: row.origin ?? null,
          screenshotHash: null
        });
        const changed = this.store.db
          .prepare(
            `UPDATE cua_action_checkpoints
             SET state = 'uncertain', receipt_hash = ?
             WHERE attempt_id = ? AND sequence = ? AND state = 'planned'`
          )
          .run(receiptHash, dispatch.attemptId, row.sequence);
        if (changed.changes !== 1) {
          throw new ControlStackError("coding_mission_claim_conflict", "planned CUA checkpoint could not be fenced");
        }
      }
    });
  }

  private checkpoints(attemptId: string): CheckpointRow[] {
    return this.store.db
      .prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM cua_action_checkpoints WHERE attempt_id = ? ORDER BY sequence`)
      .all(attemptId) as unknown as CheckpointRow[];
  }

  private checkpoint(attemptId: string, sequence: number): CheckpointRow | undefined {
    return this.store.db
      .prepare(`SELECT ${CHECKPOINT_COLUMNS} FROM cua_action_checkpoints WHERE attempt_id = ? AND sequence = ?`)
      .get(attemptId, sequence) as CheckpointRow | undefined;
  }

  private succeeded(dispatch: DispatchEnvelope, receipts: ExecutionReceipt[]): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "succeeded",
      receipts,
      result: { resultHash: cuaResultHash(receipts), files: [] },
      externalStateUncertain: false
    };
  }

  private failed(
    dispatch: DispatchEnvelope,
    category: "policy_denied" | "invalid_output",
    code: string,
    message: string,
    receipts: ExecutionReceipt[]
  ): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "failed",
      receipts,
      failure: {
        category,
        nativeCode: boundedText(code),
        nativeMessage: boundedText(message),
        retrySafe: false
      },
      externalStateUncertain: false
    };
  }

  /** A policy refusal after the browser opened on a planned checkpoint: failed, never retry-safe, state uncertain. */
  private refusedAfterOpen(dispatch: DispatchEnvelope, code: string, receipts: ExecutionReceipt[]): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "failed",
      receipts,
      failure: {
        category: "policy_denied",
        nativeCode: boundedText(code),
        nativeMessage: boundedText("CUA authority no longer covers this attempt"),
        retrySafe: false
      },
      externalStateUncertain: true
    };
  }

  private cancelled(
    dispatch: DispatchEnvelope,
    externalStateUncertain: boolean,
    receipts: ExecutionReceipt[]
  ): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "cancelled",
      receipts,
      failure: { category: "cancelled", retrySafe: false },
      externalStateUncertain
    };
  }

  private unknownResult(dispatch: DispatchEnvelope, receipts: ExecutionReceipt[]): ResultEnvelope {
    return {
      ...resultBase(dispatch, this.now()),
      outcome: "unknown",
      receipts,
      failure: {
        category: "unknown",
        nativeCode: "cua_external_state_uncertain",
        retrySafe: false
      },
      externalStateUncertain: true
    };
  }
}

const committedReceipts = committedCuaReceipts;
