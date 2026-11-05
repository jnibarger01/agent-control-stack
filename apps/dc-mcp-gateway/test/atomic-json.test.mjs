import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { saveJson } from '../atomic-json.js';

test('atomic JSON persistence completes repeated short writes, including multibyte text', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-atomic-json-'));
  try {
    const file = path.join(dir, 'tokens.json');
    fs.writeFileSync(file, '{"old":true}', { mode: 0o644 });
    const data = { client: 'café', records: Array.from({ length: 30 }, (_, n) => ({ n })) };
    let writes = 0;
    saveJson(file, data, {
      ...fs,
      writeSync(fd, buffer, offset, length) {
        writes += 1;
        return fs.writeSync(fd, buffer, offset, Math.min(length, 7));
      },
      renameSync(from, to) {
        assert.deepEqual(JSON.parse(fs.readFileSync(from, 'utf8')), data, 'complete JSON before rename');
        assert.equal(fs.readFileSync(to, 'utf8'), '{"old":true}', 'old state survives until rename');
        fs.renameSync(from, to);
      }
    });
    assert.ok(writes > 1);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), data);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(dir), ['tokens.json']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

for (const failure of ['zero-progress', 'ENOSPC']) {
  test(`atomic JSON persistence preserves the old file and removes partial secrets on ${failure}`, () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acs-atomic-json-'));
    try {
      const file = path.join(dir, 'tokens.json');
      fs.writeFileSync(file, '{"old":true}');
      let writes = 0;
      assert.throws(() => saveJson(file, { replacement: 'new-data' }, {
        ...fs,
        writeSync(fd, buffer, offset, length) {
          if (writes++ === 0) return fs.writeSync(fd, buffer, offset, Math.min(length, 3));
          if (failure === 'zero-progress') return 0;
          throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
        },
        renameSync() { assert.fail('must never publish partial JSON'); }
      }), failure === 'zero-progress' ? /no progress/ : /disk full/);
      assert.equal(fs.readFileSync(file, 'utf8'), '{"old":true}');
      assert.deepEqual(fs.readdirSync(dir), ['tokens.json']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}
