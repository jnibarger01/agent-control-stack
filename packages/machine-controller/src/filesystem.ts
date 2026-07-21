import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { ControlStackError, redactValue } from "@agent-control-stack/shared";
import { z } from "zod";
import type { MachineControllerConfig } from "./config.js";
import { resolveSafePath } from "./path.js";

const listInputSchema = z.object({
  path: z.string().min(1),
  max_depth: z.number().int().min(0).max(5).default(1)
});
const statInputSchema = z.object({ path: z.string().min(1) });
const readInputSchema = z.object({
  path: z.string().min(1),
  start_line: z.number().int().positive().default(1),
  end_line: z.number().int().positive().optional()
});
const searchInputSchema = z.object({
  path: z.string().min(1),
  query: z.string().min(1),
  max_depth: z.number().int().min(0).max(8).default(3),
  limit: z.number().int().positive().max(200).default(50)
});

export function listFiles(config: MachineControllerConfig, input: unknown) {
  const parsed = listInputSchema.parse(input);
  const root = resolveSafePath(config, parsed.path).realPath;
  const entries = walk(config, root, parsed.max_depth, 0).map((path) => describePath(path));
  return { path: root, entries };
}

export function statPath(config: MachineControllerConfig, input: unknown) {
  const parsed = statInputSchema.parse(input);
  return describePath(resolveSafePath(config, parsed.path).realPath);
}

export function readTextFile(config: MachineControllerConfig, input: unknown) {
  const parsed = readInputSchema.parse(input);
  const safe = resolveSafePath(config, parsed.path);
  const stat = statSync(safe.realPath);
  if (!stat.isFile()) {
    throw new ControlStackError("fs_not_file", `path is not a file: ${parsed.path}`);
  }
  if (stat.size > config.security.maxOutputBytes) {
    throw new ControlStackError("fs_too_large", `file exceeds max output bytes: ${parsed.path}`);
  }

  const buffer = readFileSync(safe.realPath);
  if (isBinary(buffer)) {
    throw new ControlStackError("fs_binary_refused", `binary file reads are refused: ${parsed.path}`);
  }

  const lines = buffer.toString("utf8").split(/\r?\n/);
  const start = parsed.start_line;
  const end = parsed.end_line ?? lines.length;
  let redacted = false;
  const selected = lines.slice(start - 1, end).map((line, index) => {
    const original = `${start + index}: ${line}`;
    const safe = redactLine(original);
    redacted ||= safe !== original;
    return safe;
  });
  const text = selected.join("\n");
  return {
    path: safe.realPath,
    startLine: start,
    endLine: Math.min(end, lines.length),
    text,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    byteCount: buffer.byteLength,
    returnedBytes: Buffer.byteLength(text, "utf8"),
    truncated: end < lines.length,
    redacted
  };
}

export function searchNames(config: MachineControllerConfig, input: unknown) {
  const parsed = searchInputSchema.parse(input);
  const root = resolveSafePath(config, parsed.path).realPath;
  const matches: ReturnType<typeof describePath>[] = [];
  for (const path of walk(config, root, parsed.max_depth, 0)) {
    if (basename(path).toLowerCase().includes(parsed.query.toLowerCase())) {
      matches.push(describePath(path));
      if (matches.length >= parsed.limit) break;
    }
  }
  return { path: root, query: parsed.query, matches };
}

function walk(config: MachineControllerConfig, path: string, maxDepth: number, depth: number): string[] {
  try {
    resolveSafePath(config, path);
  } catch {
    return [];
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isDirectory() || depth > maxDepth) {
    return [path];
  }
  const entries = readdirSync(path, { withFileTypes: true })
    .map((entry) => join(path, entry.name))
    .sort((left, right) => left.localeCompare(right));
  if (depth === maxDepth) {
    return entries.filter((entry) => isSafeWalkEntry(config, entry));
  }
  return entries.flatMap((entry) => walk(config, entry, maxDepth, depth + 1));
}

function isSafeWalkEntry(config: MachineControllerConfig, path: string): boolean {
  try {
    resolveSafePath(config, path);
    return true;
  } catch {
    return false;
  }
}

function describePath(path: string) {
  const stat = lstatSync(path);
  return {
    name: basename(path),
    path,
    kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : "other",
    size: stat.size,
    modifiedAt: stat.mtime.toISOString()
  };
}

function isBinary(buffer: Buffer): boolean {
  if (buffer.includes(0)) {
    return true;
  }
  const sample = buffer.subarray(0, Math.min(buffer.length, 512));
  let suspicious = 0;
  for (const byte of sample) {
    if (byte < 7 || (byte > 14 && byte < 32)) {
      suspicious += 1;
    }
  }
  return sample.length > 0 && suspicious / sample.length > 0.3;
}

const lineNumberPrefixPattern = /^(\d+:\s?)(.*)$/;
const envSecretAssignmentPattern = /\b([A-Z0-9_]*(?:SECRET|TOKEN|API_KEY|PASSWORD)[A-Z0-9_]*=)([^\s]+)/gi;
const bearerSecretPattern = /\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*\b/g;
const githubTokenPattern = /\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]+\b/g;
const openAiTokenPattern = /\bsk-[A-Za-z0-9_-]{20,}\b/g;
const credentialUrlPattern = /([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/g;
const privateKeyMarkerPattern = /-----BEGIN [A-Z ]*PRIVATE KEY-----|-----END [A-Z ]*PRIVATE KEY-----/;

function redactLine(line: string): string {
  const match = lineNumberPrefixPattern.exec(line);
  const prefix = match?.[1] ?? "";
  const content = match?.[2] ?? line;
  const redactedContent = redactLineContent(content);

  if (redactedContent !== content) {
    return `${prefix}${redactedContent}`;
  }

  const redacted = redactValue(content);
  return `${prefix}${typeof redacted === "string" ? redacted : String(redacted)}`;
}

function redactLineContent(content: string): string {
  if (privateKeyMarkerPattern.test(content)) {
    return "[redacted]";
  }

  return content
    .replace(envSecretAssignmentPattern, "$1[redacted]")
    .replace(bearerSecretPattern, "$1[redacted]")
    .replace(githubTokenPattern, "[redacted]")
    .replace(openAiTokenPattern, "[redacted]")
    .replace(credentialUrlPattern, "$1[redacted]@");
}
