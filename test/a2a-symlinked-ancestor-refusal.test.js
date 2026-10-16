'use strict';

// The A2A receiver refuses an authority file or a replay directory reached
// through a symlinked directory. The comment on readReceiverAuthority states
// why: a symlinked parent is a way to swap the trust root without touching the
// configured path.
//
// On macOS os.tmpdir() lives below /var -> /private/var, so every A2A test that
// built its sandbox from the raw temp path was refused for exactly this reason
// and went red on the macOS shards. Those tests now build under the real temp
// path. This file keeps the refusal itself under test, so a later change that
// made the check accept linked paths would fail here rather than pass silently.
// On Windows the link is a junction, which needs no elevation.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { CANONICAL_WORKSPACE, createA2aExchangeBoundary } = require('../lib/a2a/exchange-route');
const { createA2aReplayStore } = require('../lib/a2a/replay-store');
const { createA2aTaskStore } = require('../lib/a2a/task-store');
const { createA2aDelegationAuditLog } = require('../lib/a2a/delegation-audit-log');

function linkedSandbox(t) {
  const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-a2a-linked-'));
  const real = path.join(base, 'real');
  // One directory below the link, as /var is several levels above a macOS temp
  // file: the file's own parent is a real directory, so only the real-path
  // comparisons can see the link.
  const sub = path.join(real, 'sub');
  const replayDirectory = path.join(sub, 'replay');
  fs.mkdirSync(replayDirectory, { recursive: true });
  const authorityFile = path.join(sub, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(buildFixture(CANONICAL_WORKSPACE).authority), 'utf8');

  const link = path.join(base, 'link');
  fs.symlinkSync(real, link, 'junction');
  t.after(() => {
    // Remove the link itself first, so the recursive delete cannot walk it.
    try { fs.rmdirSync(link); } catch (_) { try { fs.unlinkSync(link); } catch (__) { /* already gone */ } }
    fs.rmSync(base, { recursive: true, force: true });
  });
  return {
    real: { authorityFile, replayDirectory },
    linked: {
      authorityFile: path.join(link, 'sub', 'authority.json'),
      replayDirectory: path.join(link, 'sub', 'replay'),
    },
  };
}

test('a2a boundary: builds from real paths and refuses the same files reached through a linked ancestor', (t) => {
  const sandbox = linkedSandbox(t);
  assert.ok(createA2aExchangeBoundary(sandbox.real), 'the real paths are a working deployment');
  assert.equal(createA2aExchangeBoundary(sandbox.linked), null, 'a linked ancestor must not be accepted');
  // The authority check on its own: a real replay directory must not carry a
  // linked authority file through.
  assert.equal(createA2aExchangeBoundary({
    authorityFile: sandbox.linked.authorityFile,
    replayDirectory: sandbox.real.replayDirectory,
  }), null, 'a linked authority file must be refused even with a real replay directory');
});

test('a2a stores: each refuses a directory reached through a linked ancestor', (t) => {
  const sandbox = linkedSandbox(t);
  assert.throws(() => createA2aReplayStore(sandbox.linked.replayDirectory));
  assert.throws(() => createA2aTaskStore(sandbox.linked.replayDirectory));
  assert.throws(() => createA2aDelegationAuditLog(sandbox.linked.replayDirectory));
  // And accepts the same directory by its real path.
  assert.doesNotThrow(() => createA2aReplayStore(sandbox.real.replayDirectory));
});
