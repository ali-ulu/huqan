'use strict';

/**
 * #1579: no test may write persistence into the repository root.
 *
 * The suite shares one working directory, so a default persistence path is a
 * shared mutable store. That is not only slow (a 15 MB accumulated mutation
 * journal cost 782 ms per learn against 4 ms isolated) -- it made a
 * fail-closed security assertion unreliable: another test writing a node
 * called `n1` into the shared store turned
 * `pre-site-refusal-survives-audit-failure` red with nothing wrong in the code.
 *
 * A contract test that greps for `new Kernel({})` would miss the constructions
 * that reach the default through a helper, so this asserts the behaviour
 * instead: the default itself refuses the repository root under the runner.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const Graph = require('../graph');
const Agent = require('../agent');
const {
  DEFAULT_MEMORY_FILENAME,
  isInsideRepo,
  isTestRunner,
  resolveDefaultMemoryPath,
} = require('../lib/default-persistence-path');

const REPO_ROOT = path.resolve(__dirname, '..');

// The files a repo-root default would leave behind, including the siblings
// derived from it (#1025's layout rule).
const ROOT_ARTEFACTS = Object.freeze([
  'memory.json',
  'memory.db',
  'memory.mutations.json',
  'memory.embeddings.json',
]);

test('this suite runs under the test runner, so the guard is actually armed', () => {
  // Without this the rest of the file would pass vacuously.
  assert.equal(isTestRunner(), true);
});

test('a kernel given no path does not write into the repository root', () => {
  const kernel = new Kernel({ noLoad: true, loadPlugins: false });
  assert.equal(isInsideRepo(kernel.graph.memoryPath), false, kernel.graph.memoryPath);
  kernel.learn('default persistence isolation contract');
  for (const artefact of ROOT_ARTEFACTS) {
    assert.equal(
      fs.existsSync(path.join(REPO_ROOT, artefact)),
      false,
      `${artefact} was written into the repository root by a default-path kernel`,
    );
  }
});

test('an agent given no memory path does not write into the repository root', () => {
  const kernel = new Kernel({ noLoad: true, loadPlugins: false });
  const agent = new Agent({ kernel });
  assert.equal(isInsideRepo(agent.memoryPath), false, agent.memoryPath);
  agent.memory.goals.push({ goal: 'agent default isolation' });
  agent._saveMemory();
  assert.equal(
    fs.existsSync(path.join(REPO_ROOT, 'agent.memory.json')),
    false,
    'agent.memory.json was written into the repository root by a default-path agent',
  );
});

test('noLoad does not make a default path safe -- it skips the read, not the write', () => {
  // The distinction that kept this bug alive: every unisolated construction in
  // the suite passed `noLoad: true` and still wrote to the shared root.
  const graph = new Graph({ noLoad: true, useSQLite: false });
  assert.equal(isInsideRepo(graph.memoryPath), false, graph.memoryPath);
});

test('a graph given no path does not write into the repository root', () => {
  const graph = new Graph({ useSQLite: true });
  assert.equal(isInsideRepo(graph.memoryPath), false, graph.memoryPath);
});

test('constructions in one run share a store, so intra-file state still works', () => {
  const first = new Graph({ noLoad: true, useSQLite: false });
  const second = new Graph({ noLoad: true, useSQLite: false });
  assert.equal(first.memoryPath, second.memoryPath);
});

test('a test that already isolated its working directory keeps cwd semantics', () => {
  // The CLI's default must follow cwd; cli.test.js asserts that directly. The
  // redirect only replaces a default that would land inside the repository.
  const cwd = process.cwd();
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-default-path-cwd-'));
  try {
    process.chdir(elsewhere);
    assert.equal(resolveDefaultMemoryPath(), DEFAULT_MEMORY_FILENAME);
  } finally {
    process.chdir(cwd);
  }
});

test('an explicit path is never redirected', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-default-path-explicit-'));
  const explicit = path.join(dir, 'memory.json');
  const graph = new Graph({ noLoad: true, useSQLite: false, memoryPath: explicit });
  assert.equal(graph.memoryPath, explicit);
});
