'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2136 (#2122): the `durum` status command was the only user of two of the
// modules cli.js requires (lib/system-status-report and lib/cli-plugin-status).
// It moves to lib/cli-status-command.js unchanged, so cli.js requires one
// module instead of two -- the room the company-ingest move out of cli.js
// needed without raising the FANOUT ratchet.
//
// Its behaviour is already pinned to a digest recorded on main by
// test/cli-command-dispatch.test.js, and kernel-cli-audit-baseline-contract
// runs it for real; both must stay green. This file pins the move itself.

describe('the status command lives in lib/ (#2136)', () => {
  it('lib/cli-status-command.js exports the handler and the command table delegates to it', () => {
    const { runStatusCommand } = require('../lib/cli-status-command');
    assert.equal(typeof runStatusCommand, 'function');
    assert.equal(runStatusCommand.length, 1);
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli-command-handlers.js'), 'utf8');
    assert.match(source, /'durum': \(cli\) => runStatusCommand\(cli\),/);
  });

  it('cli.js no longer requires the two modules only the status command used', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
    assert.doesNotMatch(source, /require\('\.\/lib\/system-status-report'\)/);
    assert.doesNotMatch(source, /require\('\.\/lib\/cli-plugin-status'\)/);
  });

  it('the status module now carries both requires, so they moved rather than vanished', () => {
    // The fan-out ratchet itself is enforced by scripts/architecture-snapshot.js; an exact
    // count here would break on the next planned move out of cli.js.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli-status-command.js'), 'utf8');
    assert.match(source, /require\('\.\/system-status-report'\)/);
    assert.match(source, /require\('\.\/cli-plugin-status'\)/);
  });
});
