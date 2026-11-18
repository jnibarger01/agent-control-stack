#!/usr/bin/env node
/**
 * Build a single-file ACS-governed JC bridge into the native installed release.
 * This bundle is resolved at build time; the installed bridge must not load
 * code or packages from any source checkout or Desktop Commander vendor tree.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const app = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(app, '../..');
await build({
  entryPoints: [path.join(repo, 'apps/dc-mcp-gateway/bridge.js')],
  outfile: path.join(app, 'dist/bridge.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  // The MCP SDK includes CommonJS dependencies that require Node builtins.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  legalComments: 'none',
  logLevel: 'warning',
});
