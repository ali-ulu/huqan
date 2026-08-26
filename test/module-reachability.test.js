'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  PRODUCTION_ENTRY_POINTS,
  NON_RUNTIME_PREFIXES,
  CONSUMER_ENTRY_POINTS,
  TEST_ONLY_FILES,
  STRUCTURAL_FILES,
  NOT_YET_WIRED,
  analyzeReachability,
} = require('../lib/module-reachability');

const REPO_ROOT = path.join(__dirname, '..');

// ─── the invariant ───────────────────────────────────────────────────────────

test('no source file is unreachable without being classified', () => {
  const { unacknowledged } = analyzeReachability({ root: REPO_ROOT });
  assert.deepEqual(unacknowledged, [],
    `these files are not reachable from any production entry point and are not classified.\n`
    + `Either wire one up, or add it to NOT_YET_WIRED in lib/module-reachability.js with a reason:\n  `
    + unacknowledged.join('\n  '));
});

test('no acknowledgement is stale', () => {
  const { staleAcknowledgements } = analyzeReachability({ root: REPO_ROOT });
  assert.deepEqual(staleAcknowledgements, [],
    `these files are listed as not-yet-wired but are now reachable (or gone). Remove them from `
    + `NOT_YET_WIRED so the list keeps meaning something:\n  ${staleAcknowledgements.join('\n  ')}`);
});

test('every acknowledgement states a reason', () => {
  for (const [file, reason] of Object.entries(NOT_YET_WIRED)) {
    assert.equal(typeof reason, 'string', `${file} needs a reason`);
    assert.ok(reason.trim().length > 15, `${file}'s reason is too thin to review: "${reason}"`);
  }
});

test('acknowledgement reasons cite durable decisions, not issue lifecycle', () => {
  for (const [file, reason] of Object.entries(NOT_YET_WIRED)) {
    assert.doesNotMatch(reason, /#\d+/, `${file} must cite a durable decision rather than an issue number`);
  }
});

// ─── the analysis itself ─────────────────────────────────────────────────────

test('the production entry points are actually reachable', () => {
  const { reachable } = analyzeReachability({ root: REPO_ROOT });
  for (const entry of PRODUCTION_ENTRY_POINTS) {
    assert.ok(reachable.includes(entry), `${entry} should be in its own reachable set`);
  }
});

test('consumer entry dependencies are walked', () => {
  const { reachable } = analyzeReachability({ root: REPO_ROOT });
  for (const entry of CONSUMER_ENTRY_POINTS) assert.ok(reachable.includes(entry));
  assert.ok(reachable.includes('lib/huqan-package-format.js'));
});

test('repository examples are explicit non-runtime artifacts', () => {
  assert.deepEqual(NON_RUNTIME_PREFIXES, ['examples/']);
  const { unacknowledged, unreachable } = analyzeReachability({ root: REPO_ROOT });
  assert.ok(unreachable.includes('examples/observability-client.js'));
  assert.equal(unacknowledged.includes('examples/observability-client.js'), false);
});

test('test-only and structural files are classified outside the pending-work list', () => {
  for (const file of [...TEST_ONLY_FILES, ...STRUCTURAL_FILES]) {
    assert.equal(Object.hasOwn(NOT_YET_WIRED, file), false);
  }
  assert.ok(TEST_ONLY_FILES.includes('lib/self-test-oracle.js'));
  assert.ok(STRUCTURAL_FILES.includes('lib/causal/index.js'));
});

test('standalone entry dependencies are walked', () => {
  const { reachable } = analyzeReachability({ root: REPO_ROOT });
  assert.ok(reachable.includes('causalSimulator.js'));
});

test('core runtime modules are reachable, so the walk is not trivially empty', () => {
  const { reachable } = analyzeReachability({ root: REPO_ROOT });
  for (const file of ['graph.js', 'lib/tool-call-gate.js', 'lib/mcp-gate-adapter.js']) {
    assert.ok(reachable.includes(file), `${file} must be reachable; if not, the walk is broken`);
  }
});

test('dynamically loaded plugins are not reported as unreachable', () => {
  // plugin.js loads these with readdirSync, so a static graph cannot see them.
  const { unacknowledged } = analyzeReachability({ root: REPO_ROOT });
  assert.equal(unacknowledged.some((file) => file.startsWith('plugins/')), false);
});

test('adapters reached only through plugins count as reachable', () => {
  const { reachable } = analyzeReachability({ root: REPO_ROOT });
  assert.ok(reachable.some((file) => file.startsWith('adapters/')),
    'adapters are required by plugins; treating plugins as entry points should reach them');
});

test('the gates wired into the MCP adapter are reachable', () => {
  const { reachable } = analyzeReachability({ root: REPO_ROOT });
  for (const gate of [
    'lib/command-exec-gate.js',
    'lib/data-egress-gate.js',
    'lib/cross-workspace-access-gate.js',
    'lib/agent-loop-budget-gate.js',
  ]) {
    assert.ok(reachable.includes(gate), `${gate} is wired and must be reachable`);
  }
});

// ─── the checker actually detects a new unreachable module ───────────────────

test('an unclassified unreachable file is reported', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  try {
    fs.writeFileSync(path.join(root, 'cli.js'), "require('./used');\n");
    fs.writeFileSync(path.join(root, 'used.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'orphan.js'), 'module.exports = {};\n');

    const { reachable, unreachable, unacknowledged } = analyzeReachability({ root });

    assert.ok(reachable.includes('used.js'), 'a required file is reachable');
    assert.ok(unreachable.includes('orphan.js'), 'an unrequired file is unreachable');
    assert.ok(unacknowledged.includes('orphan.js'),
      'an unreachable, unclassified file must be reported -- this is the whole point of the check');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a file reached only through a nested require is still reachable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  try {
    fs.mkdirSync(path.join(root, 'lib'));
    fs.writeFileSync(path.join(root, 'cli.js'), "require('./lib/a');\n");
    fs.writeFileSync(path.join(root, 'lib', 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(root, 'lib', 'b.js'), 'module.exports = {};\n');

    const { unreachable } = analyzeReachability({ root });
    assert.equal(unreachable.includes('lib/b.js'), false, 'transitive requires must be followed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a double-quoted require is followed too', () => {
  // The walk used to only match single-quoted require() calls, so a file
  // reached exclusively through require("./x") was reported unreachable (#445).
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  try {
    fs.writeFileSync(path.join(root, 'cli.js'), 'require("./quoted");\n');
    fs.writeFileSync(path.join(root, 'quoted.js'), 'module.exports = {};\n');

    const { reachable, unreachable } = analyzeReachability({ root });

    assert.ok(reachable.includes('quoted.js'), 'require("...") must be followed like require(\'...\')');
    assert.equal(unreachable.includes('quoted.js'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a require cycle does not hang the walk', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  try {
    fs.writeFileSync(path.join(root, 'cli.js'), "require('./a');\n");
    fs.writeFileSync(path.join(root, 'a.js'), "require('./b');\n");
    fs.writeFileSync(path.join(root, 'b.js'), "require('./a');\n");

    const { unreachable } = analyzeReachability({ root });
    assert.equal(unreachable.length, 0, 'the cycle should be fully walked and terminate');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('test files are not counted as source', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reach-'));
  try {
    fs.writeFileSync(path.join(root, 'cli.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'thing.test.js'), 'module.exports = {};\n');

    const { unreachable } = analyzeReachability({ root });
    assert.equal(unreachable.includes('thing.test.js'), false,
      'a test file being unreachable from cli.js is not a finding');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
