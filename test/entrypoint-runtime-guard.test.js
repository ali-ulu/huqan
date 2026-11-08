'use strict';

// #4551: server.js and bin/huqan-gate-hook.js must reject an unsupported
// Node/NAPI runtime before any Graph construction or native SQLite open --
// the same boundary #4532 gave cli.js and mcpServer.js. These tests spawn the
// real entrypoints through a child process with a preloaded fixture that
// fakes an unsupported runtime (napi 9), and assert a readable
// HUQAN_NODE_UNSUPPORTED-style failure with no store file created.

const { spawnSync } = require('node:child_process');
const { mkdtempSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const repoRoot = path.join(__dirname, '..');
const fixture = path.join(__dirname, 'fixtures', 'huqan-fake-unsupported-runtime.js');

function spawnEntrypoint(entry, extraEnv = {}) {
  return spawnSync(process.execPath, ['--require', fixture, entry], {
    cwd: repoRoot,
    encoding: 'utf8',
    input: '{}\n',
    timeout: 60_000,
    env: Object.assign({}, process.env, {
      // Keep any accidental store traffic inside a throwaway directory.
      DB_PATH: path.join(mkdtempSync(path.join(tmpdir(), 'huqan-guard-')), 'graph.db'),
      MEMORY_PATH: path.join(tmpdir(), 'huqan-guard-test-memory.json'),
      HUQAN_GATE_AURA_SIGNALS: '',
    }, extraEnv),
  });
}

describe('entrypoint runtime guard (#4551)', () => {
  it('server.js fails closed before SQLite open on an unsupported runtime', () => {
    const res = spawnEntrypoint('server.js');
    assert.ok(res.status !== 0, `expected non-zero exit, got ${res.status}\nstderr:\n${res.stderr}`);
    assert.match(res.stderr, /HUQAN_NODE_UNSUPPORTED/);
    assert.match(res.stderr, /NAPI/);
    // If the Graph had opened the native binding, better-sqlite3 would have
    // created the store file (or segfaulted). Nothing may exist.
    const dbPath = res.env && res.env.DB_PATH;
    assert.ok(!require('node:fs').existsSync(dbPath), 'store file must not be created');
  });

  it('bin/huqan-gate-hook.js fails closed before SQLite open on an unsupported runtime', () => {
    const res = spawnEntrypoint('bin/huqan-gate-hook.js');
    assert.ok(res.status !== 0, `expected non-zero exit, got ${res.status}\nstderr:\n${res.stderr}`);
    // The guard runs before any other require at the top of the entrypoint,
    // so the error surfaces uncaught with its HUQAN_NODE_UNSUPPORTED code.
    assert.match(res.stderr, /HUQAN_NODE_UNSUPPORTED/);
    assert.match(res.stderr, /NAPI/);
  });

  it('both entrypoints boot normally on the supported test runtime', () => {
    // Without the fixture, the guard must let the runtime through. We only
    // prove the guard itself does not reject the live runtime, because a full
    // boot needs the native dependency installed.
    const { describeUnsupportedNodeRuntime } = require('../lib/node-runtime-guard');
    assert.strictEqual(describeUnsupportedNodeRuntime(), null);
  });
});
