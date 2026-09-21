'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const HuqanStorage = require('../../storage');
const { tempDir } = require('./helpers');

test('corrupt memory.db fails closed and is not silently replaced', (t) => {
  const root = tempDir(t, 'huqan-fault-corrupt-db-');
  const dbPath = path.join(root, 'memory.db');
  const memoryPath = path.join(root, 'memory.json');
  const corrupt = Buffer.alloc(4096, 0x5a);
  fs.writeFileSync(dbPath, corrupt);

  assert.throws(
    () => new HuqanStorage({ dbPath, memoryPath }),
    (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /database|sqlite/i);
      return true;
    },
  );

  assert.deepEqual(fs.readFileSync(dbPath), corrupt);
  assert.notEqual(fs.readFileSync(dbPath).subarray(0, 16).toString('utf8'), 'SQLite format 3\u0000');
});
