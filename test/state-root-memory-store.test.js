'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { resolveDefaultMemoryPath } = require('../lib/default-persistence-path');
const { resolvePersistencePaths } = require('../persistencePaths');

function tmpDir(prefix) {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

describe('HUQAN_STATE_ROOT redirects the default memory store (#4537)', () => {
  it('stateRootOverride resolves the override and null on absence/blank', () => {
    const { stateRootOverride } = require('../lib/huqan-state-root');
    assert.strictEqual(stateRootOverride({ HUQAN_STATE_ROOT: ' /tmp/x ' }), path.resolve('/tmp/x'));
    assert.strictEqual(stateRootOverride({}), null);
    assert.strictEqual(stateRootOverride({ HUQAN_STATE_ROOT: '   ' }), null);
  });

  it('resolveDefaultMemoryPath keeps its test-runner default despite the sandbox variable', () => {
    // In-process this file runs under `node --test`, where the sandbox's
    // HUQAN_STATE_ROOT is a harness fixture (#1846): the redirect is
    // production-only and the per-file temporary default must win. The
    // production branch is covered by the child-process test below.
    const stateRoot = tmpDir('huqan-state-root-store-');
    const memoryPath = resolveDefaultMemoryPath({ HUQAN_STATE_ROOT: stateRoot });
    assert.notStrictEqual(memoryPath, path.join(stateRoot, 'memory.json'));
    assert.ok(!memoryPath.startsWith(stateRoot));
    fs.rmSync(stateRoot, { recursive: true, force: true });
  });

  it('an explicitly named store directory still wins over the state root (#3669)', () => {
    const stateRoot = tmpDir('huqan-state-root-explicit-');
    const namedDir = tmpDir('huqan-state-root-named-');
    const memoryPath = resolveDefaultMemoryPath({
      HUQAN_STATE_ROOT: stateRoot,
      HUQAN_DB_PATH: path.join(namedDir, 'graph.db'),
    });
    assert.strictEqual(memoryPath, path.join(namedDir, 'memory.json'));
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(namedDir, { recursive: true, force: true });
  });

  it('under the test runner the sandbox HUQAN_STATE_ROOT does not capture the store', () => {
    // The sandbox (#1846) sets HUQAN_STATE_ROOT for every suite run; it is a
    // harness fixture, so the derived default keeps following the cwd here.
    // This asserts the guard from inside the runner this repo tests in.
    const dir = tmpDir('huqan-state-root-runner-');
    const previous = process.env.HUQAN_STATE_ROOT;
    process.env.HUQAN_STATE_ROOT = dir;
    try {
      const paths = resolvePersistencePaths({ rootDir: dir });
      assert.strictEqual(paths.memoryPath, path.join(dir, 'memory.json'));
      assert.strictEqual(paths.dbPath, path.join(dir, 'memory.db'));
    } finally {
      if (previous === undefined) delete process.env.HUQAN_STATE_ROOT;
      else process.env.HUQAN_STATE_ROOT = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a production process with HUQAN_STATE_ROOT writes the store there, not in cwd', () => {
    const repo = path.resolve(__dirname, '..');
    const stateRoot = tmpDir('huqan-state-root-e2e-');
    const cwd = tmpDir('huqan-state-root-cwd-');
    const script = `
      const path = require('node:path');
      const { Graph } = require(${JSON.stringify(path.join(repo, 'graph'))});
      const { resolvePersistencePaths } = require(${JSON.stringify(path.join(repo, 'persistencePaths'))});
      const graph = new Graph({ useSQLite: true });
      graph.addNode('n1', 'N');
      graph.save();
      graph.close();
      process.stdout.write(JSON.stringify(resolvePersistencePaths()));
    `;
    const run = (env) => spawnSync(process.execPath, ['-e', script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, NODE_TEST_CONTEXT: '', ...env },
    });
    let result;
    try {
      // With the override: memory.json and memory.db land in the state root.
      result = run({ HUQAN_STATE_ROOT: stateRoot });
      assert.strictEqual(result.status, 0, result.stderr);
      const paths = JSON.parse(result.stdout);
      assert.strictEqual(paths.memoryPath, path.join(stateRoot, 'memory.json'));
      assert.strictEqual(paths.dbPath, path.join(stateRoot, 'memory.db'));
      assert.ok(fs.existsSync(path.join(stateRoot, 'memory.json')), 'memory.json in the state root');
      assert.ok(fs.existsSync(path.join(stateRoot, 'memory.db')), 'memory.db in the state root');
      assert.ok(!fs.existsSync(path.join(cwd, 'memory.json')), 'nothing in the caller cwd');
      assert.ok(!fs.existsSync(path.join(cwd, 'memory.db')), 'no db in the caller cwd');

      // Without the override (the sandbox variable is blanked explicitly, the
      // blank is treated as absent): the local-first cwd default is unchanged.
      result = run({ HUQAN_STATE_ROOT: '' });
      assert.strictEqual(result.status, 0, result.stderr);
      const defaults = JSON.parse(result.stdout);
      assert.strictEqual(defaults.memoryPath, path.join(cwd, 'memory.json'));
      assert.strictEqual(defaults.dbPath, path.join(cwd, 'memory.db'));
    } finally {
      fs.rmSync(stateRoot, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });
});
