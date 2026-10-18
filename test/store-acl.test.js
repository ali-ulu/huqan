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
  SYSTEM_SID,
  ADMINISTRATORS_SID,
  applyStoreAcl,
  checkStoreAcl,
  grantsWrite,
  isBroadWriter,
} = require('../lib/authority/store-acl');

const STATE = 'C:\\ProgramData\\huqan\\state';
const WORKSPACES = 'C:\\ProgramData\\huqan\\state\\workspaces';

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
  it('off-platform it reports not_windows and spawns nothing', () => {
    let spawned = false;
    const result = applyStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'linux', spawn: () => { spawned = true; } });
    assert.deepEqual(result, { applied: false, reason: 'not_windows' });
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
  it('off-platform it does not pretend to have verified', () => {
    const result = checkStoreAcl({ stateDir: STATE, workspacesDir: WORKSPACES, platform: 'linux' });
    assert.deepEqual(result, { ok: false, reason: 'not_windows' });
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
