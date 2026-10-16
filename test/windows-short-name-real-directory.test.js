'use strict';

// A real directory reached through its Windows 8.3 short name (RUNNER~1, LONGNA~1)
// is still a real directory. The a2a, registry and receipt stores refuse symlinked
// or junctioned paths by comparing a path with its realpath; `fs.realpathSync.native`
// also expands short names, so the comparison refused every short-name path. GitHub's
// Windows runners hand out a short-name TEMP, which is how every A2A route answered
// 404 there. The symlink and junction refusals must not move.

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { describe, it, after } = require('node:test');

const { createA2aReplayStore } = require('../lib/a2a/replay-store');
const { createA2aTaskStore } = require('../lib/a2a/task-store');
const { createA2aDelegationAuditLog } = require('../lib/a2a/delegation-audit-log');
const { readReceiverAuthority } = require('../lib/a2a/exchange-route');
const { createRegistryRecordStore } = require('../lib/registry/registry-record-store');
const { isInsideSandbox } = require('../lib/sandbox-path-containment');

function shortNameOf(longPath) {
  const output = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${longPath}") do @echo %~sI`], {
    encoding: 'utf8',
    windowsVerbatimArguments: true,
  });
  return output.trim();
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-short-name-'));
const longDirectory = path.join(base, 'a-directory-name-longer-than-eight');
fs.mkdirSync(longDirectory);
const shortDirectory = process.platform === 'win32' ? shortNameOf(longDirectory) : longDirectory;
const skip = process.platform !== 'win32'
  ? 'short names exist only on Windows'
  : shortDirectory === longDirectory ? '8.3 short names are disabled on this volume' : false;

after(() => fs.rmSync(base, { recursive: true, force: true }));

describe('a real directory reached through its 8.3 short name', { skip }, () => {
  it('opens the a2a replay, task and delegation audit stores', () => {
    assert.doesNotThrow(() => createA2aReplayStore(shortDirectory));
    assert.doesNotThrow(() => createA2aTaskStore(shortDirectory));
    assert.doesNotThrow(() => createA2aDelegationAuditLog(shortDirectory));
  });

  it('opens the registry record store', () => {
    assert.doesNotThrow(() => createRegistryRecordStore(shortDirectory));
  });

  it('reads a receiver authority file under the short name', () => {
    fs.writeFileSync(path.join(longDirectory, 'authority.json'), '{"trusted":true}');
    assert.deepEqual(readReceiverAuthority(path.join(shortDirectory, 'authority.json')), { trusted: true });
  });

  it('classifies a planned child of a short-name sandbox root as inside it', () => {
    assert.equal(isInsideSandbox(path.join(shortDirectory, 'planned', 'artifact.txt'), shortDirectory), true);
  });

  it('still refuses a junction to that directory', () => {
    const junction = path.join(base, 'junction-to-directory');
    fs.symlinkSync(longDirectory, junction, 'junction');
    assert.throws(() => createA2aReplayStore(junction), /real directory/);
    assert.throws(() => createA2aTaskStore(junction), /real directory/);
    assert.throws(() => createA2aDelegationAuditLog(junction), /real directory/);
    assert.throws(() => createRegistryRecordStore(junction), /real directory/);
  });
});
