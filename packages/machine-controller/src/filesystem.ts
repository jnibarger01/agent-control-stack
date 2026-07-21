import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, join } from "node:path";
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
  end_line: z.number().int().positive().optional(),
  offset: z.number().int().default(0),
  length: z.number().int().positive().max(1_000).default(1_000)
});
const searchInputSchema = z.object({
  path: z.string().min(1),
  query: z.string().min(1),
  max_depth: z.number().int().min(0).max(8).default(3),
  limit: z.number().int().positive().max(200).default(50)
});
const multipleReadInputSchema = z.object({
  paths: z.array(z.string().min(1)).min(1).max(100),
  offset: z.number().int().default(0),
  length: z.number().int().positive().max(1_000).default(1_000)
});
const directoryInputSchema = z.object({ path: z.string().min(1) });
const writeInputSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  mode: z.enum(["rewrite", "append"]).default("rewrite")
});
const patchInputSchema = z.object({
  path: z.string().min(1),
  old_string: z.string().min(1),
  new_string: z.string(),
  expected_replacements: z.number().int().positive().max(100).default(1)
});
const moveInputSchema = z.object({
  source: z.string().min(1),
  destination: z.string().min(1),
  overwrite: z.boolean().default(false)
});
const pdfInputSchema = z.object({
  path: z.string().min(1),
  outputPath: z.string().min(1).optional(),
  content: z.string().max(20_000)
});
const searchFilesInputSchema = z.object({
  path: z.string().min(1),
  pattern: z.string().min(1).max(500),
  searchType: z.enum(["files", "content"]).default("files"),
  filePattern: z.string().max(200).optional(),
  ignoreCase: z.boolean().default(true),
  maxResults: z.number().int().positive().max(200).default(100),
  includeHidden: z.boolean().default(false),
  contextLines: z.number().int().min(0).max(20).default(5),
  literalSearch: z.boolean().default(false),
  maxDepth: z.number().int().min(0).max(8).default(3)
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
  const lineCount = lines.length > 1 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
  const start =
    parsed.offset < 0
      ? Math.max(1, lineCount + parsed.offset + 1)
      : parsed.offset !== 0 || parsed.start_line === 1
        ? Math.max(1, parsed.offset + 1)
        : parsed.start_line;
  const end = parsed.end_line ?? Math.min(lineCount, start - 1 + parsed.length);
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
    endLine: Math.min(end, lineCount),
    text,
    contentHash: createHash("sha256").update(text, "utf8").digest("hex"),
    byteCount: buffer.byteLength,
    returnedBytes: Buffer.byteLength(text, "utf8"),
    truncated: end < lineCount,
    redacted
  };
}

export function readMultipleTextFiles(config: MachineControllerConfig, input: unknown) {
  const parsed = multipleReadInputSchema.parse(input);
  return {
    files: parsed.paths.map((path) =>
      readTextFile(config, {
        path,
        offset: parsed.offset,
        length: parsed.length
      })
    )
  };
}

export function createDirectory(config: MachineControllerConfig, input: unknown) {
  const parsed = directoryInputSchema.parse(input);
  const safe = resolveSafePath(config, parsed.path);
  if (existsSync(safe.realPath)) {
    if (!statSync(safe.realPath).isDirectory()) {
      throw new ControlStackError("fs_not_directory", "path is not a directory: " + parsed.path);
    }
    return { path: safe.realPath, created: false };
  }
  mkdirSync(safe.absolutePath, { recursive: true, mode: 0o755 });
  return { path: resolveSafePath(config, safe.absolutePath).realPath, created: true };
}

export function writeTextFile(config: MachineControllerConfig, input: unknown) {
  const parsed = writeInputSchema.parse(input);
  const safe = resolveSafePath(config, parsed.path);
  const existing = existsSync(safe.realPath) ? readFileSync(safe.realPath) : Buffer.from("");
  const content = parsed.mode === "append" ? existing.toString("utf8") + parsed.content : parsed.content;
  assertWriteSize(config, content, parsed.path);
  const mode = existsSync(safe.realPath) ? statSync(safe.realPath).mode & 0o777 : 0o600;
  atomicWrite(safe.absolutePath, Buffer.from(content, "utf8"), mode);
  return {
    path: resolveSafePath(config, safe.absolutePath).realPath,
    mode: parsed.mode,
    byteCount: Buffer.byteLength(content, "utf8"),
    contentHash: createHash("sha256").update(content, "utf8").digest("hex")
  };
}

export function editTextBlock(config: MachineControllerConfig, input: unknown) {
  const parsed = patchInputSchema.parse(input);
  const safe = resolveSafePath(config, parsed.path);
  const fileStat = statSync(safe.realPath);
  if (!fileStat.isFile()) {
    throw new ControlStackError("fs_not_file", "path is not a file: " + parsed.path);
  }
  const current = readFileSync(safe.realPath, "utf8");
  const occurrences = current.split(parsed.old_string).length - 1;
  if (occurrences !== parsed.expected_replacements) {
    throw new ControlStackError(
      "fs_edit_match_count",
      "expected " + parsed.expected_replacements + " replacement(s), found " + occurrences + ": " + parsed.path
    );
  }
  const next = current.split(parsed.old_string).join(parsed.new_string);
  assertWriteSize(config, next, parsed.path);
  atomicWrite(safe.realPath, Buffer.from(next, "utf8"), fileStat.mode & 0o777);
  return {
    path: safe.realPath,
    replacements: occurrences,
    byteCount: Buffer.byteLength(next, "utf8"),
    contentHash: createHash("sha256").update(next, "utf8").digest("hex")
  };
}

export function movePath(config: MachineControllerConfig, input: unknown) {
  const parsed = moveInputSchema.parse(input);
  const source = resolveSafePath(config, parsed.source).realPath;
  const destination = resolveSafePath(config, parsed.destination);
  if (existsSync(destination.realPath) && !parsed.overwrite) {
    throw new ControlStackError("fs_destination_exists", "destination already exists: " + parsed.destination);
  }
  mkdirSync(dirname(destination.absolutePath), { recursive: true });
  renameSync(source, destination.absolutePath);
  return {
    source,
    destination: resolveSafePath(config, destination.absolutePath).realPath,
    overwritten: parsed.overwrite
  };
}

export function writePdfFile(config: MachineControllerConfig, input: unknown) {
  const parsed = pdfInputSchema.parse(input);
  const outputPath = parsed.outputPath ?? parsed.path;
  if (!outputPath.toLowerCase().endsWith(".pdf")) {
    throw new ControlStackError("fs_pdf_extension_required", "PDF output path must end with .pdf");
  }
  if (parsed.outputPath && parsed.outputPath === parsed.path) {
    throw new ControlStackError("fs_pdf_overwrite_refused", "PDF modification requires a distinct outputPath");
  }
  const safe = resolveSafePath(config, outputPath);
  if (!parsed.outputPath && existsSync(safe.realPath)) {
    throw new ControlStackError(
      "fs_pdf_overwrite_refused",
      "existing PDFs are not overwritten; provide a new outputPath"
    );
  }
  const pdf = simplePdf(parsed.content);
  assertWriteSize(config, pdf, outputPath);
  atomicWrite(safe.absolutePath, pdf, 0o600);
  return { path: resolveSafePath(config, safe.absolutePath).realPath, byteCount: pdf.byteLength, format: "pdf" };
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

export function searchFiles(config: MachineControllerConfig, input: unknown) {
  const parsed = searchFilesInputSchema.parse(input);
  const root = resolveSafePath(config, parsed.path).realPath;
  const matcher = createMatcher(parsed.pattern, parsed.ignoreCase, parsed.literalSearch);
  const candidates = walk(config, root, parsed.maxDepth, 0).filter((path) => {
    const name = basename(path);
    return (
      (parsed.includeHidden || !name.startsWith(".")) && (!parsed.filePattern || globMatches(name, parsed.filePattern))
    );
  });
  if (parsed.searchType === "files") {
    return {
      path: root,
      pattern: parsed.pattern,
      searchType: parsed.searchType,
      matches: candidates
        .filter((path) => matcher(basename(path)))
        .slice(0, parsed.maxResults)
        .map(describePath)
    };
  }

  const matches: Array<{ path: string; line: number; text: string }> = [];
  for (const path of candidates) {
    if (matches.length >= parsed.maxResults) break;
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size > config.security.maxOutputBytes) continue;
    const buffer = readFileSync(path);
    if (isBinary(buffer)) continue;
    for (const [index, line] of buffer.toString("utf8").split(/\r?\n/).entries()) {
      if (!matcher(line)) continue;
      const safeLine = redactValue(line);
      matches.push({ path, line: index + 1, text: typeof safeLine === "string" ? safeLine : String(safeLine) });
      if (matches.length >= parsed.maxResults) break;
    }
  }
  return { path: root, pattern: parsed.pattern, searchType: parsed.searchType, matches };
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

function assertWriteSize(config: MachineControllerConfig, content: string | Buffer, path: string): void {
  if (Buffer.byteLength(content, "utf8") > config.security.maxOutputBytes) {
    throw new ControlStackError("fs_write_too_large", "write exceeds max output bytes: " + path);
  }
}

function atomicWrite(path: string, content: Buffer, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = path + ".tmp-" + randomUUID();
  try {
    writeFileSync(temporary, content, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      // Preserve the original failure when cleanup is not possible.
    }
    throw new ControlStackError("fs_write_failed", error instanceof Error ? error.message : "filesystem write failed");
  }
}

function createMatcher(pattern: string, ignoreCase: boolean, literalSearch: boolean): (value: string) => boolean {
  if (literalSearch) {
    const expected = ignoreCase ? pattern.toLowerCase() : pattern;
    return (value) => (ignoreCase ? value.toLowerCase() : value).includes(expected);
  }
  let expression: RegExp;
  try {
    expression = new RegExp(pattern, ignoreCase ? "i" : "");
  } catch (error) {
    throw new ControlStackError(
      "search_pattern_invalid",
      error instanceof Error ? error.message : "search pattern is invalid"
    );
  }
  return (value) => expression.test(value);
}

function globMatches(value: string, pattern: string): boolean {
  const expression = new RegExp("^" + pattern.split("*").map(escapeRegex).join(".*") + "$", "i");
  return expression.test(value);
}

function escapeRegex(value: string): string {
  return value.replace(/[.+?^()|[\]\\]/g, "\\$&").replace(/\$/g, "\\$");
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

function simplePdf(content: string): Buffer {
  const lines = content
    .replace(/\r/g, "")
    .split("\n")
    .flatMap((line) => wrapPdfLine(line, 88));
  const pages: string[][] = [];
  for (let index = 0; index < lines.length || pages.length === 0; index += 45) {
    pages.push(lines.slice(index, index + 45));
  }
  const fontObject = 3 + pages.length * 2;
  const objects: string[] = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [" +
      pages.map((_, index) => String(3 + index * 2) + " 0 R").join(" ") +
      "] /Count " +
      pages.length +
      " >>"
  ];
  for (const [index, page] of pages.entries()) {
    const pageObject = 3 + index * 2;
    const contentObject = pageObject + 1;
    const stream = [
      "BT",
      "/F1 10 Tf",
      "50 760 Td",
      ...page.map((line) => "(" + escapePdf(line) + ") Tj 0 -16 Td"),
      "ET"
    ].join("\n");
    objects.push(
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 " +
        fontObject +
        " 0 R >> >> /Contents " +
        contentObject +
        " 0 R >>"
    );
    objects.push("<< /Length " + Buffer.byteLength(stream, "utf8") + " >>\nstream\n" + stream + "\nendstream");
  }
  objects.push("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>");

  let result = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(result, "utf8"));
    result += String(index + 1) + " 0 obj\n" + object + "\nendobj\n";
  });
  const xrefOffset = Buffer.byteLength(result, "utf8");
  result += "xref\n0 " + String(objects.length + 1) + "\n0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    result += String(offsets[index]).padStart(10, "0") + " 00000 n \n";
  }
  result +=
    "trailer\n<< /Size " + String(objects.length + 1) + " /Root 1 0 R >>\nstartxref\n" + xrefOffset + "\n%%EOF\n";
  return Buffer.from(result, "utf8");
}

function wrapPdfLine(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const chunks: string[] = [];
  for (let index = 0; index < line.length; index += width) {
    chunks.push(line.slice(index, index + width));
  }
  return chunks;
}

function escapePdf(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
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
