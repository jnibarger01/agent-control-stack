// Stand-in for the dist/index.js MCP child spawned by the remote device.
// Usage: node remote-startup-child.js <ok|lease-refused|other-error|silent-exit|flood>
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

const mode = process.argv[2];

if (mode === 'ok') {
  process.stderr.write('fixture child: starting normally\n');
  const server = new Server({ name: 'fixture-child', version: '1.0.0' }, { capabilities: { tools: {} } });
  await server.connect(new StdioServerTransport());
} else if (mode === 'lease-refused') {
  process.stderr.write('some earlier startup log line\n');
  process.stderr.write('[executor-lease] REFUSED to start: canonical executor lease is held (blocked by: pid:338091). Only one Desktop Commander executor may run. Set DC_DISABLE_EXECUTOR_LEASE=1 to explicitly bypass.\n');
  process.exit(1);
} else if (mode === 'other-error') {
  process.stderr.write('[31mError: Cannot find module \'/nonexistent/dep.js\'[0m\n');
  process.exit(3);
} else if (mode === 'silent-exit') {
  process.exit(2);
} else if (mode === 'flood') {
  const line = 'x'.repeat(1023) + '\n';
  for (let i = 0; i < 1024; i++) process.stderr.write(line); // ~1 MiB
  process.stderr.write('fatal: final line before exit\n', () => process.exit(4));
} else {
  process.stderr.write(`unknown fixture mode: ${mode}\n`);
  process.exit(64);
}
