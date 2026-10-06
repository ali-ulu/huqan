'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #3101: cli.js required 24 distinct modules (FANOUT:24). Eight of them were
// used only by the command table: help, knowledge, capability, agent,
// approval, company-ingest, backup and status. The table moves to
// lib/cli-command-handlers.js unchanged, with those eight requires, so cli.js
// requires one module instead of eight and leaves the FANOUT tracker.
//
// Every command's calls and output are already pinned to digests recorded on
// main by test/cli-command-dispatch.test.js; that file must stay green. This
// file pins the move itself.

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const MOVED = [
  'cli-help', 'cli-knowledge-commands', 'cli-capability-commands', 'cli-agent-commands',
  'cli-approval-commands', 'cli-company-ingest', 'cli-backup-commands', 'cli-status-command',
];

describe('the CLI command table lives in lib/ (#3101)', () => {
  it('lib/cli-command-handlers.js builds a frozen, prototype-free table', () => {
    const { createCliCommandHandlers } = require('../lib/cli-command-handlers');
    const handlers = createCliCommandHandlers({ callMcpTool: () => null, createApprovalStoreFromKernel: () => null });
    assert.ok(Object.isFrozen(handlers));
    assert.equal(Object.getPrototypeOf(handlers), null);
    assert.equal(Object.keys(handlers).length, 43);
    assert.equal(typeof handlers.inference, 'function');
    assert.equal(handlers['yardım'](), require('../lib/cli-help').cliHelpText());
  });

  it('cli.js no longer requires the modules only the command table used', () => {
    const source = read('cli.js');
    for (const name of MOVED) assert.doesNotMatch(source, new RegExp(`require\\('\\./lib/${name}'\\)`), name);
    assert.match(source, /require\('\.\/lib\/cli-command-handlers'\)/);
  });

  it('cli.js has left the FANOUT tracker', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'cli.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('FANOUT')), JSON.stringify(row));
  });
});
