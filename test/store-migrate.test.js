'use strict';

// ADR-018 §2 (#3998): `huqan store migrate` copies, verifies, then marks.
//
// The acceptance criteria pinned here:
//   - a non-elevated run refuses, and changes nothing;
//   - a failed verification writes NO marker and leaves the profile store
//     authoritative;
//   - the profile original is never deleted (it is the backup);
//   - --rollback removes the marker and keeps the protected copy;
//   - memory.json absent is recorded as "absent", not treated as an error.
//
// These tests drive the real copy/verify path over a real (tiny) SQLite file.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isProcessElevated,
  migrateStore,
  rollbackStore,
  tableRowCounts,
  verifyCopy,
  verifyMigrationMarker,
} = require('../lib/authority/store-migrate');
const {
  MARKER_VERSION,
  migrationMarkerPath,
  protectedMemoryDbPath,
  protectedMemoryJsonPath,
} = require('../lib/protected-store-path');

let Database;
try { Database = require('better-sqlite3'); } catch (_) { Database = null; }

function tempDir(t, prefix = 'huqan-migrate-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A minimal real SQLite store, or null when better-sqlite3 is unavailable. */
function writeStore(dir, { rows = 3, json = null } = {}) {
  const dbPath = path.join(dir, 'memory.db');
  if (Database) {
    const db = new Database(dbPath);
    db.exec('CREATE TABLE nodes (id TEXT PRIMARY KEY, payload TEXT)');
    db.exec('CREATE TABLE edges (id TEXT PRIMARY KEY)');
    const insert = db.prepare('INSERT INTO nodes (id, payload) VALUES (?, ?)');
    for (let i = 0; i < rows; i += 1) insert.run(`n${i}`, `p${i}`);
    db.close();
  } else {
    fs.writeFileSync(dbPath, Buffer.from('not-a-real-database'));
  }
  if (json !== null) fs.writeFileSync(path.join(dir, 'memory.json'), JSON.stringify(json));
  return dbPath;
}

const GRAPH_JSON = { nodes: { a: { id: 'a' }, b: { id: 'b' } }, edges: [{ from: 'a', to: 'b', relation: 'r' }] };

describe('migration refuses without elevation (ADR-018 §2)', () => {
  it('a non-elevated migrate changes nothing', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source);
    const result = migrateStore({ workspaceRoot: workspace, sourceDir: source, stateRoot, isElevated: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'STORE_MIGRATE_NOT_ELEVATED');
    assert.equal(fs.existsSync(migrationMarkerPath(workspace, stateRoot)), false, 'no marker on refusal');
    assert.equal(fs.existsSync(protectedMemoryDbPath(workspace, stateRoot)), false, 'no copy on refusal');
  });

  it('a non-elevated rollback refuses', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const result = rollbackStore({ workspaceRoot: workspace, stateRoot, isElevated: false });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'STORE_MIGRATE_NOT_ELEVATED');
  });
});

describe('elevation probe', () => {
  it('on POSIX it reads the effective uid', () => {
    const elevated = isProcessElevated({ platform: 'linux' });
    assert.equal(elevated, typeof process.geteuid === 'function' && process.geteuid() === 0);
  });

  it('on Windows it looks for High or System integrity in whoami /groups', () => {
    const high = isProcessElevated({ platform: 'win32', spawn: () => ({ status: 0, stdout: 'Mandatory Label\\High Mandatory Level  S-1-16-12288' }) });
    assert.equal(high, true);
    const system = isProcessElevated({ platform: 'win32', spawn: () => ({ status: 0, stdout: 'S-1-16-16384' }) });
    assert.equal(system, true);
    const medium = isProcessElevated({ platform: 'win32', spawn: () => ({ status: 0, stdout: 'S-1-16-8192 Medium' }) });
    assert.equal(medium, false, 'medium integrity is not elevated');
  });

  it('a probe that cannot run is not elevated', () => {
    assert.equal(isProcessElevated({ platform: 'win32', spawn: () => ({ error: new Error('x') }) }), false);
    assert.equal(isProcessElevated({ platform: 'win32', spawn: () => ({ status: 1, stdout: '' }) }), false);
  });
});

describe('a verified migration writes the marker (ADR-018 §2)', () => {
  it('copies db and json, verifies, marks, and leaves the profile original', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    const sourceDb = writeStore(source, { rows: 5, json: GRAPH_JSON });

    const result = migrateStore({ workspaceRoot: workspace, sourceDir: source, stateRoot, isElevated: true, applyAcl: () => ({ applied: true }) });
    assert.equal(result.ok, true, JSON.stringify(result));
    const marker = JSON.parse(fs.readFileSync(migrationMarkerPath(workspace, stateRoot), 'utf8'));
    assert.equal(marker.v, MARKER_VERSION);
    assert.equal(marker.memoryJson.present, true);
    assert.deepEqual(marker.memoryJson.counts, { nodes: 2, edges: 1 });
    assert.equal(marker.dbTables.nodes, 5);
    assert.equal(fs.existsSync(sourceDb), true, 'the profile original is the backup and stays');
    assert.equal(fs.existsSync(protectedMemoryDbPath(workspace, stateRoot)), true);
    assert.deepEqual(
      fs.readFileSync(protectedMemoryDbPath(workspace, stateRoot)),
      fs.readFileSync(sourceDb),
      'the protected copy is byte-identical to the profile store',
    );
  });

  it('records an absent memory.json as absent, not as an error', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 2 });
    const result = migrateStore({ workspaceRoot: workspace, sourceDir: source, stateRoot, isElevated: true, applyAcl: () => ({ applied: true }) });
    assert.equal(result.ok, true);
    assert.deepEqual(result.marker.memoryJson, { present: false, status: 'absent' });
  });

  it('refuses when the profile store has no database', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    const result = migrateStore({ workspaceRoot: workspace, sourceDir: source, stateRoot, isElevated: true, applyAcl: () => ({ applied: true }) });
    assert.deepEqual([result.ok, result.reason], [false, 'SOURCE_DB_ABSENT']);
    assert.equal(fs.existsSync(migrationMarkerPath(workspace, stateRoot)), false);
  });

  it('applies the ACL to the state root and the workspaces subtree, not the per-workspace dir', (t) => {
    // ADR-018 §3: the state root gets SYSTEM+Administrators full, the workspaces
    // subtree additionally the runtime service's Modify. Passing the per-workspace
    // directory as the state root would ACL the wrong tree and leave the root open.
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 2 });
    const seen = [];
    migrateStore({
      workspaceRoot: workspace,
      sourceDir: source,
      stateRoot,
      isElevated: true,
      applyAcl: (target) => { seen.push(target); return { applied: true }; },
    });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].stateDir, path.resolve(stateRoot));
    assert.equal(seen[0].workspacesDir, path.join(path.resolve(stateRoot), 'workspaces'));
  });

  it('a refused ACL fails the migration and writes no marker', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 2 });
    const result = migrateStore({
      workspaceRoot: workspace,
      sourceDir: source,
      stateRoot,
      isElevated: true,
      applyAcl: () => ({ applied: false, reason: 'acl_apply_failed' }),
    });
    assert.deepEqual([result.ok, result.reason, result.detail], [false, 'ACL_APPLY_FAILED', 'acl_apply_failed']);
    assert.equal(fs.existsSync(migrationMarkerPath(workspace, stateRoot)), false);
  });

  it('a platform with no ACL branch is skipped, not treated as a failure', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 2 });
    const result = migrateStore({
      workspaceRoot: workspace,
      sourceDir: source,
      stateRoot,
      isElevated: true,
      applyAcl: () => ({ applied: false, reason: 'unsupported_platform' }),
    });
    assert.equal(result.ok, true, JSON.stringify(result));
  });
});

describe('a failed verification writes NO marker (acceptance criterion)', () => {
  it('a db hash mismatch refuses and leaves the profile store authoritative', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 3 });
    // Corrupt the copy after it is written but before verification: the injected
    // copyFile writes different bytes than the source.
    const result = migrateStore({
      workspaceRoot: workspace,
      sourceDir: source,
      stateRoot,
      isElevated: true,
      applyAcl: () => ({ applied: true }),
      copyFile: (from, to) => fs.writeFileSync(to, Buffer.from('tampered')),
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'VERIFY_FAILED');
    assert.equal(result.detail, 'db_hash_mismatch');
    assert.equal(fs.existsSync(migrationMarkerPath(workspace, stateRoot)), false, 'no marker on failed verification');
  });

  it('a json hash mismatch refuses and writes no marker', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 3, json: GRAPH_JSON });
    const result = migrateStore({
      workspaceRoot: workspace,
      sourceDir: source,
      stateRoot,
      isElevated: true,
      applyAcl: () => ({ applied: true }),
      copyFile: (from, to) => {
        if (to.endsWith('memory.json')) fs.writeFileSync(to, JSON.stringify({ nodes: {}, edges: [] }));
        else fs.copyFileSync(from, to);
      },
    });
    assert.deepEqual([result.ok, result.reason, result.detail], [false, 'VERIFY_FAILED', 'json_hash_mismatch']);
    assert.equal(fs.existsSync(migrationMarkerPath(workspace, stateRoot)), false);
  });

  it('a row-count mismatch is refused even when the byte hashes match', () => {
    // Same bytes on both sides, but the injected opener reports different table
    // counts: the count check must fail the copy on its own, independent of the
    // hash check. This is the one case a byte comparison cannot see (a copy that
    // stopped mid-write can share a prefix), so it is pinned directly.
    let opened = 0;
    const open = () => {
      opened += 1;
      const isTarget = opened === 2;
      return {
        prepare: (sql) => (sql.includes('sqlite_master')
          ? { all: () => [{ name: 'nodes' }] }
          : { get: () => ({ n: isTarget ? 2 : 3 }) }),
        close: () => {},
      };
    };
    const verified = verifyCopy({
      sourceDb: '/s', targetDb: '/t', sourceJson: null, targetJson: null,
      readFile: () => Buffer.from('identical'),
      open,
    });
    assert.deepEqual([verified.ok, verified.reason], [false, 'db_row_mismatch']);
  });
});

describe('rollback removes the marker and keeps the copy (ADR-018 §2)', () => {
  it('reverses the switch without deleting the protected copy', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 2, json: GRAPH_JSON });
    assert.equal(migrateStore({ workspaceRoot: workspace, sourceDir: source, stateRoot, isElevated: true, applyAcl: () => ({ applied: true }) }).ok, true);
    const result = rollbackStore({ workspaceRoot: workspace, stateRoot, isElevated: true });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(migrationMarkerPath(workspace, stateRoot)), false);
    assert.equal(fs.existsSync(protectedMemoryDbPath(workspace, stateRoot)), true, 'the protected copy is kept');
  });

  it('rollback of a never-migrated workspace is a no-op, not an error', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const result = rollbackStore({ workspaceRoot: workspace, stateRoot, isElevated: true });
    assert.deepEqual([result.ok, result.alreadyRolledBack], [true, true]);
  });
});

describe('verifyMigrationMarker re-reads the copy (check (c))', () => {
  it('verifies a freshly written marker, then fails once the copy is truncated', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const source = tempDir(t);
    writeStore(source, { rows: 4, json: GRAPH_JSON });
    assert.equal(migrateStore({ workspaceRoot: workspace, sourceDir: source, stateRoot, isElevated: true, applyAcl: () => ({ applied: true }) }).ok, true);
    assert.equal(verifyMigrationMarker({ workspaceRoot: workspace, stateRoot }).ok, true);
    fs.writeFileSync(protectedMemoryDbPath(workspace, stateRoot), Buffer.from('truncated'));
    const after = verifyMigrationMarker({ workspaceRoot: workspace, stateRoot });
    assert.deepEqual([after.ok, after.reason], [false, 'copy_hash_mismatch']);
  });

  it('an absent marker is not verified', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    assert.deepEqual(verifyMigrationMarker({ workspaceRoot: workspace, stateRoot }), { ok: false, reason: 'no_marker' });
  });
});

describe('tableRowCounts reads the schema', () => {
  it('counts rows per table', (t) => {
    if (!Database) return t.skip('better-sqlite3 unavailable');
    const dir = tempDir(t);
    const dbPath = writeStore(dir, { rows: 7 });
    assert.deepEqual(tableRowCounts(dbPath), { nodes: 7, edges: 0 });
  });
});
