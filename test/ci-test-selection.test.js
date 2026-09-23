'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const {
  buildDependencyIndex,
  deriveTestsForChange,
  isJavaScript,
  isTestFile,
  listTrackedFiles,
  quotedLiterals,
  reachableFrom,
  resolveNamedFile,
  resolveRequest,
  stripComments,
} = require('../scripts/ci-test-selection');

const REPO_ROOT = path.join(__dirname, '..');
const index = buildDependencyIndex();

test('comment stripping keeps a commented-out require from becoming an edge', () => {
  assert.equal(stripComments("// require('./ghost')\nrequire('./real')").includes('ghost'), false);
  assert.equal(stripComments("/* require('./ghost') */ require('./real')").includes('ghost'), false);
  // A URL inside a string is not a line comment, so its tail survives.
  assert.equal(stripComments("const u = 'https://example.com/x';").includes('example.com'), true);
});

test('require resolution only accepts tracked relative requests', () => {
  const known = new Set(['lib/a.js', 'lib/b/index.js', 'lib/c']);
  assert.equal(resolveRequest('lib/x.js', './a', known), 'lib/a.js');
  assert.equal(resolveRequest('lib/x.js', './b', known), 'lib/b/index.js');
  assert.equal(resolveRequest('lib/x.js', './c', known), 'lib/c');
  assert.equal(resolveRequest('lib/x.js', 'node:fs', known), null);
  assert.equal(resolveRequest('lib/x.js', 'express', known), null);
  assert.equal(resolveRequest('lib/x.js', './missing', known), null);
});

test('named-file resolution is anchored and refuses ambiguous stems', () => {
  const known = new Set(['bin/hook.js', 'lib/only-here.js', 'a/dup.js', 'b/dup.js']);
  const basenames = new Map([
    ['hook.js', ['bin/hook.js']],
    ['only-here.js', ['lib/only-here.js']],
    ['dup.js', ['a/dup.js', 'b/dup.js']],
  ]);
  assert.equal(resolveNamedFile('bin/hook.js', known, basenames), 'bin/hook.js');
  assert.equal(resolveNamedFile('hook.js', known, basenames), 'bin/hook.js');
  assert.equal(resolveNamedFile('only-here', known, basenames), 'lib/only-here.js');
  // Ambiguous basename selects nothing rather than guessing.
  assert.equal(resolveNamedFile('dup.js', known, basenames), null);
  assert.equal(resolveNamedFile('dup', known, basenames), null);
  // Prose and short words are not paths.
  assert.equal(resolveNamedFile('some sentence here', known, basenames), null);
  assert.equal(resolveNamedFile('abc', known, basenames), null);
});

test('quoted literal extraction reads single, double and backtick strings', () => {
  const literals = quotedLiterals("a('one'); b(\"two\"); c(`three`);");
  assert.deepEqual(literals, ['one', 'two', 'three']);
});

test('reachability follows transitive require edges', () => {
  const graph = new Map([
    ['a', ['b']],
    ['b', ['c']],
    ['c', []],
    ['d', ['a']],
  ]);
  assert.deepEqual([...reachableFrom('a', graph)].sort(), ['a', 'b', 'c']);
  assert.deepEqual([...reachableFrom('c', graph)].sort(), ['c']);
  assert.deepEqual([...reachableFrom('d', graph)].sort(), ['a', 'b', 'c', 'd']);
});

test('a require cycle does not hang reachability', () => {
  const graph = new Map([['a', ['b']], ['b', ['a']]]);
  assert.deepEqual([...reachableFrom('a', graph)].sort(), ['a', 'b']);
});

test('test file detection matches the shard manifest vocabulary', () => {
  assert.equal(isTestFile('test/anything.js'), true);
  assert.equal(isTestFile('test/fixtures/input.json'), false);
  assert.equal(isTestFile('lib/thing.test.js'), true);
  assert.equal(isTestFile('lib/thing.spec.js'), true);
  assert.equal(isTestFile('lib/thing-test.js'), true);
  assert.equal(isTestFile('lib/thing_test.js'), true);
  assert.equal(isTestFile('test-thing.js'), true);
  assert.equal(isTestFile('lib/thing.js'), false);
  assert.equal(isTestFile('docs/thing.md'), false);
});

test('the index is built from tracked files and excludes untracked disk files', () => {
  const tracked = listTrackedFiles(REPO_ROOT);
  assert.ok(tracked.includes('lib/module-reachability.js'));
  assert.ok(tracked.includes('scripts/ci-impact-plan.js'));
  assert.ok(index.tests.length > 500);
  // Every reverse-index key is a tracked file.
  for (const file of index.reverse.keys()) assert.ok(index.known.has(file));
});

test('deriveTestsForChange reports the changed file that pulled each test in', () => {
  const derived = deriveTestsForChange(['lib/module-reachability.js'], index);
  assert.ok(derived.size > 0);
  const [testFile, reasons] = [...derived.entries()][0];
  assert.ok(index.known.has(testFile));
  assert.ok(reasons.some((reason) => reason.startsWith('depends on ') || reason === 'changed test file'));
});

test('a changed test file selects itself even with no dependants', () => {
  const derived = deriveTestsForChange(['test/module-reachability.test.js'], index);
  assert.equal(derived.get('test/module-reachability.test.js')[0], 'changed test file');
});

// The regression this module exists for. #2505 C changed the identity gate's
// default and broke five suites; the glob table selected none of them.
test('#2505 C change set selects every suite that regressed on main', () => {
  const changed = ['lib/external-action-identity.js', 'test/external-action-identity.test.js'];
  const derived = deriveTestsForChange(changed, index);
  const selected = new Set([...derived.keys()]);
  const regressed = [
    'test/external-action-identity-signing.test.js',
    'test/external-action-hook-cli.test.js',
    'test/external-action-receipt-identity-material.test.js',
    'test/external-action-adapter-generator.test.js',
    'test/benign-false-block-rate.test.js',
  ];
  const missed = regressed.filter((file) => !selected.has(file));
  assert.deepEqual(missed, [], `dependency-derived selection missed: ${missed.join(', ')}`);
});

test('subprocess entry points are reachable through their named path', () => {
  // test/external-action-hook-cli.test.js spawns this file; a require graph
  // alone cannot see that, which is why named-file edges exist.
  const derived = deriveTestsForChange(['bin/huqan-gate-hook.js'], index);
  assert.ok(derived.has('test/external-action-hook-cli.test.js'));
});

test('a .js name is an edge only from a file that starts processes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mention-'));
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(root, 'bin', 'tool.js'), 'module.exports = 2;\n');
  fs.writeFileSync(path.join(root, 'runner.test.js'),
    "const { execFileSync } = require('node:child_process');\nexecFileSync('bin/tool.js');\n");
  fs.writeFileSync(path.join(root, 'talker.test.js'),
    "// mentions bin/tool.js in prose without running it\nconst name = 'bin/tool.js';\nmodule.exports = name;\n");
  const tracked = ['runner.test.js', 'talker.test.js', 'bin/tool.js'];
  const synthetic = buildDependencyIndex({ root, trackedFiles: tracked });
  assert.equal(synthetic.graph.get('runner.test.js').includes('bin/tool.js'), true);
  // A mention without execution is prose, not a dependency. This is what keeps
  // `server.js` mentioned in a widely-required helper from fusing closures.
  assert.equal(synthetic.graph.get('talker.test.js').includes('bin/tool.js'), false);
});

test('a require edge is unaffected by the process rule', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-require-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.writeFileSync(path.join(root, 'lib', 'target.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'talker.test.js'), "require('./lib/target.js');\n");
  const synthetic = buildDependencyIndex({ root, trackedFiles: ['lib/target.js', 'talker.test.js'] });
  assert.equal(synthetic.graph.get('talker.test.js').includes('lib/target.js'), true);
});

test('documentation targets are never dependency edges', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-prose-'));
  fs.mkdirSync(path.join(root, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'scripts', 'x.js'), 'module.exports = 1;\n');
  fs.writeFileSync(path.join(root, 'README.md'), '# hi\n');
  fs.writeFileSync(path.join(root, 'doc.test.js'),
    "const { execFileSync } = require('node:child_process');\nexecFileSync('scripts/x.js');\nconst guide = 'README.md';\n");
  const synthetic = buildDependencyIndex({ root, trackedFiles: ['doc.test.js', 'scripts/x.js', 'README.md'] });
  assert.equal(synthetic.graph.get('doc.test.js').includes('README.md'), false);
  assert.equal(synthetic.graph.get('doc.test.js').includes('scripts/x.js'), true);
});

test('named data fixtures are reachable without an extension', () => {
  // The deterministic-task fixture is loaded as TASK_NAME + '.json' inside the
  // runner, so the test never spells the filename out in full.
  const fixture = 'test/fixtures/deterministic-tasks/real-huqan-approval-schema-private-object-helper-rename.json';
  const derived = deriveTestsForChange([fixture], index);
  assert.ok(derived.has('test/real-bounded-approval-schema-task.test.js'));
});

test('selection is narrow rather than degenerate for a leaf helper', () => {
  const derived = deriveTestsForChange(['lib/is-plain-object.js'], index);
  assert.ok(derived.size > 0);
  assert.ok(derived.size < index.tests.length, 'a leaf helper must not select every test');
});

test('named edges do not fuse the server closure into unrelated tests', () => {
  // `server.js` is named in prose in several widely-required modules. If those
  // mentions counted as edges, every test downstream of them would be selected
  // and the plan would stop being a selection (#2610 measurement: 417 tests
  // selected for a single change instead of 111).
  const derived = deriveTestsForChange(['lib/external-action-identity.js'], index);
  assert.ok(derived.size < 200, `expected a bounded selection, got ${derived.size}`);
});

test('javascript recognition is extension-based', () => {
  assert.equal(isJavaScript('lib/a.js'), true);
  assert.equal(isJavaScript('lib/a.json'), false);
  assert.equal(isJavaScript('bin/hook'), false);
});

test('an untracked or unknown path selects nothing and does not throw', () => {
  const derived = deriveTestsForChange(['docs/not-a-real-file-xyz.md'], index);
  assert.equal(derived.size, 0);
});

test('building an index over a synthetic tree honours trackedFiles', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-selection-'));
  fs.writeFileSync(path.join(root, 'lib.js'), "module.exports = require('./dep');\n");
  fs.writeFileSync(path.join(root, 'dep.js'), "module.exports = 1;\n");
  fs.writeFileSync(path.join(root, 'test-case.test.js'), "require('./lib');\n");
  const synthetic = buildDependencyIndex({ root, trackedFiles: ['lib.js', 'dep.js', 'test-case.test.js'] });
  const derived = deriveTestsForChange(['dep.js'], synthetic);
  assert.ok(derived.has('test-case.test.js'));
});
