#!/usr/bin/env node
import assert from 'node:assert/strict';
import { JC_MANIFEST } from '../dist/manifest.generated.js';
import { JC_TOOLS } from '../dist/tool-descriptors.js';
import { JC_TOOL_REGISTRY, getToolByName, getToolRegistry, listToolDescriptors, toolRegistryJson } from '../dist/tool-registry.js';

let passed = 0;
const test = (name, fn) => { fn(); passed += 1; console.log(`  ✓ ${name}`); };

test('registry contains every manifest tool in order with JSON Schema inputSchema', () => {
  assert.equal(JC_TOOL_REGISTRY.length, JC_MANIFEST.tools.length);
  for (let i = 0; i < JC_MANIFEST.tools.length; i += 1) {
    const manifest = JC_MANIFEST.tools[i];
    const entry = JC_TOOL_REGISTRY[i];
    assert.equal(entry.name, manifest.name);
    assert.equal(entry.description, manifest.description);
    assert.deepEqual(entry.inputSchema, manifest.inputSchema);
    assert.equal(entry.inputSchema?.type, 'object');
    assert.deepEqual([...entry.scopes], [...manifest.scopes]);
    assert.equal(entry.requiresApproval, manifest.requiresApproval);
  }
});

test('registry exposes MCP tool descriptors (name, description, inputSchema)', () => {
  const descriptors = listToolDescriptors();
  assert.equal(descriptors.length, JC_TOOLS.length);
  for (const tool of descriptors) {
    assert.equal(typeof tool.name, 'string');
    assert.equal(typeof tool.description, 'string');
    assert.equal(typeof tool.inputSchema, 'object');
  }
});

test('getToolByName returns the registered tool or undefined', () => {
  const sample = JC_MANIFEST.tools[0];
  const found = getToolByName(sample.name);
  assert.ok(found);
  assert.equal(found.name, sample.name);
  assert.equal(getToolByName('no_such_tool'), undefined);
});

test('toolRegistryJson includes manifest version/hash and full registry', () => {
  const json = toolRegistryJson();
  assert.equal(json.version, JC_MANIFEST.version);
  assert.equal(json.manifestHash, JC_MANIFEST.manifestHash);
  assert.equal(json.tools.length, JC_MANIFEST.tools.length);
  assert.equal(getToolRegistry(), JC_TOOL_REGISTRY);
});

console.log(`ok ${passed}`);
