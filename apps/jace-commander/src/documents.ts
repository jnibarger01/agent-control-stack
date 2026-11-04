/**
 * Jace Commander document readers (JC-owned; replaces Desktop Commander's
 * file handlers). Every reader takes the BYTES already read through the
 * contained, O_NOFOLLOW descriptor (filesystem.ts), never a path, so a parser
 * cannot be pointed at anything containment did not check.
 *
 *   pdf   unpdf (pdf.js text layer), one entry per page
 *   docx  pizzip + word/document.xml text runs (paragraphs, tabs, breaks)
 *   xlsx  exceljs, one tab-separated section per worksheet
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

async function readExcel(bytes: Buffer): Promise<DocumentText> {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as ArrayBuffer);
  const sections: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[] = [`## Sheet: ${sheet.name}`];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      row.eachCell({ includeEmpty: true }, (cell, column) => {
        cells[column - 1] = String(cell.text ?? '').replace(/[\t\n]/g, ' ');
      });
      rows.push(Array.from(cells, (cell) => cell ?? '').join('\t'));
    });
    sections.push(rows.join('\n'));
  });
  return { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', text: sections.join('\n\n') };
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
