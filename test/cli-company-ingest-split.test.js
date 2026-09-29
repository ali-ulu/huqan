'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2136 (#2122): the `company-ingest` command handler was 147 of cli.js's 807
// lines -- one job, ingesting company knowledge from ten source kinds through
// the companyBrain and repoMemory capabilities. It moves to
// lib/cli-company-ingest.js unchanged, and the command table row delegates.
//
// Its behaviour -- every source, each with a failing capability, the unsupported
// source, non-object arguments and throwOnError -- is already pinned to digests
// recorded on main by test/cli-command-dispatch.test.js, which must stay green.
// This file pins the move itself.

describe('the company-ingest handler lives in lib/ (#2136)', () => {
  it('lib/cli-company-ingest.js exports the handler and the command table delegates to it', () => {
    const { runCompanyIngest } = require('../lib/cli-company-ingest');
    assert.equal(typeof runCompanyIngest, 'function');
    assert.equal(runCompanyIngest.length, 3);
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli-command-handlers.js'), 'utf8');
    assert.match(source, /'company-ingest': \(cli, args, opts\) => runCompanyIngest\(cli, args, opts\),/);
  });

  it('cli.js no longer holds the per-source ingest branches', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
    assert.doesNotMatch(source, /source === 'git-log'/);
    assert.doesNotMatch(source, /Desteklenmeyen kaynak/);
  });

  it('the handler reaches only public members of the command context', () => {
    // Line comments are dropped first: the module header names "cli.js", which is prose, not a member.
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'cli-company-ingest.js'), 'utf8')
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    const members = [...new Set([...source.matchAll(/\bcli\.([A-Za-z_]\w*)/g)].map((match) => match[1]))].sort();
    assert.deepEqual(members, ['ensureCompanyCapabilities', 'kernel']);
    assert.doesNotMatch(source, /\bthis\b/);
  });

  it('cli.js has left the over-800 band', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'cli.js');
    assert.ok(row && row.lines <= 800, JSON.stringify(row));
  });
});
