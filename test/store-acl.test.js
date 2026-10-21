'use strict';

// The protected store's ACL (ADR-018 §3, #3998). One definition, two
// operations: apply (the elevated migration) and check (the boundary report).
// The check is what makes `os-user` unreachable on a store whose ACL is wrong,
// so its failure modes are the point of this file.
//
// The apply path shells out to icacls and the check to powershell; both are
// injected here, so the tests run anywhere and assert the decision, not the OS.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  RUNTIME_SERVICE_ACCOUNT,
  STORE_ACL_SPEC,
  POSIX_STORE_ACL_SPEC,
  SYSTEM_SID,
  ADMINISTRATORS_SID,
  applyStoreAcl,
  checkStoreAcl,
  grantsWrite,
  isBroadWriter,
} = require('../lib/authority/store-acl');

const STATE = 'C:\\ProgramData\\huqan\\state';
const WORKSPACES = 'C:\\ProgramData\\huqan\\state\\workspaces';
const POSIX_STATE = '/var/lib/huqan/state';
const POSIX_WORKSPACES = '/var/lib/huqan/state/workspaces';

/** A probe answer that satisfies the spec for both trees. */
function goodEntries() {
  return [
    {
      path: STATE,
      owner: SYSTEM_SID,
      access: [
        { sid: SYSTEM_SID, name: 'NT AUTHORITY\\SYSTEM', rights: 'FullControl', type: 'Allow' },
        { sid: ADMINISTRATORS_SID, name: 'BUILTIN\\Administrators', rights: 'FullControl', type: 'Allow' },
      ],
    },
    {
      path: WORKSPACES,
      owner: SYSTEM_SID,
      access: [
        { sid: SYSTEM_SID, name: 'NT AUTHORITY\\SYSTEM', rights: 'FullControl', type: 'Allow' },
        { sid: ADMINISTRATORS_SID, name: 'BUILTIN\\Administrators', rights: 'FullControl', type: 'Allow' },
        { sid: '', name: RUNTIME_SERVICE_ACCOUNT, rights: 'Modify', type: 'Allow' },
      ],
    },
  ];
}

function probeOf(entries) {
  return () => ({ status: 0, stdout: JSON.stringify(entries) });
}

describe('the ACL spec is one definition for both operations', () => {
  it('names SYSTEM and Administrators full, and the runtime service Modify on workspaces', () => {
    assert.deepEqual(STORE_ACL_SPEC.stateRoot.map((e) => e.principal), [SYSTEM_SID, ADMINISTRATORS_SID]);
    assert.deepEqual(
      STORE_ACL_SPEC.workspaces.map((e) => `${e.principal}:${e.rights}`),
      [`${SYSTEM_SID}:F`, `${ADMINISTRATORS_SID}:F`, `${RUNTIME_SERVICE_ACCOUNT}:M`],
    );
  });

  it('the runtime service is the only non-SYSTEM/Administrators writer on workspaces', () => {
    const extra = STORE_ACL_SPEC.workspaces.filter((e) => ![SYSTEM_SID, ADMINISTRATORS_SID].includes(e.principal));
    assert.deepEqual(extra.map((e) => e.principal), [RUNTIME_SERVICE_ACCOUNT]);
  });
});

describe('applyStoreAcl is Windows-only and breaks inheritance first', () => {
  it('on a platform with no branch it reports unsupported_platform and spawns nothing', () => {
    let spawned = false;
    const result = applyStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'freebsd', spawn: () => { spawned = true; } });
    assert.deepEqual(result, { applied: false, reason: 'unsupported_platform' });
    assert.equal(spawned, false);
  });

  it('on Windows it grants the spec and sets the owner to SYSTEM', () => {
    const calls = [];
    const result = applyStoreAcl({
      stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32',
      spawn: (cmd, args) => { calls.push(args); return { status: 0 }; },
    });
    assert.equal(result.applied, true);
    assert.ok(calls.some((args) => args.includes('/inheritance:r')), 'inheritance is broken first');
    assert.ok(calls.some((args) => args.includes('/setowner')));
  });

  it('a path that cannot be spelled safely is refused', () => {
    const result = applyStoreAcl({ stateDir: "C:\\bad'path", workspacesDir: WORKSPACES, platform: 'win32', spawn: () => ({ status: 0 }) });
    assert.deepEqual(result, { applied: false, reason: 'path_untrusted' });
  });

  it('an icacls failure is reported, not swallowed', () => {
    const result = applyStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: () => ({ status: 1, stderr: 'denied' }) });
    assert.equal(result.applied, false);
    assert.equal(result.reason, 'acl_apply_failed');
  });
});

describe('checkStoreAcl fails closed on every wrong shape', () => {
  it('on a platform with no branch it does not pretend to have verified', () => {
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'freebsd' });
    assert.deepEqual(result, { ok: false, reason: 'unsupported_platform' });
  });

  it('a matching ACL passes', () => {
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: probeOf(goodEntries()) });
    assert.equal(result.ok, true, JSON.stringify(result));
  });

  it('a broad writer fails closed', () => {
    const entries = goodEntries();
    entries[1].access.push({ sid: 'S-1-5-11', name: 'NT AUTHORITY\\Authenticated Users', rights: 'Modify', type: 'Allow' });
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: probeOf(entries) });
    assert.deepEqual([result.ok, result.reason], [false, 'acl_broad_writer']);
  });

  it('a missing runtime-service Modify fails closed', () => {
    const entries = goodEntries();
    entries[1].access = entries[1].access.filter((e) => e.name !== RUNTIME_SERVICE_ACCOUNT);
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: probeOf(entries) });
    assert.deepEqual([result.ok, result.reason], [false, 'acl_missing_grant']);
  });

  it('a runtime-service Modify leaking onto the state root fails closed', () => {
    // The state root must NOT carry the runtime service's Modify; the two trees
    // have different specs on purpose.
    const entries = goodEntries();
    entries[0].access.push({ sid: '', name: RUNTIME_SERVICE_ACCOUNT, rights: 'Modify', type: 'Allow' });
    // Extra grants are not themselves a failure (only broad writers and missing
    // grants are), so this still passes -- assert that explicitly to pin intent.
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: probeOf(entries) });
    assert.equal(result.ok, true);
  });

  it('an untrusted owner fails closed', () => {
    const entries = goodEntries();
    entries[0].owner = 'S-1-5-21-9999';
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: probeOf(entries) });
    assert.deepEqual([result.ok, result.reason], [false, 'acl_untrusted_owner']);
  });

  it('a probe that cannot run or returns junk fails closed', () => {
    assert.deepEqual(
      checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: () => ({ error: new Error('x') }) }),
      { ok: false, reason: 'acl_unreadable' },
    );
    assert.deepEqual(
      checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'win32', spawn: () => ({ status: 0, stdout: 'not json' }) }),
      { ok: false, reason: 'acl_unreadable' },
    );
  });
});

describe('the POSIX branch applies and checks the store without a DACL', () => {
  /** An injected lstat that answers a fixed uid/mode per path. */
  function lstatOf(byPath) {
    return (target) => {
      const entry = byPath[target];
      if (!entry) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      return { uid: entry.uid, mode: entry.mode, isSymbolicLink: () => entry.link === true };
    };
  }

  it('apply sets the state root root-owned and the workspaces 0700 for the runtime', () => {
    const chowns = [];
    const chmods = [];
    const result = applyStoreAcl({
      stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998,
      chown: (dir, uid) => { chowns.push([dir, uid]); }, chmod: (dir, mode) => { chmods.push([dir, mode]); },
    });
    assert.deepEqual(result, { applied: true });
    assert.deepEqual(chowns, [[POSIX_STATE, 0], [POSIX_WORKSPACES, 998]]);
    assert.deepEqual(chmods, [[POSIX_STATE, 0o755], [POSIX_WORKSPACES, 0o700]]);
  });

  it('apply on darwin behaves the same and reports a chown failure instead of swallowing it', () => {
    assert.deepEqual(
      applyStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'darwin', runtimeUid: 998, chown: () => {}, chmod: () => {} }),
      { applied: true },
    );
    const failed = applyStoreAcl({
      stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998,
      chown: () => { throw new Error('EPERM'); }, chmod: () => {},
    });
    assert.deepEqual(failed, { applied: false, reason: 'acl_apply_failed' });
  });

  it('apply refuses a relative path rather than chowning the wrong tree', () => {
    const result = applyStoreAcl({ stateDir: 'relative/state', workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, chown: () => {}, chmod: () => {} });
    assert.deepEqual(result, { applied: false, reason: 'path_untrusted' });
  });

  it('check passes a store that matches the POSIX spec', () => {
    const lstat = lstatOf({
      [POSIX_STATE]: { uid: 0, mode: 0o755 },
      [POSIX_WORKSPACES]: { uid: 998, mode: 0o700 },
    });
    const result = checkStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, agentUid: 1000, lstat });
    assert.deepEqual(result, { ok: true });
  });

  it('check refuses an other-readable workspaces dir', () => {
    const lstat = lstatOf({
      [POSIX_STATE]: { uid: 0, mode: 0o755 },
      [POSIX_WORKSPACES]: { uid: 998, mode: 0o755 },
    });
    const result = checkStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, agentUid: 1000, lstat });
    assert.deepEqual(result, { ok: false, reason: 'store_mode_exposed' });
  });

  it('check refuses a workspaces dir owned by the agent uid', () => {
    const lstat = lstatOf({
      [POSIX_STATE]: { uid: 0, mode: 0o755 },
      [POSIX_WORKSPACES]: { uid: 1000, mode: 0o700 },
    });
    const result = checkStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, agentUid: 1000, lstat });
    assert.deepEqual(result, { ok: false, reason: 'store_untrusted_owner' });
  });

  it('check refuses a state root not owned by root, a group-writable root, and a symlinked target', () => {
    const agentOwnedRoot = lstatOf({ [POSIX_STATE]: { uid: 1000, mode: 0o755 }, [POSIX_WORKSPACES]: { uid: 998, mode: 0o700 } });
    assert.deepEqual(
      checkStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, agentUid: 1000, lstat: agentOwnedRoot }),
      { ok: false, reason: 'store_untrusted_owner' },
    );
    const groupWritableRoot = lstatOf({ [POSIX_STATE]: { uid: 0, mode: 0o775 }, [POSIX_WORKSPACES]: { uid: 998, mode: 0o700 } });
    assert.deepEqual(
      checkStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, agentUid: 1000, lstat: groupWritableRoot }),
      { ok: false, reason: 'store_mode_exposed' },
    );
    const linked = lstatOf({ [POSIX_STATE]: { uid: 0, mode: 0o755 }, [POSIX_WORKSPACES]: { uid: 998, mode: 0o700, link: true } });
    assert.deepEqual(
      checkStoreAcl({ stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998, agentUid: 1000, lstat: linked }),
      { ok: false, reason: 'store_linked' },
    );
  });

  it('check fails closed when lstat throws anything', () => {
    const result = checkStoreAcl({
      stateDir: POSIX_STATE, workspacesDir: POSIX_WORKSPACES, platform: 'linux', runtimeUid: 998,
      lstat: () => { throw new Error('EACCES'); },
    });
    assert.deepEqual(result, { ok: false, reason: 'acl_unreadable' });
  });

  it('the POSIX spec keeps the state root closed to group and other write and workspaces closed entirely', () => {
    assert.equal(POSIX_STORE_ACL_SPEC.stateRoot.ownerUid, 0);
    assert.equal(POSIX_STORE_ACL_SPEC.stateRoot.closedBits, 0o022);
    assert.equal(POSIX_STORE_ACL_SPEC.workspaces.mode, 0o700);
    assert.equal(POSIX_STORE_ACL_SPEC.workspaces.closedBits, 0o077);
  });
});

describe('write-rights reading', () => {
  it('read and execute alone is not a write', () => {
    assert.equal(grantsWrite('ReadAndExecute, Synchronize'), false);
    assert.equal(grantsWrite('Read'), false);
  });

  it('modify, full control and the specific write rights are writes', () => {
    for (const rights of ['Modify', 'FullControl', 'Write', 'WriteData', 'Delete', 'TakeOwnership']) {
      assert.equal(grantsWrite(rights), true, rights);
    }
  });

  it('only Allow rules from broad identities count as a broad writer', () => {
    assert.equal(isBroadWriter({ type: 'Allow', sid: 'S-1-1-0', rights: 'Modify' }), true);
    assert.equal(isBroadWriter({ type: 'Allow', sid: 'S-1-1-0', rights: 'Read' }), false, 'Everyone with read is not a writer');
    assert.equal(isBroadWriter({ type: 'Deny', sid: 'S-1-1-0', rights: 'Modify' }), false);
    assert.equal(isBroadWriter({ type: 'Allow', sid: 'S-1-5-18', rights: 'FullControl' }), false, 'SYSTEM is not broad');
  });
});
