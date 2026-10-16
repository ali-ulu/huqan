'use strict';

/**
 * #3925: several processes opening the same fresh database file at once must
 * not race the additive-column migration into "duplicate column name".
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const CHILD = `
const Database = require('better-sqlite3');
const { applyStorageSchema } = require(process.argv[2]);
const db = new Database(process.argv[1]);
try { applyStorageSchema(db); } finally { db.close(); }
`;

function openInChild(dbPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['-e', CHILD, dbPath, path.join(ROOT, 'lib/storage/schema.js')], { cwd: ROOT });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => resolve({ code, stderr }));
  });
}

test('parallel first open of a fresh database never fails the column migration', async () => {
  for (let round = 0; round < 4; round += 1) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-3925-'));
    try {
      const results = await Promise.all(
        Array.from({ length: 12 }, () => openInChild(path.join(dir, 'fresh.db'))),
      );
      for (const result of results) {
        assert.equal(result.code, 0, result.stderr);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
});
