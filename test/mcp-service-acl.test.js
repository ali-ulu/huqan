'use strict';

/**
 * The per-server ACL spec and its checks (ADR-018 §3, #3999), with the
 * PowerShell probe injected the way store-acl's tests inject theirs: the
 * check logic is exercised on any platform, the real probe only on Windows.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const realAcl = require('../lib/mcp/service-acl');

// The ACL operations answer not_windows on any other platform. These tests
// exercise the Windows logic through an injected probe, so they default the
// platform to win32 on every runner; a test that passes platform overrides it.
const onWindows = (operation) => (options = {}) => operation({ platform: 'win32', ...options });
const acl = {
  ...realAcl,
  applyMcpServiceAcl: onWindows(realAcl.applyMcpServiceAcl),
  checkMcpServiceAcl: onWindows(realAcl.checkMcpServiceAcl),
  checkNoStoreAce: onWindows(realAcl.checkNoStoreAce),
};

const OPERATOR = 'DESKTOP\\operator';
const SERVICE = 'NT SERVICE\\huqan-mcp-levh';
const DATA = 'C:\\ProgramData\\huqan\\mcp\\levh';
const STATE = `${DATA}\\state`;

function rule(sid, name, rights, type = 'Allow') {
  return { sid, name, rights, type };
}

/** Fake probe output for one path with the given rules and owner. */
function probeOf(paths, entries, owner = 'S-1-5-18') {
  return () => ({
    status: 0,
    stdout: JSON.stringify(paths.map((path, index) => ({ path, owner, access: entries[index] }))),
  });
}

/** The DACL the data root is installed with: SYSTEM/Admins full, Users RX. */
const DATA_ACCESS = Object.freeze([
  rule('S-1-5-18', 'SYSTEM', 'FullControl'),
  rule('S-1-5-32-544', 'Administrators', 'FullControl'),
  rule('S-1-5-32-545', 'Users', 'ReadAndExecute'),
]);

test('the service account and data directory derive from the server name', () => {
  assert.equal(acl.serviceAccountFor('levh'), 'NT SERVICE\\huqan-mcp-levh');
  assert.equal(acl.dataDirFor('levh'), 'C:\\ProgramData\\huqan\\mcp\\levh');
  assert.throws(() => acl.serviceAccountFor('Levh'), /name/);
  assert.throws(() => acl.serviceAccountFor('../x'), /name/);
});

test('apply is Windows-only and grants exactly the spec on state', () => {
  const spawned = [];
  const spawn = (file, args) => {
    spawned.push([file, args]);
    return { status: 0 };
  };
  const applied = acl.applyMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE, spawn });
  assert.deepEqual(applied, { applied: true });
  const stateCall = spawned.find(([, args]) => args[0] === STATE);
  assert.ok(stateCall[1].includes('/inheritance:r'), 'state breaks inheritance');
  const grants = stateCall[1].filter((arg) => arg.includes(':('));
  assert.deepEqual(grants, [
    '*S-1-5-18:(OI)(CI)F',
    '*S-1-5-32-544:(OI)(CI)F',
    `${OPERATOR}:(OI)(CI)F`,
    `${SERVICE}:(OI)(CI)M`,
  ]);
  const dataCall = spawned.find(([, args]) => args[0] === DATA);
  assert.ok(dataCall[1].includes('/inheritance:r'), 'the data root breaks inheritance too: ProgramData would otherwise pass Users create/append down to it');
  assert.ok(acl.applyMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE, spawn, platform: 'linux' })
    .reason === 'not_windows');
  assert.equal(acl.applyMcpServiceAcl({ dataDir: "C:\\bad'path", stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE, spawn }).reason,
    'path_untrusted');
  assert.equal(acl.applyMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
    spawn: () => ({ status: 1 }) }).reason, 'acl_apply_failed');
});

test('check accepts a DACL that matches the spec exactly', () => {
  const rules = [
    rule('S-1-5-18', 'SYSTEM', 'FullControl'),
    rule('S-1-5-32-544', 'Administrators', 'FullControl'),
    rule('', OPERATOR, 'FullControl'),
    rule('', SERVICE, 'Modify'),
  ];
  const result = acl.checkMcpServiceAcl({
    dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
    spawn: probeOf([DATA, STATE], [DATA_ACCESS, rules]),
  });
  assert.deepEqual(result, { ok: true });
});

test('check refuses a DACL with any principal outside the spec -- the agent user, another server, a hand-added account', () => {
  const base = [
    rule('S-1-5-18', 'SYSTEM', 'FullControl'),
    rule('S-1-5-32-544', 'Administrators', 'FullControl'),
    rule('', OPERATOR, 'FullControl'),
    rule('', SERVICE, 'Modify'),
  ];
  const strangers = [
    rule('S-1-5-32-545', 'Users', 'Read'),
    rule('', 'DESKTOP\\agent-user', 'Read'),
    rule('', 'NT SERVICE\\huqan-mcp-other', 'FullControl'),
    rule('', 'S-1-5-11', 'Write'),
  ];
  for (const stranger of strangers) {
    const result = acl.checkMcpServiceAcl({
      dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
      spawn: probeOf([DATA, STATE], [DATA_ACCESS, [...base, stranger]]),
    });
    assert.equal(result.ok, false, stranger.name);
    assert.equal(result.reason, 'acl_unexpected_grant', stranger.name);
  }
});

test('check fails closed on a missing grant, a broad writer, a wrong owner, and an unreadable probe', () => {
  const full = [
    rule('S-1-5-18', 'SYSTEM', 'FullControl'),
    rule('S-1-5-32-544', 'Administrators', 'FullControl'),
    rule('', OPERATOR, 'FullControl'),
    rule('', SERVICE, 'Modify'),
  ];
  const noOperator = full.filter((r) => r.name !== OPERATOR);
  const cases = [
    { stateAccess: noOperator, reason: 'acl_missing_grant' },
    { stateAccess: [...full, rule('S-1-1-0', 'Everyone', 'Modify')], reason: 'acl_broad_writer' },
    { stateAccess: full, owner: 'DESKTOP\\someone', reason: 'acl_untrusted_owner' },
  ];
  for (const problem of cases) {
    const probe = () => ({
      status: 0,
      stdout: JSON.stringify([{ path: DATA, owner: 'S-1-5-18', access: [...DATA_ACCESS] },
        { path: STATE, owner: problem.owner || 'S-1-5-18', access: problem.stateAccess }]),
    });
    const result = acl.checkMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE, spawn: probe });
    assert.equal(result.reason, problem.reason);
  }
  assert.equal(acl.checkMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
    spawn: () => ({ status: 1 }) }).reason, 'acl_unreadable');
  assert.equal(acl.checkMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
    spawn: () => ({ status: 0, stdout: 'not json' }) }).reason, 'acl_unreadable');
  assert.equal(acl.checkMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
    spawn: () => ({ error: new Error('x') }) }).reason, 'acl_unreadable');
  assert.equal(acl.checkMcpServiceAcl({ dataDir: DATA, stateDir: STATE, operatorAccount: OPERATOR, serviceAccount: SERVICE,
    platform: 'linux' }).reason, 'not_windows');
});

test('checkNoStoreAce refuses an ACE the service account holds on the memory store', () => {
  const clean = probeOf(['C:\\ProgramData\\huqan\\state'], [[
    rule('S-1-5-18', 'SYSTEM', 'FullControl'),
    rule('S-1-5-32-544', 'Administrators', 'FullControl'),
    rule('', 'NT SERVICE\\huqan-runtime', 'Modify'),
  ]]);
  assert.deepEqual(acl.checkNoStoreAce({ serviceAccount: SERVICE, spawn: clean }), { ok: true });
  const tainted = probeOf(['C:\\ProgramData\\huqan\\state'], [[
    rule('S-1-5-18', 'SYSTEM', 'FullControl'),
    rule('', SERVICE, 'Read'),
  ]]);
  assert.deepEqual(acl.checkNoStoreAce({ serviceAccount: SERVICE, spawn: tainted }), { ok: false, reason: 'store_ace_present' });
  assert.equal(acl.checkNoStoreAce({ serviceAccount: SERVICE, spawn: () => ({ status: 1 }) }).reason, 'acl_unreadable');
  assert.equal(acl.checkNoStoreAce({ serviceAccount: SERVICE, platform: 'linux' }).reason, 'not_windows');
  assert.equal(acl.checkNoStoreAce({ serviceAccount: SERVICE, storeRoot: "C:\\bad'path" }).reason, 'path_untrusted');
});
