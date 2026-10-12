'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { searchExpressions } = require('../lib/coder/expression-search');
const { synthesizeArithmetic } = require('../lib/coder/arithmetic-synthesis');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { readArithmeticModule } = require('../lib/experience/expression-adaptation');

const request = { id: 'expression-search', level: 'l0', allowedPaths: ['src/value.js'],
  operation: { type: 'replace_text', path: 'src/value.js' },
  test: { command: 'node test/value.js' }, synthesis: { family: 'arithmetic-expression',
    examples: [{ input: 0, expected: 1 }, { input: 1, expected: 2 }, { input: 2, expected: 5 }] } };

test('composes a non-affine expression from observations within the declared finite grammar', () => {
  const result = synthesizeArithmetic({ task: request, content: 'module.exports = value => value + 1;' });
  assert.equal(result.ok, true);
  assert.equal(result.task.operation.replace, '((value * value) + 1)');
  assert.equal(result.plan.maxOperations, 2);
  assert.ok(result.plan.enumerated <= result.plan.searchBudget);
  assert.equal(result.plan.matchingExpressions, 1);
  assert.equal(synthesizeArithmetic({ task: { ...request,
    synthesis: { ...request.synthesis, family: 'affine-integer' } },
  content: 'module.exports = value => value + 1;' }).reason, 'SYNTHESIS_NO_SOLUTION');
});

test('reports bounded ambiguous proposals instead of treating training agreement as verification', () => {
  const examples = [0, 2, 4].map(input => ({ input, expected: 0 }));
  const first = searchExpressions({ parameter: 'x', examples });
  const repeated = searchExpressions({ parameter: 'x', examples });
  assert.deepEqual(first, repeated);
  assert.equal(first.candidates[0].expression, '0');
  assert.ok(first.candidates.some(candidate => candidate.expression === '(x % 2)'));
  assert.equal(first.candidates.length, 8);
  assert.ok(first.omittedCandidates > 0);
  assert.ok(first.enumerated <= 4105);
  assert.equal(searchExpressions({ parameter: 'x', examples: [0, 1, 2].map(input => ({ input, expected: 999999 })) }).candidates.length, 0);
});

test('search preserves signed zero in observations and generated JavaScript expressions', () => {
  for (const examples of [
    [{ input: -1, expected: -0 }, { input: 0, expected: 0 }, { input: 1, expected: 0 }],
    [{ input: -0, expected: 0 }, { input: 1, expected: 1 }, { input: 2, expected: 2 }],
  ]) {
    const search = searchExpressions({ parameter: 'x', examples });
    assert.ok(search.candidates.length > 0);
    assert.ok(search.candidates.every(candidate => candidate.expression !== '0' && candidate.expression !== 'x'));
    for (const candidate of search.candidates) {
      const module = readArithmeticModule(`module.exports = x => ${candidate.expression};`);
      assert.ok(module, candidate.expression);
      for (const row of examples) assert.ok(Object.is(module.evaluate(row.input), row.expected), candidate.expression);
    }
  }
});

test('production CLI rejects an overfit program, remembers the actual winner and adapts it after restart', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-expression-search-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (file, text) => { fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), text); };
  write('src/value.js', 'module.exports = x => x + 1;\n');
  write('src/next.js', 'module.exports = other => other + 1;\n');
  write('src/curve.js', 'module.exports = value => value + 1;\n');
  write('test/curve.js', "const assert = require('node:assert/strict'); const f = require('../src/curve'); assert.equal(f(5), 26); assert.equal(f(8), 65);\n");
  for (const name of ['value', 'next']) write(`test/${name}.js`,
    `const assert = require('node:assert/strict'); const f = require('../src/${name}'); assert.equal(f(5), 1); assert.equal(f(8), 0);\n`);
  write('qualify/drift.md', 'no matching expression');
  write('qualify/ambiguous.md', 'x + 1\nx + 1');
  write('.gitignore', '*.json\n*.db*\n.huqan/\n');
  write('request.json', JSON.stringify({ ...request,
    qualificationPaths: ['qualify/drift.md', 'qualify/ambiguous.md'],
    synthesis: { family: 'arithmetic-expression', examples: [0, 2, 4].map(input => ({ input, expected: 0 })),
      rememberFile: '.huqan/coder/candidates/parity.json' } }));
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'qualify', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/expression-search']); commit();
  const cli = (args, expectedStatus = 0) => {
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '..', 'cli.js'),
    'coder', ...args, '--root', root, '--journal', path.join(root, 'journal.db'), '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') },
    });
    assert.equal(child.error, undefined, String(child.error));
    assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
    return JSON.parse(child.stdout);
  };
  const preview = cli(['request.json', '--synthesize', '--authorize', '--dry-run', '--run-id', 'preview'], 6);
  assert.equal(preview.data.synthesis.memory, null);
  assert.ok(preview.data.attempts.every(attempt => attempt.test.ran === false));
  assert.equal(fs.existsSync(path.join(root, '.huqan/coder/candidates/parity.json')), false);
  assert.equal(fs.readFileSync(path.join(root, 'src/value.js'), 'utf8'), 'module.exports = x => x + 1;\n');
  const result = cli(['request.json', '--synthesize', '--authorize', '--run-id', 'search']);
  assert.equal(result.data.outcome, 'applied_tested', JSON.stringify(result));
  const winner = result.data.synthesis.selectedCandidate;
  assert.ok(winner > 1);
  assert.equal(result.data.attempts.length, winner);
  for (const attempt of result.data.attempts.slice(0, -1)) {
    assert.equal(attempt.test.ok, false);
    assert.equal(attempt.rolledBack, true);
  }
  assert.equal(result.data.attempts.at(-1).kept, true);
  assert.equal(result.data.synthesis.sourceRunId, `search:c${winner}`);
  assert.equal(result.data.synthesis.operation.replace, '(x % 2)');
  assert.equal(result.data.synthesis.memory.ok, true);
  const candidate = JSON.parse(fs.readFileSync(path.join(root, '.huqan/coder/candidates/parity.json'), 'utf8'));
  assert.equal(candidate.runId, `search:c${winner}`);
  assert.equal(candidate.params.newText, '(x % 2)');
  commit();
  write('intent.json', JSON.stringify({ ...request, synthesis: undefined,
    allowedPaths: ['src/next.js'], operation: { type: 'replace_text', path: 'src/next.js' },
    test: { command: 'node test/next.js' } }));
  const reused = cli(['intent.json', '--adapt-memory', '--authorize', '--run-id', 'reused']);
  assert.equal(reused.data.record?.observedVerification.ok, true, JSON.stringify(reused));
  const store = openCoderJournal(path.join(root, 'journal.db'));
  try {
    for (let index = 1; index < winner; index += 1)
      assert.equal(store.journal.manifest(`search:c${index}`).learningEligibility, 'negative_example');
    assert.equal(store.journal.manifest(`search:c${winner}`).learningEligibility, 'positive_procedure');
    assert.equal(store.journal.manifest('reused:c1').learningEligibility, 'positive_procedure');
  } finally { store.close(); }
  commit();
  write('curve.json', JSON.stringify({ ...request, allowedPaths: ['src/curve.js'],
    operation: { type: 'replace_text', path: 'src/curve.js' }, test: { command: 'node test/curve.js' } }));
  const curve = cli(['curve.json', '--synthesize', '--authorize', '--run-id', 'curve']);
  assert.equal(curve.data.outcome, 'applied_tested', JSON.stringify(curve));
  assert.equal(curve.data.synthesis.operation.replace, '((value * value) + 1)');
  assert.equal(curve.data.attempts[0].test.ok, true);
});
