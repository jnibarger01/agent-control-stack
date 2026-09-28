/**
 * Bounded filesystem search (fs.read): start_search, get_more_search_results,
 * list_searches, stop_search.
 *
 * The walk runs in the JC server process. The CLI reaches it only through
 * /jc/mcp, so ACS authorizes the same arguments the walker contains.
 *
 * ACS only contains the search ROOT it signs. Everything below the root is
 * contained here, entry by entry, with the same rules read_file and
 * list_directory apply (filesystem.ts):
 *   - denied roots (JC state dir, ~/.ssh, ~/.aws, ...) and credential paths
 *     (.env, credentials.json, *.pem, ...) are neither descended into, read,
 *     nor named in results;
 *   - symlinks are never followed, and every entry's realpath must stay
 *     inside the configured roots and outside every denied location;
 *   - file content is read only through openContained (O_NOFOLLOW, then the
 *     opened inode's path is contained again), so a file swapped for a
 *     symlink between the walk and the read is skipped, not followed.
 */
import { randomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { containJcPath, jcWalkGuard, openContained, readdirNoFollow, type JcFsPolicy, type JcWalkGuard } from './filesystem.js';
import { IntegrationError } from './integrations.js';

export const JC_SEARCH_LIMITS = Object.freeze({
  maxPatternLength: 256,
  maxPage: 100,
  defaultPage: 50,
  maxStoredHits: 500,
  maxFilesScanned: 10_000,
  maxFileBytes: 1024 * 1024,
  snippet: 160,
});

const SKIP_DIRS = new Set(['node_modules', '.git']);

export interface SearchHit {
  path: string;
  line?: number;
  text?: string;
}

interface SearchSession {
  searchId: string;
  root: string;
  mode: 'filename' | 'content';
  scanned: number;
  matched: number;
  done: boolean;
  truncated: boolean;
  cancelled: boolean;
  delivered: number;
  results: SearchHit[];
}

export interface SearchRegistry {
  start(args: Record<string, unknown>, policy: JcFsPolicy): Promise<Record<string, unknown>>;
  more(args: Record<string, unknown>): Record<string, unknown>;
  list(): Record<string, unknown>;
  stop(args: Record<string, unknown>): Record<string, unknown>;
}

function pageLimit(value: unknown): number {
  if (value === undefined) return JC_SEARCH_LIMITS.defaultPage;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > JC_SEARCH_LIMITS.maxPage) {
    throw new IntegrationError('invalid_argument', 'limit must be an integer from 1 to 100');
  }
  return value;
}

function compilePattern(pattern: unknown, regex: unknown, caseSensitive: unknown): RegExp {
  if (typeof pattern !== 'string' || pattern.length < 1 || pattern.length > JC_SEARCH_LIMITS.maxPatternLength) {
    throw new IntegrationError('invalid_argument', 'pattern must be a non-empty bounded string');
  }
  const flags = caseSensitive === false ? 'i' : '';
  const source = regex === true ? pattern : pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (regex === true && /(\([^)]*[+*][^)]*\))[+*{]/.test(pattern)) {
    throw new IntegrationError('invalid_argument', 'pattern is too expensive');
  }
  try {
    return new RegExp(source, flags);
  } catch {
    throw new IntegrationError('invalid_argument', 'pattern is not a valid regular expression');
  }
}

function fileFilter(filter: unknown, caseSensitive: unknown): RegExp | undefined {
  if (filter === undefined) return undefined;
  if (typeof filter !== 'string' || filter.length < 1 || filter.length > 128) {
    throw new IntegrationError('invalid_argument', 'fileFilter must be a bounded glob');
  }
  const source = `^${filter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`;
  return new RegExp(source, caseSensitive === false ? 'i' : '');
}

function snippet(line: string): string {
  const trimmed = line.trim().slice(0, JC_SEARCH_LIMITS.snippet);
  return trimmed.length < line.trim().length ? `${trimmed}…` : trimmed;
}

function page(session: SearchSession, limit: number): Record<string, unknown> {
  const results = session.results.slice(session.delivered, session.delivered + limit);
  session.delivered += results.length;
  return {
    searchId: session.searchId,
    root: session.root,
    mode: session.mode,
    scanned: session.scanned,
    matched: session.matched,
    done: session.done,
    truncated: session.truncated,
    cancelled: session.cancelled,
    returned: results.length,
    hasMore: session.delivered < session.results.length || !session.done,
    results,
  };
}

export function createSearchRegistry(): SearchRegistry {
  const sessions = new Map<string, SearchSession>();

  async function readContainedText(full: string, policy: JcFsPolicy): Promise<string | undefined> {
    let opened;
    try {
      opened = await openContained(full, policy);
    } catch {
      return undefined; // denied, swapped for a symlink, or vanished: skip silently
    }
    try {
      if (!opened.stats.isFile() || opened.stats.size > JC_SEARCH_LIMITS.maxFileBytes) return undefined;
      return await opened.handle.readFile({ encoding: 'utf8' });
    } catch {
      return undefined;
    } finally {
      await opened.handle.close().catch(() => undefined);
    }
  }

  async function walk(
    dir: string,
    session: SearchSession,
    matcher: RegExp,
    names: RegExp | undefined,
    mode: 'filename' | 'content',
    policy: JcFsPolicy,
    guard: JcWalkGuard,
  ): Promise<void> {
    if (session.cancelled || session.results.length >= JC_SEARCH_LIMITS.maxStoredHits || session.scanned >= JC_SEARCH_LIMITS.maxFilesScanned) {
      session.truncated = session.results.length >= JC_SEARCH_LIMITS.maxStoredHits || session.scanned >= JC_SEARCH_LIMITS.maxFilesScanned;
      return;
    }
    let entries: string[];
    try {
      // No-follow descriptor: a directory swapped for a symlink is not listed.
      entries = (await readdirNoFollow(dir)).sort((a, b) => a.localeCompare(b));
    } catch {
      return;
    }
    for (const name of entries) {
      if (session.cancelled || session.results.length >= JC_SEARCH_LIMITS.maxStoredHits || session.scanned >= JC_SEARCH_LIMITS.maxFilesScanned) {
        session.truncated = true;
        return;
      }
      if (SKIP_DIRS.has(name)) continue;
      const full = path.join(dir, name);
      // Denied locations and credential files are skipped before any stat:
      // not descended into, not read, not named.
      if (guard.isDenied(full)) continue;
      let stats;
      try {
        stats = await fs.lstat(full);
      } catch {
        continue;
      }
      // Symlinks are never followed (a link may point outside the roots or at
      // a denied location).
      if (stats.isSymbolicLink()) continue;
      // Every entry's realpath must still be inside the roots and outside the
      // denied locations (defends against a parent swapped mid-walk).
      let real: string;
      try {
        real = realpathSync(full);
      } catch {
        continue;
      }
      if (!guard.isContainedReal(real)) continue;
      if (stats.isDirectory()) {
        await walk(full, session, matcher, names, mode, policy, guard);
        continue;
      }
      if (!stats.isFile()) continue;
      session.scanned += 1;
      if (names && !names.test(name)) continue;
      if (mode === 'filename') {
        if (matcher.test(name)) session.results.push({ path: full });
        continue;
      }
      if (stats.size > JC_SEARCH_LIMITS.maxFileBytes) continue;
      const text = await readContainedText(full, policy);
      if (text === undefined || text.includes('\0')) continue;
      const lines = text.split(/\n/);
      for (let index = 0; index < lines.length; index += 1) {
        if (session.results.length >= JC_SEARCH_LIMITS.maxStoredHits) {
          session.truncated = true;
          return;
        }
        const line = lines[index] ?? '';
        if (!matcher.test(line)) continue;
        session.results.push({ path: full, line: index + 1, text: snippet(line) });
      }
    }
  }

  return {
    async start(args, policy) {
      const root = containJcPath(args.path, policy);
      const info = await fs.stat(root);
      if (!info.isDirectory()) throw new IntegrationError('invalid_argument', 'search path must be a directory');
      const mode = args.mode === 'filename' || args.mode === 'content' ? args.mode : undefined;
      if (!mode) throw new IntegrationError('invalid_argument', 'mode must be filename or content');
      const matcher = mode === 'filename' && args.regex !== true
        ? fileFilter(args.pattern, args.caseSensitive)
        : compilePattern(args.pattern, args.regex, args.caseSensitive);
      if (!matcher) throw new IntegrationError('invalid_argument', 'pattern is required');
      const names = fileFilter(args.fileFilter, args.caseSensitive);
      const session: SearchSession = {
        searchId: `srch_${randomBytes(8).toString('hex')}`,
        root,
        mode,
        scanned: 0,
        matched: 0,
        done: false,
        truncated: false,
        cancelled: false,
        delivered: 0,
        results: [],
      };
      sessions.set(session.searchId, session);
      if (sessions.size > 32) {
        const oldest = sessions.keys().next().value;
        if (oldest && oldest !== session.searchId) sessions.delete(oldest);
      }
      await walk(root, session, matcher, names, mode, policy, jcWalkGuard(policy));
      session.matched = session.results.length;
      session.done = !session.cancelled;
      return page(session, pageLimit(args.limit));
    },
    more(args) {
      const id = args.searchId;
      if (typeof id !== 'string') throw new IntegrationError('invalid_argument', 'searchId is required');
      const session = sessions.get(id);
      if (!session) throw new IntegrationError('not_found', 'search not found');
      return page(session, pageLimit(args.limit));
    },
    list() {
      return {
        searches: [...sessions.values()].map((session) => ({
          searchId: session.searchId,
          root: session.root,
          mode: session.mode,
          scanned: session.scanned,
          matched: session.matched,
          done: session.done,
          truncated: session.truncated,
          cancelled: session.cancelled,
        })),
      };
    },
    stop(args) {
      const id = args.searchId;
      if (typeof id !== 'string') throw new IntegrationError('invalid_argument', 'searchId is required');
      const session = sessions.get(id);
      if (!session) throw new IntegrationError('not_found', 'search not found');
      session.cancelled = true;
      session.done = true;
      return { searchId: session.searchId, cancelled: true };
    },
  };
}
