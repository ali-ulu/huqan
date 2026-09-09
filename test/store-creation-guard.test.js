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
    dbPath: path.join(root, 'memory.db'),
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
