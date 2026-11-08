'use strict';

// #4551: server.js and bin/huqan-gate-hook.js must reject an unsupported
// Node/NAPI runtime before any Graph construction or native SQLite open --
// the same boundary #4532 gave cli.js and mcpServer.js. These tests spawn the
// real entrypoints through a child process with a preloaded fixture that
// fakes an unsupported runtime (napi 9), and assert a readable
// HUQAN_NODE_UNSUPPORTED-style failure with no store file created.

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'huqan-fake-unsupported-runtime.js');

// Runs one entrypoint against isolated, named store destinations and returns
// both the run and the paths it was told to use. The assertions then check real
// files: `spawnSync` does not hand back `env`, so a check that read the child's
// environment would pass no matter what the child created.
function spawnEntrypoint(entry) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'huqan-guard-'));
  const dbPath = path.join(directory, 'graph.db');
  const memoryPath = path.join(directory, 'memory.json');
  const receiptLog = path.join(directory, 'receipts.jsonl');
  const result = spawnSync(process.execPath, [
    '--require', fixture, entry,
    // The hook reads its store and receipt destinations as arguments
    // (lib/gate-hook-evaluate.js); the bare DB_PATH/MEMORY_PATH names are not
    // read by the runtime, so they cannot isolate it.
    '--db-path', dbPath,
    '--memory-path', memoryPath,
    '--receipt-log', receiptLog,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: '{}\n',
    timeout: 60_000,
    env: Object.assign({}, process.env, {
      // The server reads the canonical names (lib/kernel-factory.js); the
      // legacy aliases are cleared so an inherited AXIOM_* cannot redirect the
      // child's store to a path this test does not check.
      HUQAN_DB_PATH: dbPath,
      HUQAN_MEMORY_PATH: memoryPath,
      AXIOM_DB_PATH: undefined,
      AXIOM_MEMORY_PATH: undefined,
      HUQAN_GATE_AURA_SIGNALS: '',
    }),
  });
  return { dbPath, memoryPath, receiptLog, result };
}

describe('entrypoint runtime guard (#4551)', () => {
  it('server.js fails closed before SQLite open on an unsupported runtime', () => {
    const { dbPath, memoryPath, result } = spawnEntrypoint('server.js');
    assert.ok(result.status !== 0, `expected non-zero exit, got ${result.status}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /HUQAN_NODE_UNSUPPORTED/);
    assert.match(result.stderr, /NAPI/);
    // If the Graph had opened the native binding, better-sqlite3 would have
    // created the store file (or segfaulted). Nothing may exist.
    assert.ok(!fs.existsSync(dbPath), 'store file must not be created');
    assert.ok(!fs.existsSync(memoryPath), 'memory file must not be created');
  });

  it('bin/huqan-gate-hook.js fails closed before SQLite open on an unsupported runtime', () => {
    const { dbPath, memoryPath, receiptLog, result } = spawnEntrypoint('bin/huqan-gate-hook.js');
    assert.ok(result.status !== 0, `expected non-zero exit, got ${result.status}\nstderr:\n${result.stderr}`);
    // The guard runs before any other require at the top of the entrypoint,
    // so the error surfaces uncaught with its HUQAN_NODE_UNSUPPORTED code.
    assert.match(result.stderr, /HUQAN_NODE_UNSUPPORTED/);
    assert.match(result.stderr, /NAPI/);
    // The hook reaches the store and the receipt trail through the paths it was
    // given; a guard that ran after either open would leave one behind.
    assert.ok(!fs.existsSync(dbPath), 'store file must not be created');
    assert.ok(!fs.existsSync(memoryPath), 'memory file must not be created');
    assert.ok(!fs.existsSync(receiptLog), 'receipt log must not be created');
  });

  it('both entrypoints boot normally on the supported test runtime', () => {
    // Without the fixture, the guard must let the runtime through. We only
    // prove the guard itself does not reject the live runtime, because a full
    // boot needs the native dependency installed.
    const { describeUnsupportedNodeRuntime } = require('../lib/node-runtime-guard');
    assert.strictEqual(describeUnsupportedNodeRuntime(), null);
  });
});
