/**
 * Deterministic context packs (read-only). The same sources and budget always
 * produce the same packHash, so a pack can be replayed and compared.
 *
 * Pipeline, in order:
 *  1. Resolve: file sources are contained to the filesystem roots, read with a
 *     size cap, hashed (sourceSha256), and checked against expectedSha256. A
 *     mismatch is dropped as `stale`: the caller asked for a version that no
 *     longer exists, so it is not silently replaced by the current one.
 *  2. Order: priority descending, then id ascending. Ids are unique.
 *  3. Redact: common secret shapes become [REDACTED:<name>]. Best effort: it
 *     reduces accidental leakage, it is not a data-loss-prevention guarantee.
 *  4. Fence and budget: each item is wrapped in a <context> element carrying its
 *     provenance. Non-operator text has `</context` escaped so it cannot close the
 *     wrapper. An item that does not fit is cut at the largest length that still
 *     fits (marked truncated) if at least MIN_PARTIAL_TOKENS remain; otherwise it
 *     is dropped with reason `budget`.
 *  5. Hash: packHash covers provenance and drop decisions, not wall-clock time.
 *
 * Token counts are estimates (ceil(characters / 4)), not a model tokenizer. The
 * budget is an upper bound on the estimate, which is what keeps it deterministic.
 */
import { createHash } from 'node:crypto';
import { openContained, type JcFsPolicy, type OpenedPath } from './filesystem.js';
import { IntegrationError } from './integrations.js';

export const CONTEXT_PACK_VERSION = 'jc.context-pack.v1';
export const CONTEXT_TRUST_LEVELS = Object.freeze(['operator', 'repo', 'tool-output', 'external'] as const);
export type ContextTrust = typeof CONTEXT_TRUST_LEVELS[number];

const CHARS_PER_TOKEN = 4;
/** Characters the `\n\n` join adds between items; reserved per item so `usedTokens` never exceeds the budget. */
const SEPARATOR_CHARS = 2;
const DEFAULT_BUDGET_TOKENS = 8_000;
const MIN_PARTIAL_TOKENS = 64;
const MAX_FILE_BYTES = 512 * 1024;
const MAX_SOURCES = 16;

export type DropReason =
  | 'missing'
  | 'stale'
  | 'binary'
  | 'oversize'
  | 'path_not_allowed'
  | 'fs_roots_unconfigured'
  | 'read_failed'
  | 'budget';

/** One source as the caller described it. */
export interface ContextSourceSpec {
  id: string;
  kind: 'file' | 'inline';
  path?: string;
  text?: string;
  trust: ContextTrust;
  priority?: number;
  expectedSha256?: string;
}

/** A source after resolution: either usable text, or a drop decision made before budgeting. */
export type ResolvedSource =
  | {
    status: 'ok';
    id: string;
    kind: 'file' | 'inline';
    location: string;
    trust: ContextTrust;
    priority: number;
    text: string;
    sourceSha256: string;
  }
  | {
    status: 'dropped';
    id: string;
    kind: 'file' | 'inline';
    location: string;
    trust: ContextTrust;
    priority: number;
    reason: DropReason;
    sourceSha256?: string;
  };

export interface ContextPackItem {
  id: string;
  kind: 'file' | 'inline';
  trust: ContextTrust;
  location: string;
  priority: number;
  sourceSha256: string;
  emittedSha256: string;
  redactions: Record<string, number>;
  truncated: boolean;
  tokens: number;
}

export interface ContextPackDrop {
  id: string;
  location: string;
  reason: DropReason;
  sourceSha256?: string;
}

export interface ContextPack {
  version: typeof CONTEXT_PACK_VERSION;
  packHash: string;
  budgetTokens: number;
  usedTokens: number;
  items: ContextPackItem[];
  dropped: ContextPackDrop[];
  rendered: string;
}

const REDACTIONS: ReadonlyArray<{ name: string; pattern: RegExp; replace?: (match: string, ...groups: string[]) => string }> = [
  { name: 'private_key', pattern: /-----BEGIN [A-Z ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]{0,40}PRIVATE KEY-----|$)/gu },
  { name: 'bearer', pattern: /Bearer\s+[A-Za-z0-9._~+/-]{8,4096}=*/giu },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{12,}/gu },
  { name: 'github_token', pattern: /\b(?:gh[pousr]|github_pat)_[A-Za-z0-9_]{20,}/gu },
  { name: 'slack_token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu },
  { name: 'aws_access_key', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu },
  {
    name: 'url_credentials',
    pattern: /(\b[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/:@]{1,256}:)[^\s/@]{1,256}@/gu,
    replace: (_match, prefix) => `${prefix}[REDACTED:url_credentials]@`,
  },
  {
    name: 'assignment',
    pattern: /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key)[A-Za-z0-9_.-]*\s*[:=]\s*)(["']?)[^\s"',;]{6,}\2/giu,
    replace: (_match, prefix, quote) => `${prefix}${quote}[REDACTED:assignment]${quote}`,
  },
];

/** Redacts known secret shapes; returns the text and how many of each shape were replaced. */
export function redactContext(text: string): { text: string; redactions: Record<string, number> } {
  const redactions: Record<string, number> = {};
  let out = text;
  for (const rule of REDACTIONS) {
    out = out.replace(rule.pattern, (...args: unknown[]) => {
      redactions[rule.name] = (redactions[rule.name] ?? 0) + 1;
      // String.replace passes (match, ...groups, offset, input); the last two are not groups.
      const [match = '', ...groups] = args.slice(0, -2) as string[];
      if (rule.replace) return rule.replace(match, ...groups);
      return `[REDACTED:${rule.name}]`;
    });
  }
  return { text: out, redactions };
}

export function sha256Hex(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Estimated tokens: ceil(characters / 4). A budget bound, not a model tokenizer count. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** `</context` in content would close the wrapper early; escape it in every item, operator included. */
function escapeBody(text: string): string {
  return text.replace(/<\/context/giu, '<\\/context');
}

/** Attribute values come from callers and file paths; escape them so none can end the attribute. */
function attr(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/"/gu, '&quot;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
}

function wrap(item: { id: string; trust: ContextTrust; location: string; sourceSha256: string; emittedSha256: string; truncated: boolean }, body: string): string {
  const attrs = [
    `id="${attr(item.id)}"`,
    `trust="${attr(item.trust)}"`,
    `location="${attr(item.location)}"`,
    `source_sha256="${item.sourceSha256}"`,
    `emitted_sha256="${item.emittedSha256}"`,
    ...(item.truncated ? ['truncated="true"'] : []),
  ];
  return `<context ${attrs.join(' ')}>\n${body}\n</context>`;
}

function truncationMarker(omitted: number, total: number): string {
  return `\n[truncated: ${omitted} of ${total} characters omitted]`;
}

/**
 * Pure assembly: the same resolved inputs and budget always give the same pack.
 * Throws only on structural errors (duplicate ids, bad budget); every per-source
 * problem becomes a `dropped` entry.
 */
export function assembleContextPack(sources: readonly ResolvedSource[], budgetTokens: number = DEFAULT_BUDGET_TOKENS): ContextPack {
  if (!Number.isInteger(budgetTokens) || budgetTokens < 1) throw new IntegrationError('invalid_argument', 'budgetTokens must be a positive integer');
  const seen = new Set<string>();
  for (const source of sources) {
    if (seen.has(source.id)) throw new IntegrationError('invalid_argument', `duplicate source id: ${source.id}`);
    seen.add(source.id);
  }

  const ordered = [...sources].sort((a, b) => (b.priority - a.priority) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const budgetChars = budgetTokens * CHARS_PER_TOKEN;
  const items: ContextPackItem[] = [];
  const dropped: ContextPackDrop[] = [];
  const parts: string[] = [];
  let usedChars = 0;

  for (const source of ordered) {
    if (source.status === 'dropped') {
      dropped.push({ id: source.id, location: source.location, reason: source.reason, ...(source.sourceSha256 ? { sourceSha256: source.sourceSha256 } : {}) });
      continue;
    }
    const redacted = redactContext(source.text);
    const fullBody = escapeBody(redacted.text);
    const remaining = budgetChars - usedChars - SEPARATOR_CHARS;

    const build = (body: string, truncated: boolean): { wrapped: string; item: ContextPackItem } => {
      const meta = { id: source.id, trust: source.trust, location: source.location, sourceSha256: source.sourceSha256, emittedSha256: sha256Hex(body), truncated };
      const wrapped = wrap(meta, body);
      return {
        wrapped,
        item: {
          id: source.id,
          kind: source.kind,
          trust: source.trust,
          location: source.location,
          priority: source.priority,
          sourceSha256: source.sourceSha256,
          emittedSha256: meta.emittedSha256,
          redactions: redacted.redactions,
          truncated,
          tokens: estimateTokens(wrapped),
        },
      };
    };

    let chosen = build(fullBody, false);
    if (chosen.wrapped.length > remaining) {
      // Largest prefix whose wrapped, marked form still fits. Binary search over a monotone size.
      const minTokens = MIN_PARTIAL_TOKENS * CHARS_PER_TOKEN;
      let best: { wrapped: string; item: ContextPackItem } | undefined;
      if (remaining >= minTokens) {
        let lo = 0;
        let hi = fullBody.length;
        while (lo <= hi) {
          const mid = Math.floor((lo + hi) / 2);
          const candidate = build(fullBody.slice(0, mid) + truncationMarker(fullBody.length - mid, fullBody.length), true);
          if (candidate.wrapped.length <= remaining) {
            best = candidate;
            lo = mid + 1;
          } else {
            hi = mid - 1;
          }
        }
      }
      if (!best) {
        dropped.push({ id: source.id, location: source.location, reason: 'budget', sourceSha256: source.sourceSha256 });
        continue;
      }
      chosen = best;
    }
    usedChars += chosen.wrapped.length + SEPARATOR_CHARS;
    items.push(chosen.item);
    parts.push(chosen.wrapped);
  }

  const rendered = parts.join('\n\n');
  const packHash = sha256Hex(JSON.stringify({
    version: CONTEXT_PACK_VERSION,
    budgetTokens,
    items: items.map((item) => [item.id, item.trust, item.location, item.sourceSha256, item.emittedSha256, item.truncated]),
    dropped: dropped.map((item) => [item.id, item.reason, item.sourceSha256 ?? null]),
  }));
  return {
    version: CONTEXT_PACK_VERSION,
    packHash,
    budgetTokens,
    usedTokens: estimateTokens(rendered),
    items,
    dropped,
    rendered,
  };
}

function dropReasonOf(error: unknown): DropReason {
  if (error instanceof IntegrationError) {
    if (error.code === 'not_found') return 'missing';
    if (error.code === 'path_not_allowed') return 'path_not_allowed';
    if (error.code === 'fs_roots_unconfigured') return 'fs_roots_unconfigured';
    if (error.code === 'permission_denied') return 'read_failed';
  }
  return 'read_failed';
}

/** Resolves one spec: contains and reads file sources, takes hashes, applies the freshness check. */
/**
 * Uses openContained, not a separate containment check and read: the path is opened once without
 * following symlinks, and the inode actually opened is re-contained. A symlink swapped in after the
 * check is refused rather than read.
 */
export async function resolveContextSource(spec: ContextSourceSpec, policy: JcFsPolicy): Promise<ResolvedSource> {
  const priority = spec.priority ?? 50;
  const base = { id: spec.id, kind: spec.kind, trust: spec.trust, priority };
  if (spec.kind === 'inline') {
    const text = spec.text ?? '';
    return { status: 'ok', ...base, location: 'inline', text, sourceSha256: sha256Hex(text) };
  }
  let opened: OpenedPath;
  try {
    opened = await openContained(spec.path, policy);
  } catch (error) {
    return { status: 'dropped', ...base, location: String(spec.path), reason: dropReasonOf(error) };
  }
  const real = opened.real;
  let content: Buffer;
  try {
    if (!opened.stats.isFile()) return { status: 'dropped', ...base, location: real, reason: 'read_failed' };
    if (opened.stats.size > MAX_FILE_BYTES) return { status: 'dropped', ...base, location: real, reason: 'oversize' };
    // Bounded read: the file can grow after stat, so count bytes as they arrive and stop at the cap.
    const chunks: Buffer[] = [];
    let total = 0;
    const buffer = Buffer.allocUnsafe(64 * 1024);
    for (;;) {
      const { bytesRead } = await opened.handle.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_FILE_BYTES) return { status: 'dropped', ...base, location: real, reason: 'oversize' };
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
    }
    content = Buffer.concat(chunks);
  } catch {
    return { status: 'dropped', ...base, location: real, reason: 'read_failed' };
  } finally {
    await opened.handle.close().catch(() => undefined);
  }
  const sourceSha256 = sha256Hex(content);
  if (content.includes(0)) return { status: 'dropped', ...base, location: real, reason: 'binary', sourceSha256 };
  if (spec.expectedSha256 !== undefined && spec.expectedSha256 !== sourceSha256) {
    return { status: 'dropped', ...base, location: real, reason: 'stale', sourceSha256 };
  }
  return { status: 'ok', ...base, location: real, text: content.toString('utf8'), sourceSha256 };
}

export interface ContextInlineSpec {
  id: string;
  text: string;
  trust: ContextTrust;
  priority?: number;
}

/**
 * The tool's request shape. File sources are a flat `files` list (ACS can contain each path, as it
 * does for every other path argument); `pins` gives expected hashes by path. Inline sources carry
 * their own id and trust.
 */
export interface ContextPackRequest {
  files?: readonly string[];
  pins?: Readonly<Record<string, string>>;
  fileTrust?: ContextTrust;
  inline?: readonly ContextInlineSpec[];
  budgetTokens?: number;
}

/** The read-only tool entry point: resolve every source, then assemble. */
/** Rejects anything outside the canonical request shape before it reaches assembly or attributes. */
function assertContextRequest(request: ContextPackRequest): void {
  const isTrust = (value: unknown) => (CONTEXT_TRUST_LEVELS as readonly unknown[]).includes(value);
  if (request.fileTrust !== undefined && !isTrust(request.fileTrust)) throw new IntegrationError('invalid_argument', 'fileTrust is not a known trust level');
  if (request.files !== undefined && (!Array.isArray(request.files) || request.files.some((file) => typeof file !== 'string' || file.length === 0))) {
    throw new IntegrationError('invalid_argument', 'files must be a list of non-empty path strings');
  }
  for (const item of request.inline ?? []) {
    if (typeof item.id !== 'string' || item.id.length === 0 || typeof item.text !== 'string' || !isTrust(item.trust)) {
      throw new IntegrationError('invalid_argument', 'inline entries need a string id and text and a known trust level');
    }
    if (item.priority !== undefined && (!Number.isInteger(item.priority) || item.priority < 0 || item.priority > 100)) {
      throw new IntegrationError('invalid_argument', 'inline priority must be an integer from 0 to 100');
    }
  }
}

export async function buildContextPack(request: ContextPackRequest, policy: JcFsPolicy): Promise<ContextPack> {
  assertContextRequest(request);
  const files = request.files ?? [];
  const inline = request.inline ?? [];
  const total = files.length + inline.length;
  if (total < 1 || total > MAX_SOURCES) {
    throw new IntegrationError('invalid_argument', `files and inline must hold 1 to ${MAX_SOURCES} sources in total`);
  }
  const pins = request.pins ?? {};
  for (const pinned of Object.keys(pins)) {
    if (!files.includes(pinned)) throw new IntegrationError('invalid_argument', `pins names a path that is not in files: ${pinned}`);
  }
  const trust = request.fileTrust ?? 'repo';
  const resolved = await Promise.all([
    ...files.map((file) => resolveContextSource({
      id: file, kind: 'file', path: file, trust, priority: 50, ...(pins[file] !== undefined ? { expectedSha256: pins[file] } : {}),
    }, policy)),
    ...inline.map((item) => resolveContextSource({ id: item.id, kind: 'inline', text: item.text, trust: item.trust, priority: item.priority }, policy)),
  ]);
  return assembleContextPack(resolved, request.budgetTokens ?? DEFAULT_BUDGET_TOKENS);
}
