'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { adaptExpression, bindQualification } = require('../lib/experience/expression-adaptation');
const { runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');
const { openCoderJournal } = require('../lib/coder/journal-store');
const oldText = 'function clean(value) { return value.toUpperCase(); }';
const newText = 'function clean(value) { return value.trim().toLowerCase(); }';
test('sealed string method adaptation preserves the source program under new names', () => {
  const target = 'function normalize(raw) { return raw.toUpperCase(); }\nmodule.exports = normalize;';
  const adapted = adaptExpression({ oldText, newText, content: target, functionName: 'normalize', family: 'string-expression' });
  assert.equal(adapted.ok, true, adapted.reason);
  assert.equal(adapted.oldText, 'function normalize(raw) { return raw.toUpperCase(); }');
  assert.match(adapted.newText, /return raw.trim\(\).toLowerCase\(\);/);
  assert.deepEqual(adapted.bindings, { value: 'raw', clean: 'normalize' });
  assert.deepEqual(adapted.qualification, { sourceText: oldText, targetText: adapted.oldText });
  for (const [before, after, content] of [
    [oldText, newText, target.replace('toUpperCase', 'trim')],
    [oldText, newText.replace('function clean(value)', 'function clean(other)'), target],
    [oldText, newText.replace('value.trim().toLowerCase()', 'process.exit()'), target],
    [oldText, newText, 'function normalize(normalize) { return normalize.toUpperCase(); }'],
  ]) assert.equal(adaptExpression({ oldText: before, newText: after, content, functionName: 'normalize', family: 'string-expression' }).ok, false);
  assert.equal(bindQualification('function clean(toUpperCase) { return toUpperCase.toUpperCase(); }',
    { clean: 'normalize', toUpperCase: 'raw' }), 'function normalize(raw) { return raw.toUpperCase(); }');
});

test('fresh CLI processes learn and reuse a sealed string method, veto wrong acceptance and reject tampering', t => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'coder-string-learning-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'repo'); fs.mkdirSync(root);
  const write = (file, text) => { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); };
  write('source.js', oldText + '\nmodule.exports = clean;');
  write('target.js', 'function normalize(raw) { return raw.toUpperCase(); }\nmodule.exports = normalize;');
  write('rejected.js', 'function rejectText(other) { return other.toUpperCase(); }\nmodule.exports = rejectText;');
  const budgetSource = 'function budgetText(text) { return text.toUpperCase(); }\nmodule.exports = budgetText;';
  write('budget.js', budgetSource);
  write('qualify/drift.md', 'no function to replace');
  write('qualify/ambiguous.md', oldText + '\n' + oldText);
  write('source-test.js', 'const assert=require("node:assert/strict"),f=require("./source");assert.equal(f(" HÉLLO "),"héllo");assert.equal(f(" WORLD "),"world");');
  write('target-test.js', 'const assert=require("node:assert/strict"),f=require("./target");assert.equal(f(" ÜNICODE "),"ünicode");assert.equal(f(" NEW "),"new");');
  write('rejected-test.js', 'const assert=require("node:assert/strict"),f=require("./rejected");assert.equal(f(" UNSEEN "),"wrong");');
  write('budget-test.js', 'const assert=require("node:assert/strict"),f=require("./budget");assert.equal(f(" KEEP SPACES ")," keep spaces ");assert.equal(f(" EXTRA ")," extra ");');
  write('.gitignore', '*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-b', 'codex/fixture']);
  const commit = () => { git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'Fixture']); };
  commit();
  const file = path.join(base, 'request.json');
  const record = '.huqan/coder/candidates/string.json';
  const journal = path.join(root, 'journal.db');
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan/runtime-state') }; delete env.NODE_TEST_CONTEXT;
  const makeTask = (target, functionName, reuseMemory = false) => ({ id: 'strings-' + target, level: 'l0', allowedPaths: [target + '.js'],
    operation: { type: 'replace_text', path: target + '.js' }, test: { command: `node ${target}-test.js` },
    qualificationPaths: ['qualify/drift.md', 'qualify/ambiguous.md'],
    synthesis: { family: 'string-expression', functionName, reuseMemory,
      examples: reuseMemory ? [{ input: ' RED ', expected: 'red' }, { input: ' BLUE ', expected: 'blue' }, { input: '', expected: '' }]
        : [{ input: ' ABC ', expected: 'abc' }, { input: ' MiXeD ', expected: 'mixed' }, { input: '', expected: '' }] } });
  const run = (task, name) => {
    fs.writeFileSync(file, JSON.stringify(task));
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file, '--synthesize', '--authorize',
      '--root', root, '--journal', journal, '--run-id', name, '--json'],
    { cwd: base, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.equal(child.error, undefined, String(child.error));
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result };
  };
  const source = makeTask('source', 'clean'); source.synthesis.rememberFile = record;
  const learned = run(source, 'string-source');
  assert.equal(learned.child.status, 0, JSON.stringify(learned.result));
  assert.equal(learned.result.data.synthesis.memory.ok, true, JSON.stringify(learned.result));
  const originalRecord = fs.readFileSync(path.join(root, record)); commit();
  const warm = makeTask('target', 'normalize', true); warm.synthesis.rememberFile = '.huqan/coder/candidates/duplicate.json';
  const reused = run(warm, 'string-reuse');
  assert.equal(reused.child.status, 0, JSON.stringify(reused.result));
  assert.equal(reused.result.data.synthesis.memoryReuse.attempted, true);
  assert.equal(reused.result.data.synthesis.enumerated, 0);
  assert.equal(reused.result.data.synthesis.memory.state, 'reused_existing_candidate');
  assert.equal(fs.existsSync(path.join(root, warm.synthesis.rememberFile)), false);
  assert.deepEqual(fs.readFileSync(path.join(root, record)), originalRecord); commit();
  const beforeReject = fs.readFileSync(path.join(root, 'rejected.js'), 'utf8');
  const vetoed = run(makeTask('rejected', 'rejectText', true), 'string-veto');
  assert.equal(vetoed.child.status, 6, JSON.stringify(vetoed.result));
  assert.equal(vetoed.result.data.attempts[0].stage, 'memory');
  assert.equal(vetoed.result.data.attempts[0].rolledBack, true);
  assert.ok(vetoed.result.data.attempts.length <= 8);
  assert.equal(fs.readFileSync(path.join(root, 'rejected.js'), 'utf8'), beforeReject);
  assert.deepEqual(fs.readFileSync(path.join(root, record)), originalRecord);
  const budgetTask = makeTask('budget', 'budgetText', true);
  budgetTask.synthesis.examples = [{ input: 'ABC', expected: 'abc' }, { input: 'MiXeD', expected: 'mixed' }, { input: '', expected: '' }];
  const store = openCoderJournal(journal);
  try {
    const opts = { task: budgetTask, root, journal: store.journal, authorized: true,
      repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } };
    const exhausted = runArithmeticSynthesis({ ...opts, maxCandidates: 1, runId: 'string-budget-one' });
    assert.equal(exhausted.reason, 'SYNTHESIS_BUDGET_EXHAUSTED');
    assert.equal(exhausted.attempts.length, 1);
    assert.equal(exhausted.attempts[0].rolledBack, true);
    assert.equal(fs.readFileSync(path.join(root, 'budget.js'), 'utf8'), budgetSource);
    const recovered = runArithmeticSynthesis({ ...opts, maxCandidates: 2, runId: 'string-budget-two' });
    assert.equal(recovered.ok, true, JSON.stringify(recovered));
    assert.equal(recovered.attempts.length, 2);
    assert.equal(recovered.attempts[0].stage, 'memory');
    assert.equal(recovered.attempts[1].stage, 'search');
    assert.equal(recovered.synthesis.selectedCandidate, 2);
    assert.equal(recovered.synthesis.enumerated, 1885);
    assert.deepEqual(fs.readFileSync(path.join(root, record)), originalRecord);
  } finally { store.close(); }
  commit();
  const corrupt = JSON.parse(originalRecord.toString('utf8')); corrupt.params.newText = corrupt.params.newText.replace('toLowerCase', 'toUpperCase');
  const { hash: unusedHash, ...body } = corrupt;
  corrupt.hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(root, record), JSON.stringify(corrupt));
  const forged = run(makeTask('rejected', 'rejectText', true), 'string-forged');
  assert.equal(forged.child.status, 6, JSON.stringify(forged.result));
  assert.match(forged.result.data.reason, /source_procedure_mismatch|candidate_integrity_mismatch/);
  assert.deepEqual(forged.result.data.attempts, []);
  assert.equal(fs.readFileSync(path.join(root, 'rejected.js'), 'utf8'), beforeReject);
});
