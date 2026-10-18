'use strict';

// ADR-018 §2 (#3998): the protected store's layout. The workspace id, the
// directory shape, and the marker read that decides whether the protected store
// is selected. The resolution files that consume this are pinned by
// protected-store-resolution.test.js.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  MARKER_VERSION,
  WORKSPACE_ID_LENGTH,
  deriveWorkspaceId,
  migrationMarkerPath,
  protectedMemoryDbPath,
  protectedMemoryJsonPath,
  protectedStateRoot,
  readMigrationMarker,
  resolveProtectedStore,
  workspaceStoreDir,
} = require('../lib/protected-store-path');

function tempDir(t, prefix = 'huqan-store-path-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('workspace id derivation (ADR-018 §2)', () => {
  it('is the first 16 hex characters of sha256(lowercased canonical realpath)', (t) => {
    // Use a real directory: the id hashes the *canonical realpath*, so a
    // hand-written POSIX string would be hashed verbatim on POSIX but resolved
    // against the current drive on Windows, and the two would disagree.
    const dir = tempDir(t);
    const id = deriveWorkspaceId(dir);
    assert.equal(id.length, WORKSPACE_ID_LENGTH);
    assert.match(id, /^[0-9a-f]{16}$/);
    const crypto = require('node:crypto');
    const expected = crypto.createHash('sha256').update(fs.realpathSync.native(dir).toLowerCase()).digest('hex').slice(0, 16);
    assert.equal(id, expected);
  });

  it('folds case, so two spellings of one directory share a store', () => {
    assert.equal(deriveWorkspaceId('/Srv/HUQAN/Work'), deriveWorkspaceId('/srv/huqan/work'));
  });

  it('resolves a symlinked path to the same id as its target', (t) => {
    const real = tempDir(t);
    const link = path.join(os.tmpdir(), `huqan-link-${process.pid}-${Date.now()}`);
    try {
      fs.symlinkSync(real, link, 'dir');
    } catch (_) {
      t.skip('symlinks are unavailable here');
      return;
    }
    t.after(() => fs.rmSync(link, { force: true }));
    assert.equal(deriveWorkspaceId(link), deriveWorkspaceId(real));
  });
});

describe('the protected root and the per-workspace layout', () => {
  it('names C:\\ProgramData\\huqan\\state on Windows', () => {
    assert.equal(
      protectedStateRoot({ ProgramData: 'C:\\ProgramData' }, 'win32'),
      'C:\\ProgramData\\huqan\\state',
    );
  });

  it('names a fixed POSIX root elsewhere', () => {
    assert.equal(protectedStateRoot({}, 'linux'), path.join('/var', 'lib', 'huqan', 'state'));
  });

  it('honours the explicit override in every platform', () => {
    const override = { HUQAN_PROTECTED_STATE_ROOT: '/tmp/somewhere' };
    assert.equal(protectedStateRoot(override, 'win32'), path.resolve('/tmp/somewhere'));
    assert.equal(protectedStateRoot(override, 'linux'), path.resolve('/tmp/somewhere'));
  });

  it('places memory.db and memory.json under workspaces/<id>/', () => {
    // path.resolve, not the raw string: on Windows the root gains a drive letter,
    // and the layout functions resolve it, so the expected value must too.
    const root = path.resolve('/srv/state');
    const id = deriveWorkspaceId('/srv/workspace');
    assert.equal(protectedMemoryDbPath('/srv/workspace', root), path.join(root, 'workspaces', id, 'memory.db'));
    assert.equal(protectedMemoryJsonPath('/srv/workspace', root), path.join(root, 'workspaces', id, 'memory.json'));
    assert.equal(migrationMarkerPath('/srv/workspace', root), path.join(root, 'workspaces', id, 'migrated.json'));
    assert.equal(workspaceStoreDir('/srv/workspace', root), path.join(root, 'workspaces', id));
  });
});

describe('the migration marker decides selection', () => {
  const WORKSPACE = '/srv/workspace';
  const ROOT = '/srv/state';
  const MARKER_PATH = migrationMarkerPath(WORKSPACE, ROOT);
  const GOOD = JSON.stringify({ v: MARKER_VERSION, workspaceId: 'abc', dbSha256: 'a'.repeat(64) });

  it('no marker means the protected store is not selected', () => {
    const selection = resolveProtectedStore({ workspaceRoot: WORKSPACE, stateRoot: ROOT, readFile: () => { throw Object.assign(new Error('x'), { code: 'ENOENT' }); } });
    assert.deepEqual([selection.selected, selection.reason], [false, 'no_marker']);
  });

  it('a well-formed marker selects the protected store', () => {
    const selection = resolveProtectedStore({ workspaceRoot: WORKSPACE, stateRoot: ROOT, readFile: () => GOOD });
    assert.equal(selection.selected, true);
    assert.equal(selection.memoryPath, protectedMemoryJsonPath(WORKSPACE, ROOT));
    assert.equal(selection.dbPath, protectedMemoryDbPath(WORKSPACE, ROOT));
    assert.equal(selection.markerPath, MARKER_PATH);
  });

  it('a malformed or wrong-version marker is not selection', () => {
    for (const text of ['{', 'null', '[]', JSON.stringify({ v: 'other', workspaceId: 'a', dbSha256: 'b'.repeat(64) }),
      JSON.stringify({ v: MARKER_VERSION, workspaceId: 'a' }),
      JSON.stringify({ v: MARKER_VERSION, workspaceId: 'a', dbSha256: 'short' })]) {
      const selection = resolveProtectedStore({ workspaceRoot: WORKSPACE, stateRoot: ROOT, readFile: () => text });
      assert.deepEqual([selection.selected, selection.reason], [false, 'marker_malformed'], text.slice(0, 24));
    }
  });

  it('an unreadable marker that is not ENOENT fails closed, not open', () => {
    const read = readMigrationMarker(MARKER_PATH, () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); });
    assert.equal(read.reason, 'marker_unreadable');
  });
});
