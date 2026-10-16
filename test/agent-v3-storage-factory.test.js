'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #2143 (#2118): AgentV3 built its own HuqanStorage when none was injected.
// That default -- and the dbPath rule it uses -- now lives in a composition-
// root module, lib/agent-v3-storage-factory.js. Behaviour is unchanged and
// pinned here: the default still opens its own SQLite handle on dbPath, and an
// injected storage still wins. `new Agent()` stays with #2117.

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function withTempDir(run) {
  // Realpath the scratch dir: the storage resolves an explicit dbPath to its
  // canonical spelling (resolveContainedPath), so dbPath assertions in this
  // file must use the same spelling. Under a symlinked tmpdir (macOS /var ->
  // /private/var, #2546) the raw spelling mismatches. Same convention as
  // cli.test.js, backupRestore.test.js and the adapter tests.
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2143-')));
  try { return run(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('agent.v3.js no longer constructs or requires HuqanStorage', () => {
  const source = read('agent.v3.js');
  assert.doesNotMatch(source, /new\s+HuqanStorage\s*\(/);
  assert.doesNotMatch(source, /require\(['"]\.\/storage['"]\)/);
  assert.match(source, /require\(['"]\.\/lib\/agent-v3-storage-factory['"]\)/);
});

test('the default database path follows the kernel graph, else the working directory', () => {
  const { defaultAgentV3DbPath } = require('../lib/agent-v3-storage-factory');
  const base = path.join(os.tmpdir(), 'huqan-2143-mem');
  assert.equal(defaultAgentV3DbPath({ graph: { memoryPath: `${base}.json` } }), `${base}.db`);
  assert.equal(defaultAgentV3DbPath({ graph: { memoryPath: `${base}.txt` } }), path.join(process.cwd(), 'memory.db'));
  assert.equal(defaultAgentV3DbPath(null), path.join(process.cwd(), 'memory.db'));
});

test('the factory builds HuqanStorage at the given dbPath', () => {
  const HuqanStorage = require('../storage');
  const { createDefaultAgentV3Storage } = require('../lib/agent-v3-storage-factory');
  withTempDir((dir) => {
    const store = createDefaultAgentV3Storage(null, { dbPath: path.join(dir, 'agent.db') });
    try {
      assert.ok(store instanceof HuqanStorage);
      assert.equal(store.dbPath, path.join(dir, 'agent.db'));
    } finally { store.close(); }
  });
});

test('AgentV3 still opens its own storage on dbPath by default and honours an injected one', () => {
  const HuqanStorage = require('../storage');
  const AgentV3 = require('../agent.v3');
  withTempDir((dir) => {
    const agent = new AgentV3({ kernel: null, baseAgent: {}, dbPath: path.join(dir, 'v3.db') });
    try {
      assert.ok(agent.storage instanceof HuqanStorage, 'default storage is a HuqanStorage');
      assert.equal(agent.storage.dbPath, path.join(dir, 'v3.db'));
    } finally { agent.storage.close(); }

    const injected = { sumAgentIterationsSince: () => 0 };
    const withInjected = new AgentV3({ kernel: null, baseAgent: {}, storage: injected });
    assert.equal(withInjected.storage, injected);
  });
});
