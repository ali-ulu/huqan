'use strict';

// The `huqan store` CLI surface (ADR-018 §2, #3998). The command core is tested
// in store-migrate.test.js; here the wrapper: argv shape, the elevation refusal
// reaching the operator as a message, and the JSON form.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCommand } = require('../lib/command-parser');
const { runStoreCommand, profileStoreDir, MIGRATE_USAGE } = require('../lib/cli-store-commands');

function tempDir(t, prefix = 'huqan-cli-store-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('the parser reaches the store command', () => {
  it('`store migrate` parses to a non-rollback migration', () => {
    const { command, args } = parseCommand('store migrate');
    assert.equal(command, 'store');
    assert.deepEqual([args.rollback, args.workspace], [false, '']);
  });

  it('`store migrate --rollback` sets rollback', () => {
    assert.equal(parseCommand('store migrate --rollback').args.rollback, true);
  });

  it('`store migrate --workspace <dir>` keeps the path verbatim, spaces included', () => {
    const { args } = parseCommand('store migrate --workspace /tmp/a b c');
    assert.equal(args.workspace, '/tmp/a b c');
  });

  it('bare `store` asks for help', () => {
    assert.deepEqual(parseCommand('store').args, { help: true });
  });
});

describe('the store command refuses without elevation', () => {
  it('a non-elevated migration returns a refusal message, not a throw', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const text = runStoreCommand({ workspace }, {}, {
      isElevated: false,
      stateRoot,
      resolvePaths: () => ({ memoryPath: path.join(workspace, 'memory.json') }),
    });
    assert.match(text, /refused/i);
    assert.match(text, /STORE_MIGRATE_NOT_ELEVATED/);
  });

  it('the JSON form reports ok:false and the reason', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const out = runStoreCommand({ workspace }, { json: true }, {
      isElevated: false,
      stateRoot,
      resolvePaths: () => ({ memoryPath: path.join(workspace, 'memory.json') }),
    });
    assert.equal(out.ok, false);
    assert.equal(out.reason, 'STORE_MIGRATE_NOT_ELEVATED');
    assert.equal(out.workspaceRoot, path.resolve(workspace));
  });

  it('bare `store` prints the usage line', () => {
    assert.equal(runStoreCommand({ help: true }, {}, { isElevated: true }), MIGRATE_USAGE);
  });
});

describe('profileStoreDir resolves where the runtime keeps the store today', () => {
  it('is the directory of the resolved memory path', () => {
    const seen = [];
    const dir = profileStoreDir('/srv/ws', (opts) => {
      seen.push(opts.rootDir);
      return { memoryPath: '/srv/ws/memory.json' };
    });
    assert.equal(dir, path.resolve('/srv/ws'));
    assert.deepEqual(seen, ['/srv/ws']);
  });
});

describe('a non-elevated rollback is refused too', () => {
  it('names the elevation requirement', (t) => {
    const workspace = tempDir(t);
    const stateRoot = tempDir(t);
    const text = runStoreCommand({ rollback: true, workspace }, {}, {
      isElevated: false,
      stateRoot,
      resolvePaths: () => ({ memoryPath: path.join(workspace, 'memory.json') }),
    });
    assert.match(text, /refused/i);
    assert.match(text, /elevated/i);
  });
});
