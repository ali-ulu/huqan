'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  REBUILD_OPT_IN_VARIABLE,
  STORE_CREATION_REFUSED_CODE,
  assertStoreCreationAllowed,
  isEphemeralStorePath,
  readKnownStores,
  recordKnownStore,
  registryPath,
} = require('../lib/store-creation-guard');

/**
 * The guard exempts the test runner, because the runner already redirects the
 * implicit default into a per-run temporary root. Every case below therefore
 * has to state which side of that exemption it is testing, and the ones about
 * the refusal itself pass `environment` with the runner marker cleared.
 */
function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-store-guard-'));
  return {
    root,
    // A state root of its own, so the suite never reads or writes the
    // operator's real store registry.
    environment: { HUQAN_STATE_ROOT: root, NODE_TEST_CONTEXT: '' },
    // Deliberately NOT under os.tmpdir(): a temp path is exempt as a throwaway,
    // so a refusal case has to name a path that looks like a store somebody
    // keeps. Nothing is created here -- the guard only reads the string.
    dbPath: path.join(root, 'kept', 'memory.db').replace(path.resolve(os.tmpdir()), path.join(os.homedir(), 'huqan-guard-test')),
    // The throwaway shape, for the one case that is about the exemption.
    ephemeralDbPath: path.join(root, 'memory.db'),
    cleanup() { fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** The thrown error itself, which is what these assertions are about. */
function captureThrow(run) {
  try {
    run();
  } catch (error) {
    return error;
  }
  assert.fail('expected the guard to refuse');
}

/**
 * The runner marker lives in process.env, and isTestRunner() reads it there
 * rather than from an injected environment, so a test about the refusal has to
 * clear it for the duration of the assertion.
 */
function withoutRunnerMarker(run) {
  const saved = process.env.NODE_TEST_CONTEXT;
  delete process.env.NODE_TEST_CONTEXT;
  try { return run(); } finally {
    if (saved !== undefined) process.env.NODE_TEST_CONTEXT = saved;
  }
}

/**
 * The guard only refuses once this machine is known to keep a store somewhere,
 * so every refusal case needs one registered first. A fresh machine is the
 * first-run case and has its own test below.
 */
function withRegisteredStore(box, storePath = path.join(box.root, 'real', 'memory.db')) {
  fs.mkdirSync(path.dirname(registryPath(box.environment)), { recursive: true });
  fs.writeFileSync(registryPath(box.environment), JSON.stringify([storePath]));
  return storePath;
}

test('creates the first store on a machine that has none', () => {
  const box = sandbox();
  try {
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: false,
      environment: box.environment,
    }));
    // And registers it, so the next implicit creation is the one refused.
    assert.deepEqual(readKnownStores(box.environment), [box.dbPath]);
  } finally { box.cleanup(); }
});

test('refuses a second store at a path nobody named', () => {
  const box = sandbox();
  try {
    withRegisteredStore(box);
    const error = withoutRunnerMarker(() => captureThrow(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: false,
      environment: box.environment,
    })));
    assert.equal(error.code, STORE_CREATION_REFUSED_CODE);
    assert.match(error.message, /refusing to create a new store/);
  } finally { box.cleanup(); }
});

test('allows a named path to create its store', () => {
  const box = sandbox();
  try {
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: true,
      exists: false,
      environment: box.environment,
    }));
  } finally { box.cleanup(); }
});

test('allows an unnamed path when the store is already there', () => {
  const box = sandbox();
  try {
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: true,
      environment: box.environment,
    }));
  } finally { box.cleanup(); }
});

test('rebuild opt-in is the way through', () => {
  const box = sandbox();
  try {
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: false,
      environment: { ...box.environment, [REBUILD_OPT_IN_VARIABLE]: '1' },
    }));
  } finally { box.cleanup(); }
});

test('the refusal names the stores this machine already knows', () => {
  const box = sandbox();
  try {
    const known = withRegisteredStore(box);

    const error = withoutRunnerMarker(() => captureThrow(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: false,
      environment: box.environment,
    })));
    assert.match(error.message, /this machine already has a store here/);
    assert.ok(error.message.includes(known), 'the known store path is named in the refusal');
    assert.match(error.message, /HUQAN_DB_PATH/);
  } finally { box.cleanup(); }
});

test('a registry it cannot read leaves the guard open, not refusing blindly', () => {
  const box = sandbox();
  try {
    fs.mkdirSync(path.dirname(registryPath(box.environment)), { recursive: true });
    fs.writeFileSync(registryPath(box.environment), 'not json at all');
    assert.deepEqual(readKnownStores(box.environment), []);

    // An unreadable registry is indistinguishable from a machine with no store,
    // and failing open there is deliberate: a registry that cannot be kept is
    // not a reason to refuse work.
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: false,
      environment: box.environment,
    }));
  } finally { box.cleanup(); }
});

test('rebuild still works once a store is registered', () => {
  const box = sandbox();
  try {
    withRegisteredStore(box);
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.dbPath,
      explicit: false,
      exists: false,
      environment: { ...box.environment, [REBUILD_OPT_IN_VARIABLE]: '1' },
    }));
  } finally { box.cleanup(); }
});

test('a store under the OS temp directory is a throwaway, never a stray', () => {
  const box = sandbox();
  try {
    withRegisteredStore(box);
    // box.root is itself created with mkdtemp under os.tmpdir(), so this is the
    // packed-tarball smoke's shape: a fresh install into a temp directory on a
    // machine that already keeps a real store elsewhere.
    withoutRunnerMarker(() => assertStoreCreationAllowed({
      dbPath: box.ephemeralDbPath,
      explicit: false,
      exists: false,
      environment: box.environment,
    }));
    assert.equal(isEphemeralStorePath(box.ephemeralDbPath), true);
    assert.equal(isEphemeralStorePath(box.dbPath), false);
  } finally { box.cleanup(); }
});

test('recordKnownStore is a no-op under the test runner', () => {
  const box = sandbox();
  try {
    assert.equal(recordKnownStore(box.dbPath, box.environment), false);
    assert.deepEqual(readKnownStores(box.environment), []);
  } finally { box.cleanup(); }
});

test('a recorded store is readable back, once, most recent last', () => {
  const box = sandbox();
  try {
    withoutRunnerMarker(() => {
      recordKnownStore(path.join(box.root, 'a.db'), box.environment);
      recordKnownStore(path.join(box.root, 'b.db'), box.environment);
      recordKnownStore(path.join(box.root, 'a.db'), box.environment);
    });
    assert.deepEqual(readKnownStores(box.environment), [
      path.join(box.root, 'b.db'),
      path.join(box.root, 'a.db'),
    ]);
  } finally { box.cleanup(); }
});

/**
 * #3976: the temp root and the store path can name the same directory in two
 * spellings. `os.tmpdir()` is environment-derived and on Windows carries an 8.3
 * short component (`RUNNER~1`), while the fixture root -- and so the store path
 * -- is the form `fs.realpathSync.native` returns. A lexical comparison read
 * the throwaway as a kept store, registered it, and wrote `stores.json` into
 * the caller's own tree, which the coder gate then saw as untracked dirt.
 *
 * A symlinked temp root reproduces the two-spellings-one-directory shape on
 * every platform, so the regression is pinned without a Windows runner.
 */
test('a temp store is a throwaway when the temp root is spelled differently', () => {
  const box = sandbox();
  try {
    const realRoot = path.join(box.root, 'real-temp');
    const linkedRoot = path.join(box.root, 'linked-temp');
    fs.mkdirSync(realRoot, { recursive: true });
    fs.symlinkSync(realRoot, linkedRoot, 'junction');
    // The store path is the realpath'd form, exactly as the fixture builds it.
    const store = path.join(realRoot, 'huqan-fixture', 'memory.db');

    // Aliased temp root, long store path: the failing direction. The leaf does
    // not exist yet, as when the store is about to be created.
    assert.equal(fs.existsSync(store), false);
    assert.equal(isEphemeralStorePath(store, linkedRoot), true, `${linkedRoot} vs ${store}`);
    // A store the operator keeps is still not a throwaway.
    assert.equal(isEphemeralStorePath(path.join(box.root, 'kept', 'memory.db'), linkedRoot), false);
  } finally { box.cleanup(); }
});

test('a temp root that does not exist yet keeps its resolved spelling', () => {
  const box = sandbox();
  try {
    const absent = path.join(box.root, 'not-created');
    assert.equal(isEphemeralStorePath(path.join(absent, 'memory.db'), absent), true);
    assert.equal(isEphemeralStorePath(path.join(box.root, 'elsewhere.db'), absent), false);
  } finally { box.cleanup(); }
});

test('a store escaping a temporary root through a junction is never ephemeral', () => {
  const box = sandbox();
  try {
    const realRoot = path.join(box.root, 'real-temp');
    const aliasRoot = path.join(box.root, 'alias-temp');
    const kept = path.join(box.root, 'kept');
    fs.mkdirSync(realRoot); fs.mkdirSync(kept);
    fs.symlinkSync(realRoot, aliasRoot, 'junction');
    fs.symlinkSync(kept, path.join(realRoot, 'escape'), 'junction');
    fs.writeFileSync(path.join(kept, 'existing.db'), 'kept');
    for (const root of [realRoot, aliasRoot]) {
      for (const spelling of [realRoot, aliasRoot]) {
        assert.equal(isEphemeralStorePath(path.join(spelling, 'escape', 'existing.db'), root), false);
        assert.equal(isEphemeralStorePath(path.join(spelling, 'escape', 'new-parent', 'memory.db'), root), false);
      }
      assert.equal(isEphemeralStorePath(path.join(realRoot, 'new-parent', 'memory.db'), root), true);
    }
  } finally { box.cleanup(); }
});

test('an unresolved junction cannot grant a temporary-store exemption', () => {
  const box = sandbox();
  try {
    const temporary = path.join(box.root, 'temp'); fs.mkdirSync(temporary);
    fs.symlinkSync(path.join(box.root, 'missing-target'), path.join(temporary, 'broken'), 'junction');
    assert.equal(isEphemeralStorePath(path.join(temporary, 'broken', 'memory.db'), temporary), false);
  } finally { box.cleanup(); }
});

test('realpath permission failures cannot classify a store as ephemeral', () => {
  const box = sandbox();
  const nativeRealpath = fs.realpathSync.native;
  try {
    const temporary = path.resolve(box.root);
    fs.realpathSync.native = value => {
      if (value === temporary) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return nativeRealpath(value);
    };
    assert.equal(isEphemeralStorePath(path.join(temporary, 'memory.db'), temporary), false);
  } finally { fs.realpathSync.native = nativeRealpath; box.cleanup(); }
});

test('an unreadable missing-tail entry cannot grant an ephemeral exemption', () => {
  const box = sandbox();
  const nativeRealpath = fs.realpathSync.native;
  const nativeLstat = fs.lstatSync;
  try {
    const store = path.resolve(box.root, 'memory.db');
    fs.realpathSync.native = value => {
      if (value === store) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return nativeRealpath(value);
    };
    fs.lstatSync = value => {
      if (value === store) throw Object.assign(new Error('denied'), { code: 'EACCES' });
      return nativeLstat(value);
    };
    assert.equal(isEphemeralStorePath(store, box.root), false);
  } finally { fs.realpathSync.native = nativeRealpath; fs.lstatSync = nativeLstat; box.cleanup(); }
});

test('a filesystem with no resolvable ancestor grants no temporary exemption', () => {
  const box = sandbox();
  const nativeRealpath = fs.realpathSync.native;
  const nativeLstat = fs.lstatSync;
  try {
    const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
    fs.realpathSync.native = missing; fs.lstatSync = missing;
    assert.equal(isEphemeralStorePath(path.join(box.root, 'memory.db'), box.root), false);
  } finally { fs.realpathSync.native = nativeRealpath; fs.lstatSync = nativeLstat; box.cleanup(); }
});
