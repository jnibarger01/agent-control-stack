#!/usr/bin/env node
/** JC-owned document readers on real archives built here (no fixtures from Desktop Commander). */
import assert from 'node:assert/strict';
import PizZip from 'pizzip';
import { readDocumentBytes, docxXmlToText } from '../dist/documents.js';

let passed = 0;
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✓ ${name}`); };

function xlsx() {
  const zip = new PizZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('xl/workbook.xml', '<workbook xmlns:r="r"><sheets><sheet name="Budget &amp; Plan" sheetId="1" r:id="rId1"/><sheet name="Two" sheetId="2" r:id="rId2"/></sheets></workbook>');
  zip.file('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>');
  zip.file('xl/sharedStrings.xml', '<sst><si><t>Item</t></si><si><r><t>Rich </t></r><r><t>text</t></r></si><si><t>a&lt;b</t></si></sst>');
  zip.file('xl/worksheets/sheet1.xml', '<worksheet><sheetData>'
    + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>'
    + '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>42.5</v></c><c r="C2" t="b"><v>1</v></c></row>'
    + '<row r="3"><c r="B3" t="inlineStr"><is><t>inline\tvalue</t></is></c><c r="D3"/></row>'
    + '</sheetData></worksheet>');
  zip.file('xl/worksheets/sheet2.xml', '<worksheet><sheetData><row r="1"><c r="AA1" t="str"><v>far</v></c></row></sheetData></worksheet>');
  return zip.generate({ type: 'nodebuffer' });
}

await test('xlsx: sheets in order, shared/rich/inline strings, numbers, booleans, sparse columns', async () => {
  const doc = await readDocumentBytes('excel', xlsx());
  assert.equal(doc.mimeType, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  const [one, two] = doc.text.split('\n\n');
  assert.deepEqual(one.split('\n'), ['## Sheet: Budget & Plan', 'Item\t\tRich text', 'a<b\t42.5\tTRUE', '\tinline value\t\t']);
  assert.equal(two.split('\n')[0], '## Sheet: Two');
  assert.equal(two.split('\n')[1].split('\t').length, 27);
  assert.equal(two.split('\n')[1].split('\t')[26], 'far');
});

await test('xlsx: a zip without a workbook is refused', async () => {
  const zip = new PizZip();
  zip.file('other.txt', 'x');
  await assert.rejects(readDocumentBytes('excel', zip.generate({ type: 'nodebuffer' })), /not an Excel workbook/);
});

await test('docx: paragraphs, tabs, breaks and entities', async () => {
  const zip = new PizZip();
  zip.file('word/document.xml', '<w:document><w:body><w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:tab/><w:t xml:space="preserve">world &amp; co</w:t></w:r></w:p><w:p><w:r><w:t>line</w:t><w:br/><w:t>two</w:t></w:r></w:p></w:body></w:document>');
  const doc = await readDocumentBytes('docx', zip.generate({ type: 'nodebuffer' }));
  assert.equal(doc.text, 'Hello\tworld & co\nline\ntwo');
  assert.equal(docxXmlToText('<w:p></w:p>'), '');
});

console.log(`\njace-commander documents: ${passed} passed`);
