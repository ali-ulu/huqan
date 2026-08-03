'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const Database = require('better-sqlite3');
const {
  EXTERNAL_CLIENT_AUTHORITY_VERSION,
  EXTERNAL_CLIENT_ADMISSION_PERMISSION,
  EXTERNAL_CLIENT_AUTHORITY_ERRORS,
  snapshotExternalClientAuthority,
} = require('./external-client-authority');
const {
  createExternalClientReplayStore,
} = require('./external-client-replay-store');

function tempDb(t, name = 'replay') {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-replay-'));
  t.after(() => {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch (_) { /* Windows lock guard */ }
  });
  return path.join(directory, `${name}.db`);
}

function hash(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

function replayRecord(seed = 'one', overrides = {}) {
  return {
    replayKey: `${EXTERNAL_CLIENT_AUTHORITY_VERSION}:${hash(`replay:${seed}`)}`,
    identitySubject: 'connector:github',
    identityKind: 'connector',
    workspaceId: 'workspace-a',
    packageId: 'pkg.github.workspace-a',
    packageHash: hash(`package:${seed}`),
    trustedKeyId: 'trusted-key-1',
    permission: EXTERNAL_CLIENT_ADMISSION_PERMISSION,
    createdAt: '2026-08-03T17:00:00.000Z',
    reservedAt: 1785776400000,
    expiresAt: 1785777000000,
    ...overrides,
  };
}

function throwsReplay(fn) {
  assert.throws(fn, (error) => error
    && error.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED);
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`child failed code=${code} signal=${signal} stderr=${stderr}`));
    });
  });
}

async function waitForFile(filePath, timeoutMs = 5000) {
  const started = Date.now();
  while (!fs.existsSync(filePath)) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function startReserveWorker(modulePath, dbPath, barrierPath, record) {
  const source = `
    'use strict';
    const fs = require('node:fs');
    const { createExternalClientReplayStore } = require(process.argv[1]);
    const dbPath = process.argv[2];
    const barrierPath = process.argv[3];
    const record = JSON.parse(process.argv[4]);
    const sleepArray = new Int32Array(new SharedArrayBuffer(4));
    while (!fs.existsSync(barrierPath)) Atomics.wait(sleepArray, 0, 0, 5);
    const store = createExternalClientReplayStore({
      dbPath,
      busyRetry: {
        busyTimeoutMs: 20,
        maxAttempts: 20,
        initialBackoffMs: 5,
        backoffMultiplier: 2,
        maxBackoffMs: 25
      }
    });
    const result = store.reserve(record);
    store.close();
    process.stdout.write(JSON.stringify(result));
  `;
  return spawn(
    process.execPath,
    ['-e', source, modulePath, dbPath, barrierPath, JSON.stringify(record)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

function startLockHolder(dbPath, readyPath, holdMs) {
  const source = `
    'use strict';
    const fs = require('node:fs');
    const Database = require('better-sqlite3');
    const db = new Database(process.argv[1]);
    db.pragma('busy_timeout = 5000');
    db.exec('BEGIN IMMEDIATE');
    fs.writeFileSync(process.argv[2], 'ready');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.argv[3]));
    db.exec('COMMIT');
    db.close();
  `;
  return spawn(
    process.execPath,
    ['-e', source, dbPath, readyPath, String(holdMs)],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
}

test('construction requires exact trusted options and an existing absolute parent', (t) => {
  const dbPath = tempDb(t, 'options');
  throwsReplay(() => createExternalClientReplayStore({}));
  throwsReplay(() => createExternalClientReplayStore({ dbPath: 'relative.db' }));
  throwsReplay(() => createExternalClientReplayStore({ dbPath, extra: true }));
  throwsReplay(() => createExternalClientReplayStore({
    dbPath,
    busyRetry: { maxAttempts: 2, unknown: 1 },
  }));
  throwsReplay(() => createExternalClientReplayStore({
    dbPath: path.join(path.dirname(dbPath), 'missing', 'replay.db'),
  }));
});

test('valid reservation and duplicate return exact frozen bounded results', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'basic') });
  const first = store.reserve(replayRecord());
  const duplicate = store.reserve(replayRecord());

  assert.deepEqual(first, { reserved: true });
  assert.deepEqual(duplicate, { reserved: false });
  assert.deepEqual(Reflect.ownKeys(first), ['reserved']);
  assert.deepEqual(Reflect.ownKeys(duplicate), ['reserved']);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(duplicate), true);
  assert.deepEqual(Object.keys(store).sort(), ['close', 'reserve']);
  assert.equal(Object.isFrozen(store), true);
  store.close();
});

test('store composes with the existing Authority-0 injected replay owner contract', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'authority') });
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const authority = snapshotExternalClientAuthority({
    expectedIdentitySubject: 'connector:github',
    expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-a',
    expectedPackageId: 'pkg.github.workspace-a',
    permissions: [EXTERNAL_CLIENT_ADMISSION_PERMISSION],
    trustedKeys: {
      'trusted-key-1': {
        publicKey,
        workspaceId: 'workspace-a',
        packageIds: ['pkg.github.workspace-a'],
        identitySubjects: ['connector:github'],
        identityKinds: ['connector'],
        notBefore: '2026-08-03T16:00:00.000Z',
        notAfter: '2026-08-03T19:00:00.000Z',
        revoked: false,
      },
    },
    clock: () => 1785776400000,
    replayStore: store,
  });
  assert.equal(typeof authority.replayReserve, 'function');
  store.close();
});

test('reservation persists across close and reopen', (t) => {
  const dbPath = tempDb(t, 'restart');
  const first = createExternalClientReplayStore({ dbPath });
  assert.deepEqual(first.reserve(replayRecord('persist')), { reserved: true });
  first.close();

  const second = createExternalClientReplayStore({ dbPath });
  assert.deepEqual(second.reserve(replayRecord('persist')), { reserved: false });
  second.close();
});

test('trusted-time expiry is inclusive at expiry and duplicate one millisecond before', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'expiry') });
  const original = replayRecord('expiry', { reservedAt: 1000, expiresAt: 2000 });
  assert.deepEqual(store.reserve(original), { reserved: true });
  assert.deepEqual(store.reserve(replayRecord('expiry', {
    reservedAt: 1999,
    expiresAt: 3000,
  })), { reserved: false });
  assert.deepEqual(store.reserve(replayRecord('expiry', {
    reservedAt: 2000,
    expiresAt: 3000,
  })), { reserved: true });
  store.close();
});

test('input mutation and SQL metacharacters cannot alter committed reservation', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'mutation') });
  const input = replayRecord('mutation', {
    identitySubject: "connector:'; DROP TABLE external_client_replay_reservations; --",
  });
  const originalKey = input.replayKey;
  assert.deepEqual(store.reserve(input), { reserved: true });

  input.replayKey = `${EXTERNAL_CLIENT_AUTHORITY_VERSION}:${hash('changed')}`;
  input.identitySubject = 'changed';
  input.reservedAt = 1;
  input.expiresAt = 2;

  assert.deepEqual(store.reserve(replayRecord('mutation', {
    replayKey: originalKey,
    identitySubject: "connector:'; DROP TABLE external_client_replay_reservations; --",
  })), { reserved: false });
  assert.deepEqual(store.reserve(replayRecord('after-sql')), { reserved: true });
  store.close();
});

test('record requires the exact own enumerable data-property shape', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'shape') });

  const missing = replayRecord('missing');
  delete missing.packageId;
  throwsReplay(() => store.reserve(missing));

  const unknown = replayRecord('unknown');
  unknown.extra = true;
  throwsReplay(() => store.reserve(unknown));

  const symbolic = replayRecord('symbol');
  symbolic[Symbol('record')] = true;
  throwsReplay(() => store.reserve(symbolic));

  let accessorCalls = 0;
  const accessor = replayRecord('accessor');
  delete accessor.workspaceId;
  Object.defineProperty(accessor, 'workspaceId', {
    enumerable: true,
    get() { accessorCalls += 1; return 'workspace-a'; },
  });
  throwsReplay(() => store.reserve(accessor));
  assert.equal(accessorCalls, 0);

  const nonEnumerable = replayRecord('non-enumerable');
  Object.defineProperty(nonEnumerable, 'workspaceId', {
    value: 'workspace-a',
    enumerable: false,
  });
  throwsReplay(() => store.reserve(nonEnumerable));

  const inherited = Object.assign(Object.create({ inherited: true }), replayRecord('inherited'));
  throwsReplay(() => store.reserve(inherited));

  const hostile = new Proxy(replayRecord('proxy'), {
    ownKeys() { throw new Error('hostile ownKeys'); },
  });
  throwsReplay(() => store.reserve(hostile));
  store.close();
});

test('record values fail closed when identity, digest, permission, time or expiry is invalid', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'values') });
  const invalid = [
    { identitySubject: '' },
    { identityKind: ' connector ' },
    { replayKey: `${EXTERNAL_CLIENT_AUTHORITY_VERSION}:not-a-digest` },
    { packageHash: 'not-a-digest' },
    { permission: 'other' },
    { createdAt: '2026-08-03T17:00:00Z' },
    { reservedAt: 1.5 },
    { reservedAt: Number.MAX_SAFE_INTEGER + 1 },
    { expiresAt: 1000, reservedAt: 1000 },
    { expiresAt: 999, reservedAt: 1000 },
  ];
  for (let index = 0; index < invalid.length; index += 1) {
    throwsReplay(() => store.reserve(replayRecord(`invalid-${index}`, invalid[index])));
  }
  store.close();
});

test('two owner instances produce one reserve and one duplicate', (t) => {
  const dbPath = tempDb(t, 'two-instances');
  const left = createExternalClientReplayStore({ dbPath });
  const right = createExternalClientReplayStore({ dbPath });
  const results = [left.reserve(replayRecord('two')), right.reserve(replayRecord('two'))];
  assert.equal(results.filter((result) => result.reserved === true).length, 1);
  assert.equal(results.filter((result) => result.reserved === false).length, 1);
  left.close();
  right.close();
});

test('two independent Node processes produce exactly one reserve and one duplicate', async (t) => {
  const dbPath = tempDb(t, 'cross-process');
  const initialized = createExternalClientReplayStore({ dbPath });
  initialized.close();

  const barrierPath = path.join(path.dirname(dbPath), 'start');
  const modulePath = require.resolve('./external-client-replay-store');
  const record = replayRecord('cross-process');
  const left = startReserveWorker(modulePath, dbPath, barrierPath, record);
  const right = startReserveWorker(modulePath, dbPath, barrierPath, record);
  const leftExit = waitForExit(left);
  const rightExit = waitForExit(right);
  fs.writeFileSync(barrierPath, 'go');

  const outputs = await Promise.all([leftExit, rightExit]);
  const results = outputs.map(({ stdout }) => JSON.parse(stdout));
  assert.equal(results.filter((result) => result.reserved === true).length, 1);
  assert.equal(results.filter((result) => result.reserved === false).length, 1);
});

test('forced insert failure rolls back without a partial reservation', (t) => {
  const dbPath = tempDb(t, 'rollback');
  const store = createExternalClientReplayStore({ dbPath });
  const control = new Database(dbPath);
  control.exec(`
    CREATE TRIGGER fail_external_client_replay_insert
    BEFORE INSERT ON external_client_replay_reservations
    BEGIN
      SELECT RAISE(ABORT, 'forced replay insert failure');
    END
  `);
  control.close();

  throwsReplay(() => store.reserve(replayRecord('rollback')));

  const repair = new Database(dbPath);
  repair.exec('DROP TRIGGER fail_external_client_replay_insert');
  repair.close();
  assert.deepEqual(store.reserve(replayRecord('rollback')), { reserved: true });
  store.close();
});

test('bounded lock retry succeeds after a short cross-process lock', async (t) => {
  const dbPath = tempDb(t, 'busy-success');
  const store = createExternalClientReplayStore({
    dbPath,
    busyRetry: {
      busyTimeoutMs: 10,
      maxAttempts: 20,
      initialBackoffMs: 5,
      backoffMultiplier: 2,
      maxBackoffMs: 20,
    },
  });
  const readyPath = path.join(path.dirname(dbPath), 'lock-ready');
  const holder = startLockHolder(dbPath, readyPath, 100);
  const holderExit = waitForExit(holder);
  await waitForFile(readyPath);
  assert.deepEqual(store.reserve(replayRecord('busy-success')), { reserved: true });
  await holderExit;
  store.close();
});

test('bounded lock retry fails predictably when attempts are exhausted', async (t) => {
  const dbPath = tempDb(t, 'busy-fail');
  const store = createExternalClientReplayStore({
    dbPath,
    busyRetry: {
      busyTimeoutMs: 5,
      maxAttempts: 2,
      initialBackoffMs: 1,
      backoffMultiplier: 1,
      maxBackoffMs: 1,
    },
  });
  const readyPath = path.join(path.dirname(dbPath), 'lock-ready');
  const holder = startLockHolder(dbPath, readyPath, 300);
  const holderExit = waitForExit(holder);
  await waitForFile(readyPath);
  throwsReplay(() => store.reserve(replayRecord('busy-fail')));
  await holderExit;
  store.close();
});

test('incompatible schema and corrupt database fail closed without migration', (t) => {
  const incompatiblePath = tempDb(t, 'incompatible');
  const incompatible = new Database(incompatiblePath);
  incompatible.exec(`
    CREATE TABLE external_client_replay_reservations (
      replay_key TEXT PRIMARY KEY
    )
  `);
  incompatible.close();
  throwsReplay(() => createExternalClientReplayStore({ dbPath: incompatiblePath }));

  const corruptPath = path.join(path.dirname(incompatiblePath), 'corrupt.db');
  fs.writeFileSync(corruptPath, 'not a sqlite database');
  throwsReplay(() => createExternalClientReplayStore({ dbPath: corruptPath }));
});

test('missing better-sqlite3 fails with the existing bounded replay error', (t) => {
  const dbPath = tempDb(t, 'missing-dependency');
  const modulePath = require.resolve('./external-client-replay-store');
  const source = `
    'use strict';
    const Module = require('node:module');
    const originalLoad = Module._load;
    Module._load = function(request, parent, isMain) {
      if (request === 'better-sqlite3') throw new Error('missing');
      return originalLoad.call(this, request, parent, isMain);
    };
    const { createExternalClientReplayStore } = require(process.argv[1]);
    try {
      createExternalClientReplayStore({ dbPath: process.argv[2] });
      process.exitCode = 2;
    } catch (error) {
      process.stdout.write(String(error && error.code));
    }
  `;
  const result = spawnSync(process.execPath, ['-e', source, modulePath, dbPath], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout,
    EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_RESERVATION_FAILED,
  );
});

test('close is idempotent and reserve after close fails closed', (t) => {
  const store = createExternalClientReplayStore({ dbPath: tempDb(t, 'close') });
  store.close();
  store.close();
  throwsReplay(() => store.reserve(replayRecord('closed')));
});

test('source has no system-time, JSON, memory-authority, route, mutation or receipt fallback', () => {
  const source = fs.readFileSync(path.join(__dirname, 'external-client-replay-store.js'), 'utf8');
  assert.doesNotMatch(
    source,
    /process\.env|Date\.now\s*\(|new\s+Date\s*\(\s*\)|JSON\.(?:parse|stringify)|new\s+Map|new\s+Set|server\.js|graph\.js|memory-store\.js|replayStore\s*=\s*new|receipt|mutation|http|https/i,
  );
  assert.match(source, /require\(['"]better-sqlite3['"]\)/);
  assert.match(source, /transaction\.immediate/);
});
