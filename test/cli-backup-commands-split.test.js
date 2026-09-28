'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2136 (#2122): the `backup` and `restore` command rows were the only users of
// two modules cli.js requires (backupRestore.js and lib/sqlite-restore). They
// move to lib/cli-backup-commands.js unchanged, taking the backupRestore
// require with them, so moving company-ingest out of cli.js in the same change
// does not raise cli.js's fan-out.
//
// Their behaviour is pinned to digests recorded on main by
// test/cli-command-dispatch.test.js and exercised for real by the restore and
// mutation-gate contract tests; all of them must stay green. This file pins
// the move itself.

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', ...parts), 'utf8');
const code = (text) => text.split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n');

describe('the backup and restore commands live in lib/ (#2136)', () => {
  it('lib/cli-backup-commands.js exports both handlers and the command table delegates to them', () => {
    const { runBackupCommand, runRestoreCommand } = require('../lib/cli-backup-commands');
    assert.equal(runBackupCommand.length, 1);
    assert.equal(runRestoreCommand.length, 3);
    const source = read('lib', 'cli-command-handlers.js');
    assert.match(source, /'backup': \(cli\) => runBackupCommand\(cli\),/);
    assert.match(source, /'restore': \(cli, args, opts\) => runRestoreCommand\(cli, args, opts\),/);
  });

  it('cli.js no longer requires backupRestore or sqlite-restore', () => {
    const source = code(read('cli.js'));
    assert.doesNotMatch(source, /require\('\.\/backupRestore'\)/);
    assert.doesNotMatch(source, /require\('\.\/lib\/sqlite-restore'\)/);
  });

  it('the moved module carries both requires, and sqlite-restore stays loaded only inside restore', () => {
    const source = code(read('lib', 'cli-backup-commands.js'));
    assert.match(source, /^const \{[^}]+\} = require\('\.\.\/backupRestore'\);$/m);
    const restoreStart = source.indexOf('function runRestoreCommand(');
    assert.ok(restoreStart > 0, 'runRestoreCommand is defined');
    assert.equal(source.indexOf("require('./sqlite-restore')"), source.indexOf("require('./sqlite-restore')", restoreStart));
  });

  it('the handlers reach only public members of the command context', () => {
    const source = code(read('lib', 'cli-backup-commands.js'));
    const members = [...new Set([...source.matchAll(/\bcli\.([A-Za-z_]\w*)/g)].map((match) => match[1]))].sort();
    assert.deepEqual(members, ['agent', 'backupOptions', 'commitCliMutation', 'kernel']);
    assert.doesNotMatch(source, /\bthis\b/);
  });
});
