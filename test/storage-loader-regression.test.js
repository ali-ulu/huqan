'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

describe('storage loader regression', () => {
  it('does not permanently cache better-sqlite3 load failures', (t) => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-storage-loader-'));
    const dbPath = path.join(tempDir, 'memory.db');
    const storageKey = require.resolve('../storage');
    const originalLoad = Module._load;
    let failSqliteLoad = true;

    t.after(() => {
      Module._load = originalLoad;
      delete require.cache[storageKey];
      fs.rmSync(tempDir, { recursive: true, force: true });
    });

    Module._load = function(request, parent, isMain) {
      if (request === 'better-sqlite3' && failSqliteLoad) {
        throw new Error('transient better-sqlite3 load failure');
      }
      return originalLoad.apply(this, arguments);
    };

    delete require.cache[storageKey];
    const AxiomStorage = require('../storage');

    assert.throws(() => {
      new AxiomStorage({ dbPath });
    }, /better-sqlite3 is required for v3 storage/);

    failSqliteLoad = false;

    const storage = new AxiomStorage({ dbPath });
    storage.close();

    assert.ok(fs.existsSync(dbPath));
  });
});
