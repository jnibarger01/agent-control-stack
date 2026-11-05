import assert from 'node:assert/strict';
import { toolArgSchemas, ReadFileArgsSchema, WritePdfArgsSchema } from '../dist/tools/schemas.js';
import { toolInputJsonSchema } from '../dist/tools/json-schema.js';
import { McpbManifestSchema } from '@anthropic-ai/mcpb';
import { z } from 'zod';
import { detectUnsupportedParams, getSupportedParams } from '../dist/utils/unsupportedParams.js';
import fs from 'node:fs/promises';

for (const [name, schema] of Object.entries(toolArgSchemas)) {
  const json = toolInputJsonSchema(schema);
  assert.equal(json.type, 'object', `${name} must retain its object input schema`);
  assert.ok(json.properties, `${name} must retain its argument definitions`);
}
const read = toolInputJsonSchema(ReadFileArgsSchema);
assert.deepEqual(detectUnsupportedParams({ path: '/tmp/example', view_range: [1, 2] }, ReadFileArgsSchema), ['view_range']);
for (const schema of [ReadFileArgsSchema.optional(), ReadFileArgsSchema.nullable(), ReadFileArgsSchema.readonly(), ReadFileArgsSchema.transform(value => value)]) {
  assert.ok(getSupportedParams(schema).includes('path'), 'wrapped input schemas must retain supported parameters');
}
assert.ok(read.required.includes('path'));
assert.ok(!read.required.includes('offset'), 'input defaults must stay optional');
assert.equal(ReadFileArgsSchema.parse({ path: '/tmp/example', options: { arbitrary: true } }).offset, 0);
assert.equal(ReadFileArgsSchema.safeParse({ path: 123 }).success, false);
const pdf = toolInputJsonSchema(WritePdfArgsSchema);
assert.ok(pdf.properties.content, 'PDF preprocessing must retain the advertised input');
assert.deepEqual(WritePdfArgsSchema.parse({ path: '/tmp/example.pdf', content: '[{"type":"delete","pageIndexes":[0]}]' }).content,
  [{ type: 'delete', pageIndexes: [0] }]);
const template = (await fs.readFile(new URL('../manifest.template.json', import.meta.url), 'utf8')).replaceAll('{{VERSION}}', '0.2.48');
const manifest = JSON.parse(template);
const checkedManifest = McpbManifestSchema.safeParse(manifest);
assert.ok(checkedManifest.success, JSON.stringify(checkedManifest.error?.issues));
const oversized = z.array(z.string()).max(2).safeParse(Array(10000).fill(123));
assert.equal(oversized.success, false);
assert.equal(oversized.error.issues.length, 1, 'oversized constrained input must stop before per-element errors accumulate');
console.log(`Zod 4 input schemas: ${Object.keys(toolArgSchemas).length} tools verified`);
