/**
 * Bounded filesystem search (fs.read): start_search, get_more_search_results,
 * list_searches, stop_search.
 *
 * The walk runs in the JC server process. The CLI reaches it only through
 * /jc/mcp, so ACS authorizes the same arguments the walker contains.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { containJcPath, type JcFsPolicy } from './filesystem.js';
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

  async function walk(dir: string, session: SearchSession, matcher: RegExp, names: RegExp | undefined, mode: 'filename' | 'content'): Promise<void> {
    if (session.cancelled || session.results.length >= JC_SEARCH_LIMITS.maxStoredHits || session.scanned >= JC_SEARCH_LIMITS.maxFilesScanned) {
      session.truncated = session.results.length >= JC_SEARCH_LIMITS.maxStoredHits || session.scanned >= JC_SEARCH_LIMITS.maxFilesScanned;
      return;
    }
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (session.cancelled || session.results.length >= JC_SEARCH_LIMITS.maxStoredHits || session.scanned >= JC_SEARCH_LIMITS.maxFilesScanned) {
        session.truncated = true;
        return;
      }
      if (SKIP_DIRS.has(entry.name) || entry.isSymbolicLink()) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, session, matcher, names, mode);
        continue;
      }
      if (!entry.isFile()) continue;
      session.scanned += 1;
      if (names && !names.test(entry.name)) continue;
      if (mode === 'filename') {
        if (matcher.test(entry.name)) session.results.push({ path: full });
        continue;
      }
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      if (stat.size > JC_SEARCH_LIMITS.maxFileBytes) continue;
      let text: string;
      try {
        text = await fs.readFile(full, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
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
      await walk(root, session, matcher, names, mode);
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
