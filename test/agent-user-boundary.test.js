'use strict';

// ADR-017 (#3948): the agent-user boundary is reported from a live, trusted
// marker, never from the ADR text. These tests pin the fail-closed rule that
// makes the report honest: only a marker whose path still carries the installer's
// ACL yields `os-user`; everything else reports the weaker `same-user`.

const { test, describe } = require('node:test');
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

const POSIX_MARKER = JSON.stringify({ v: MARKER_VERSION, agentUser: 'huqan-agent', agentUid: 1001, operatorUid: 1000, createdAt: '2026-10-16T00:00:00Z' });

/** A POSIX resolver with injected probes: files, trust, store, migration, spawn. */
function posixResolver({
  files = {}, platform = 'linux', trust = { ok: true }, storeAcl = { ok: true }, migration = { ok: true },
  uid = 1001, groups = ['huqan-agent'], trustThrows = false,
} = {}) {
  return resolveAgentUserBoundary({
    platform,
    readFile: (file) => {
      if (!(file in files)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return files[file];
    },
    checkPosixTrust: () => {
      if (trustThrows) throw new Error('probe failed');
      return trust;
    },
    checkStoreAclImpl: () => storeAcl,
    verifyMigrationImpl: () => migration,
    spawn: (cmd, args) => {
      if (cmd === 'id') return { status: 0, stdout: `${groups.join(' ')}\n` };
      const line = cmd === 'dscl' ? `UniqueID: ${uid}\n` : `huqan-agent:x:${uid}:${uid}::/nonexistent:/usr/sbin/nologin\n`;
      return { status: 0, stdout: line };
    },
  });
}

const POSIX_MARKER_PATH = { linux: '/var/lib/huqan/state/agent-boundary.json', darwin: '/Library/HUQAN/state/agent-boundary.json' };

describe('the POSIX agent-user boundary', () => {
  for (const platform of ['linux', 'darwin']) {
    test(`on ${platform} with no marker the boundary is same-user no_marker`, () => {
      const result = posixResolver({ platform, files: {} });
      assert.deepEqual([result.value, result.reason], [SAME_USER, 'no_marker']);
    });

    test(`on ${platform} all checks passing reports os-user`, () => {
      const result = posixResolver({ platform, files: { [POSIX_MARKER_PATH[platform]]: POSIX_MARKER } });
      assert.deepEqual([result.value, result.agentUser], [AGENT_BOUNDARY, 'huqan-agent']);
    });
  }

  test('a posix marker naming uid 0 is refused', () => {
    const marker = JSON.stringify({ v: MARKER_VERSION, agentUser: 'a', agentUid: 0, operatorUid: 1000 });
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: marker } });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'agent_uid_is_root']);
  });

  test('a posix marker whose agent uid equals the operator uid is refused', () => {
    const marker = JSON.stringify({ v: MARKER_VERSION, agentUser: 'a', agentUid: 1000, operatorUid: 1000 });
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: marker } });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'agent_is_operator']);
  });

  test('a marker whose uid the account database does not confirm is refused', () => {
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: POSIX_MARKER }, uid: 1002 });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'agent_uid_mismatch']);
  });

  test('an agent in sudo, wheel or admin is refused', () => {
    for (const group of ['sudo', 'wheel', 'admin']) {
      const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: POSIX_MARKER }, groups: ['huqan-agent', group] });
      assert.deepEqual([result.value, result.reason], [SAME_USER, 'agent_in_admin_group'], group);
    }
  });

  test('a planted but untrusted marker is refused rather than read as os-user', () => {
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: POSIX_MARKER }, trust: { ok: false, reason: 'install_path_untrusted' } });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'marker_untrusted']);
    const throwing = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: POSIX_MARKER }, trustThrows: true });
    assert.equal(throwing.value, SAME_USER);
  });

  test('a marker missing the uids is not evidence of a split on posix', () => {
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: MARKER } });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'marker_malformed']);
  });

  test('a store ACL that does not match the POSIX spec stops the chain', () => {
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: POSIX_MARKER }, storeAcl: { ok: false, reason: 'store_mode_exposed' } });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'store_mode_exposed']);
  });

  test('a missing migration marker stops the chain', () => {
    const result = posixResolver({ files: { [POSIX_MARKER_PATH.linux]: POSIX_MARKER }, migration: { ok: false, reason: 'no_marker' } });
    assert.deepEqual([result.value, result.reason], [SAME_USER, 'no_marker']);
  });

  test('HUQAN_PROTECTED_STATE_ROOT does not move the posix marker', () => {
    let read = null;
    const previous = process.env.HUQAN_PROTECTED_STATE_ROOT;
    process.env.HUQAN_PROTECTED_STATE_ROOT = '/tmp/attacker-controlled';
    try {
      resolveAgentUserBoundary({
        platform: 'linux',
        readFile: (file) => { read = file; throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        checkPosixTrust: () => ({ ok: true }),
      });
    } finally {
      if (previous === undefined) delete process.env.HUQAN_PROTECTED_STATE_ROOT;
      else process.env.HUQAN_PROTECTED_STATE_ROOT = previous;
    }
    assert.equal(read, '/var/lib/huqan/state/agent-boundary.json');
  });
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
  const result = resolveAgentUserBoundary({
    platform: 'freebsd',
    readFile: () => { throw new Error('must not read the marker off a supported platform'); },
    checkTrust: () => { throw new Error('must not probe off a supported platform'); },
  });
  assert.deepEqual([result.value, result.reason], [SAME_USER, 'unsupported_platform']);
});
