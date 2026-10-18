'use strict';

// ADR-017 (#3948): the agent-user boundary is reported from a live, trusted
// marker, never from the ADR text. These tests pin the fail-closed rule that
// makes the report honest: only a marker whose path still carries the installer's
// ACL yields `os-user`; everything else reports the weaker `same-user`.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAgentUserBoundary, AGENT_BOUNDARY, DEFAULT_WINDOWS_MARKER_PATH, DEFAULT_WINDOWS_STATE_DIR,
  MARKER_VERSION, SAME_USER } = require('../lib/authority/agent-user-boundary');

const MARKER = JSON.stringify({ v: MARKER_VERSION, agentUser: 'huqan-agent', session: 2, createdAt: '2026-10-16T00:00:00Z' });

function resolver({ files = {}, platform = 'win32', trust = { ok: true }, trustThrows = false,
  storeAcl = { ok: true }, migration = { ok: true }, storeAclThrows = false, migrationThrows = false } = {}) {
  let trustCalls = 0;
  let storeAclCalls = 0;
  let migrationCalls = 0;
  return {
    trustCalls: () => trustCalls,
    storeAclCalls: () => storeAclCalls,
    migrationCalls: () => migrationCalls,
    run: () => resolveAgentUserBoundary({
      platform,
      readFile: (file) => {
        if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
        return files[file];
      },
      checkTrust: (paths) => {
        trustCalls += 1;
        if (trustThrows) throw new Error('probe failed');
        return paths ? trust : { ok: false };
      },
      checkStoreAclImpl: () => {
        storeAclCalls += 1;
        if (storeAclThrows) throw new Error('acl probe failed');
        return storeAcl;
      },
      verifyMigrationImpl: () => {
        migrationCalls += 1;
        if (migrationThrows) throw new Error('marker probe failed');
        return migration;
      },
    }),
  };
}

test('a marker, a matching store ACL and a verified migration together report the OS boundary', () => {
  const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER } });
  const boundary = r.run();
  assert.equal(boundary.value, AGENT_BOUNDARY);
  assert.equal(boundary.agentUser, 'huqan-agent');
  assert.equal(r.trustCalls(), 1, 'the marker content alone is never trusted');
  assert.equal(r.storeAclCalls(), 1, 'the store ACL is checked (ADR-018 §1 (b))');
  assert.equal(r.migrationCalls(), 1, 'the migration marker is verified (ADR-018 §1 (c))');
});

test('the trust check inspects the state directory and the marker together', () => {
  let seen = null;
  const result = resolveAgentUserBoundary({
    platform: 'win32',
    readFile: () => MARKER,
    checkTrust: (paths) => { seen = paths; return { ok: true }; },
    checkStoreAclImpl: () => ({ ok: true }),
    verifyMigrationImpl: () => ({ ok: true }),
  });
  assert.deepEqual(seen, [DEFAULT_WINDOWS_STATE_DIR, DEFAULT_WINDOWS_MARKER_PATH]);
  assert.equal(result.value, AGENT_BOUNDARY);
});

test('a trusted marker with an unverified store ACL stays same-user and names (b)', () => {
  const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, storeAcl: { ok: false, reason: 'acl_broad_writer' } });
  const boundary = r.run();
  assert.deepEqual([boundary.value, boundary.reason], [SAME_USER, 'acl_broad_writer']);
  assert.equal(r.migrationCalls(), 0, 'the first failing check stops the chain');
});

test('a trusted marker and ACL with no migration marker stays same-user and names (c)', () => {
  const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, migration: { ok: false, reason: 'no_marker' } });
  assert.deepEqual([r.run().value, r.run().reason], [SAME_USER, 'no_marker']);
});

test('a migration marker whose copy hash no longer matches fails closed', () => {
  const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, migration: { ok: false, reason: 'copy_hash_mismatch' } });
  assert.deepEqual([r.run().value, r.run().reason], [SAME_USER, 'copy_hash_mismatch']);
});

test('a store-ACL or migration probe that throws fails closed to same-user', () => {
  const aclThrows = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, storeAclThrows: true });
  assert.deepEqual([aclThrows.run().value, aclThrows.run().reason], [SAME_USER, 'store_acl_probe_failed']);
  const migrationThrows = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, migrationThrows: true });
  assert.deepEqual([migrationThrows.run().value, migrationThrows.run().reason], [SAME_USER, 'migration_verify_failed']);
});

test('without a marker the boundary stays same-user and no probe runs', () => {
  const r = resolver({ files: {}, trust: { ok: false } });
  const boundary = r.run();
  assert.deepEqual([boundary.value, boundary.reason], [SAME_USER, 'no_marker']);
  assert.equal(r.trustCalls(), 0, 'an absent marker needs no ACL probe');
});

test('a planted but untrusted marker is refused rather than read as os-user', () => {
  const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, trust: { ok: false, reason: 'path_untrusted' } });
  const boundary = r.run();
  assert.deepEqual([boundary.value, boundary.reason], [SAME_USER, 'marker_untrusted']);
});

test('a trust probe that throws fails closed to same-user, never to the stronger value', () => {
  const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: MARKER }, trustThrows: true });
  assert.equal(r.run().value, SAME_USER);
});

test('a malformed or wrong-version marker is not evidence of a split', () => {
  for (const text of ['{', 'null', '[]', JSON.stringify({ v: 'other', agentUser: 'x' }),
    JSON.stringify({ v: MARKER_VERSION }), JSON.stringify({ v: MARKER_VERSION, agentUser: '   ' })]) {
    const r = resolver({ files: { [DEFAULT_WINDOWS_MARKER_PATH]: text } });
    assert.deepEqual([r.run().value, r.run().reason], [SAME_USER, 'marker_malformed'], text.slice(0, 30));
  }
});

test('a marker that cannot be read is not a marker', () => {
  const result = resolveAgentUserBoundary({
    platform: 'win32',
    readFile: () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); },
    checkTrust: () => ({ ok: true }),
  });
  assert.deepEqual([result.value, result.reason], [SAME_USER, 'marker_unreadable']);
});

test('on a platform with no agent split the boundary is same-user and nothing is read', () => {
  for (const platform of ['linux', 'darwin']) {
    const result = resolveAgentUserBoundary({
      platform,
      readFile: () => { throw new Error('must not read the marker off Windows'); },
      checkTrust: () => { throw new Error('must not probe off Windows'); },
    });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'not_windows'], platform);
  }
});
