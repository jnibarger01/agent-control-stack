/**
 * Jace Commander document readers (JC-owned; replaces Desktop Commander's
 * file handlers). Every reader takes the BYTES already read through the
 * contained, O_NOFOLLOW descriptor (filesystem.ts), never a path, so a parser
 * cannot be pointed at anything containment did not check.
 *
 *   pdf   unpdf (pdf.js text layer), one entry per page
 *   docx  pizzip + word/document.xml text runs (paragraphs, tabs, breaks)
 *   xlsx  pizzip + xl/workbook.xml, sharedStrings and sheet XML (read-only;
 *         raw cell values), one tab-separated section per worksheet
 *
 * Output is plain text windowed by lines (offset/length), like text files.
 */
import path from 'node:path';

export type DocumentKind = 'pdf' | 'docx' | 'excel';

export function documentKind(file: string): DocumentKind | undefined {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.docx') return 'docx';
  if (ext === '.xlsx' || ext === '.xlsm') return 'excel';
  return undefined;
}

export interface DocumentText {
  mimeType: string;
  text: string;
  totalPages?: number;
  pages?: number[];
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|[a-z]+);/g, (whole, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
    return XML_ENTITIES[entity] ?? whole;
  });
}

/** Text of word/document.xml: one line per paragraph. */
export function docxXmlToText(xml: string): string {
  const body = xml.replace(/<w:tab\/>/g, '<w:t>\t</w:t>').replace(/<w:(?:br|cr)\/>/g, '<w:t>\n</w:t>');
  const paragraphs = body.split(/<\/w:p>/);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    const runs = [...paragraph.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((match) => decodeXml(match[1] ?? ''));
    if (runs.length > 0) lines.push(runs.join(''));
  }
  return lines.join('\n');
}

async function readPdf(bytes: Buffer): Promise<DocumentText> {
  const { getDocumentProxy, extractText } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { totalPages, text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map((pageText, index) => ({ pageNumber: index + 1, text: pageText }));
  return {
    mimeType: 'application/pdf',
    text: pages.map((page) => `<!-- page ${page.pageNumber} -->\n${page.text}`).join('\n\n'),
    totalPages,
    pages: pages.map((page) => page.pageNumber),
  };
}

async function readDocx(bytes: Buffer): Promise<DocumentText> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(bytes);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('not a Word document (word/document.xml missing)');
  return {
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    text: docxXmlToText(entry.asText()),
  };
}

const MAX_SHEET_CELLS = 200_000;

/** Concatenated text of every <t> run inside one shared-string / inline-string element. */
function runText(xml: string): string {
  return [...xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)].map((match) => decodeXml(match[1] ?? '')).join('');
}

/** "AB12" -> 27 (zero-based column index). */
function columnIndex(reference: string): number {
  const letters = /^([A-Z]+)/.exec(reference)?.[1] ?? 'A';
  let index = 0;
  for (const letter of letters) index = index * 26 + (letter.charCodeAt(0) - 64);
  return index - 1;
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
}

/** Text of an .xlsx workbook: one tab-separated section per sheet (raw cell values; no number formats). */
export function xlsxEntriesToText(entries: { workbook: string; rels: string; sharedStrings?: string; sheet(target: string): string | undefined }): string {
  const shared = entries.sharedStrings
    ? [...entries.sharedStrings.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)].map((match) => runText(match[1] ?? ''))
    : [];
  const targets = new Map<string, string>();
  for (const match of entries.rels.matchAll(/<Relationship\s[^>]*>/g)) {
    const id = attribute(match[0], 'Id');
    const target = attribute(match[0], 'Target');
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, ''));
  }
  const sections: string[] = [];
  let cellCount = 0;
  for (const match of entries.workbook.matchAll(/<sheet\s[^>]*\/?>/g)) {
    const name = decodeXml(attribute(match[0], 'name') ?? 'Sheet');
    const relId = attribute(match[0], 'r:id');
    const xml = relId && targets.has(relId) ? entries.sheet(targets.get(relId)!) : undefined;
    const rows: string[] = [`## Sheet: ${name}`];
    for (const row of (xml ?? '').matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
      const cells: string[] = [];
      for (const cell of (row[1] ?? '').matchAll(/<c(\s[^>]*?)?(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        if (++cellCount > MAX_SHEET_CELLS) throw new Error(`spreadsheet has more than ${MAX_SHEET_CELLS} cells`);
        const tag = cell[1] ?? '';
        const body = cell[2] ?? '';
        const type = attribute(tag, 't');
        const raw = decodeXml(/<v>([\s\S]*?)<\/v>/.exec(body)?.[1] ?? '');
        const value = type === 's' ? shared[Number(raw)] ?? ''
          : type === 'inlineStr' ? runText(body)
            : type === 'b' ? (raw === '1' ? 'TRUE' : 'FALSE')
              : raw;
        cells[columnIndex(attribute(tag, 'r') ?? `A${cells.length + 1}`)] = value.replace(/[\t\n]/g, ' ');
      }
      if (cells.length > 0) rows.push(Array.from(cells, (cell) => cell ?? '').join('\t'));
    }
    sections.push(rows.join('\n'));
  }
  return sections.join('\n\n');
}

async function readExcel(bytes: Buffer): Promise<DocumentText> {
  const { default: PizZip } = await import('pizzip');
  const zip = new PizZip(bytes);
  const text = (name: string) => zip.file(name)?.asText();
  const workbook = text('xl/workbook.xml');
  const rels = text('xl/_rels/workbook.xml.rels');
  if (!workbook || !rels) throw new Error('not an Excel workbook (xl/workbook.xml missing)');
  return {
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    text: xlsxEntriesToText({ workbook, rels, sharedStrings: text('xl/sharedStrings.xml'), sheet: (target) => text(`xl/${target}`) }),
  };
}

export async function readDocumentBytes(kind: DocumentKind, bytes: Buffer): Promise<DocumentText> {
  if (kind === 'pdf') return readPdf(bytes);
  if (kind === 'docx') return readDocx(bytes);
  return readExcel(bytes);
}

/** Lines [offset, offset + length) of `text` (PDF output keeps all pages). */
export function windowLines(text: string, offset: number, length: number): string {
  const lines = text.split('\n');
  return lines.slice(Math.max(0, offset), Math.max(0, offset) + length).join('\n');
}
