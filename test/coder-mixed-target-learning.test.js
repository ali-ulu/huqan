'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');
const { selectCandidate } = require('../lib/coder/learned-candidate');
const { routeCoderProcedure } = require('../lib/experience/coder-routing-runtime');
const { compile } = require('../lib/experience/compiler');
const { adaptReplacementSequence, bindAdaptedReplacementQualification } = require('../lib/experience/replacement-sequence-adaptation');
const { runArithmeticSynthesis } = require('../lib/coder/arithmetic-synthesis');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const stringBefore = 'function clean(value) { return value.toUpperCase(); }';
const numberBefore = 'function score(x) { return x + 1; }';
function setup(t) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-learning-')));
  const fixture = { base };
  t.after(() => { fixture.store?.close(); fs.rmSync(base, { recursive: true, force: true }); });
  const root = path.join(base, 'source'); fs.mkdirSync(root);
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
  write('text.js', stringBefore + '\nmodule.exports = clean;');
  write('number.js', numberBefore + '\nmodule.exports = score;');
  write('accept.js', 'const a=require("node:assert/strict");a.equal(require("./text")(" ß "),"ß");a.equal(require("./number")(7),19);');
  write('drift.json', JSON.stringify({ 'text.js': 'missing', 'number.js': 'missing' }));
  write('ambiguous.json', JSON.stringify({ 'text.js': stringBefore + stringBefore, 'number.js': numberBefore + numberBefore }));
  const task = { id: 'learn-mixed', level: 'l0', allowedPaths: ['text.js', 'number.js'], operation: { type: 'sequence' },
    qualificationPaths: ['drift.json', 'ambiguous.json'], test: { command: 'node accept.js' },
    synthesis: { family: 'multi-target', searchMode: 'bounded', rememberFile: '.huqan/coder/candidates/mixed.json', targets: [
      { path: 'text.js', family: 'string-expression', functionName: 'clean', examples: [
        { input: ' ABC ', expected: 'abc' }, { input: ' MiXeD ', expected: 'mixed' }, { input: '', expected: '' },
      ] }, { path: 'number.js', family: 'affine-integer', functionName: 'score',
        examples: [0, 1, 3].map(input => ({ input, expected: input * 2 + 5 })) },
    ] } };
  return Object.assign(fixture, { root, task });
}
test('mixed fresh success records the sealed source sequence', t => {
  const fixture = setup(t); const { root, task } = fixture;
  const store = openCoderJournal(path.join(root, 'journal.db')); fixture.store = store;
  let clock = 0; const journal = budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) });
  const result = runArithmeticSynthesis({ root, task, journal, authorized: true, runId: 'source',
    repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.synthesis.memory.ok, true, JSON.stringify(result));
  const candidate = JSON.parse(fs.readFileSync(path.join(root, task.synthesis.rememberFile), 'utf8'));
  assert.equal(candidate.kind, 'replacement_sequence'); assert.equal(candidate.schemaVersion, 1);
});


test('sequence adaptation verifies source hash, local bindings, property tokens and qualification binding', () => {
  const before = 'function clean(toUpperCase) { return toUpperCase.toUpperCase(); }';
  const after = 'function clean(toUpperCase) { return toUpperCase.trim().toLowerCase(); }';
  const built = compile({ candidate: { status: 'candidate', trace: { sources: ['sealed'], scope: { workspaceId: 'default' } } },
    kind: 'replacement_sequence', params: { steps: [
      { path: 'a.js', oldText: before, newText: after },
      { path: 'b.js', oldText: numberBefore, newText: 'function score(x) { return ((x * 2) + 5); }' },
    ] } });
  assert.equal(built.ok, true);
  const targets = [{ path: 'new/text.js', family: 'string-expression', functionName: 'normalize' },
    { path: 'new/number.js', family: 'affine-integer', functionName: 'charge' }];
  const files = { 'new/text.js': 'function normalize(raw) { return raw.toUpperCase(); }',
    'new/number.js': 'function charge(amount) { return amount + 1; }' };
  const frozen = JSON.stringify(built.procedure);
  const result = adaptReplacementSequence({ sourceProcedure: built.procedure, targets, files });
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.procedure.parentHash, built.procedure.hash);
  assert.equal(result.procedure.version, built.procedure.version + 1);
  assert.match(result.procedure.params.steps[0].newText, /raw.trim\(\).toLowerCase\(\)/);
  assert.match(result.procedure.params.steps[1].newText, /amount \* 2/);
  const input = { 'a.js': before + before, 'b.js': numberBefore + numberBefore };
  const bound = bindAdaptedReplacementQualification({ sourceProcedure: built.procedure, targetProcedure: result.procedure,
    targets, targetFiles: files, files: input });
  assert.equal(bound.ok, true, JSON.stringify(bound));
  assert.equal(bound.files['new/text.js'], files['new/text.js'] + files['new/text.js']);
  assert.equal(bound.files['new/number.js'], files['new/number.js'] + files['new/number.js']);
  const forged = structuredClone(result.procedure); forged.params.steps[0].newText = 'forged';
  assert.equal(bindAdaptedReplacementQualification({ sourceProcedure: built.procedure, targetProcedure: forged,
    targets, targetFiles: files, files: input }).reason, 'procedure_binding_mismatch');
  const sourceForged = structuredClone(built.procedure); sourceForged.params.steps[1].newText = 'tampered';
  assert.equal(adaptReplacementSequence({ sourceProcedure: sourceForged, targets, files }).ok, false);
  assert.equal(bindAdaptedReplacementQualification({ sourceProcedure: built.procedure, targetProcedure: result.procedure,
    targets, targetFiles: files, files: { ...input, 'new/text.js': 'collision' } }).reason, 'qualification_path_collision');
  assert.equal(adaptReplacementSequence({ sourceProcedure: built.procedure, targets,
    files: { ...files, 'new/text.js': files['new/text.js'].replace('toUpperCase', 'trim') } }).ok, false);
  const localBefore = before.replace('clean(toUpperCase)', 'clean(x)').replace('return toUpperCase', 'return x');
  const localAfter = after.replace('clean(toUpperCase)', 'clean(x)').replace('return toUpperCase', 'return x');
  const localSource = compile({ candidate: { status: 'candidate', trace: { sources: ['sealed'], scope: { workspaceId: 'default' } } },
    kind: 'replacement_sequence', params: { steps: [
      { path: 'a.js', oldText: localBefore, newText: localAfter }, built.procedure.params.steps[1],
    ] } });
  const local = adaptReplacementSequence({ sourceProcedure: localSource.procedure, targets, files });
  assert.equal(local.ok, true, JSON.stringify(local));
  assert.equal(local.adaptations[0].bindings.x, 'raw'); assert.equal(local.adaptations[1].bindings.x, 'amount');
  assert.equal(JSON.stringify(built.procedure), frozen);
});

function targetProject(fixture, suffix, preserveSpaces = false) {
  const root = path.join(fixture.base, suffix); fs.mkdirSync(root);
  const write = (relative, text) => { fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true }); fs.writeFileSync(path.join(root, relative), text); };
  const text = 'function normalize(raw) { return raw.toUpperCase(); }\nmodule.exports = normalize;';
  const number = 'function charge(amount) { return amount + 1; }\nmodule.exports = charge;';
  write('new/text.js', text); write('new/number.js', number);
  write('accept.js', `const a=require('node:assert/strict'),f=require('./new/text'),g=require('./new/number');
    a.equal(f(' ß '),${JSON.stringify(preserveSpaces ? ' ß ' : 'ß')});a.equal(f(' ÜNICODE '),${JSON.stringify(preserveSpaces ? ' ünicode ' : 'ünicode')});a.equal(g(8),21);a.equal(g(-4),-3);`);
  for (const file of ['drift.json', 'ambiguous.json', '.huqan/coder/candidates/mixed.json'])
    write(file, fs.readFileSync(path.join(fixture.root, file)));
  write('.gitignore', '*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-qb', 'codex/fixture']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const task = structuredClone(fixture.task); task.id = suffix; task.allowedPaths = ['new/text.js', 'new/number.js'];
  task.synthesis.reuseMemory = true; task.synthesis.rememberFile = '.huqan/coder/candidates/new.json';
  task.synthesis.targets[0].path = 'new/text.js'; task.synthesis.targets[0].functionName = 'normalize';
  task.synthesis.targets[0].examples = preserveSpaces
    ? ['RED', 'BLUE', ''].map(input => ({ input, expected: input.toLowerCase() }))
    : [' RED ', ' BLUE ', ''].map(input => ({ input, expected: input.trim().toLowerCase() }));
  task.synthesis.targets[1].path = 'new/number.js'; task.synthesis.targets[1].functionName = 'charge';
  task.synthesis.targets[1].examples = [2, 4, 6].map(input => ({ input, expected: input * 2 + 5 }));
  return { root, task, text, number };
}
function learn(fixture) {
  const store = openCoderJournal(path.join(fixture.base, 'journal.db'));
  let clock = 0;
  try {
    const result = runArithmeticSynthesis({ root: fixture.root, task: fixture.task,
      journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }), authorized: true, runId: 'source',
      repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } });
    assert.equal(result.ok, true, JSON.stringify(result)); assert.equal(result.synthesis.memory.ok, true);
  } finally { store.close(); }
  return fs.readFileSync(path.join(fixture.root, fixture.task.synthesis.rememberFile));
}
test('restarted native CLI adapts a sealed mixed method into a different project and rejects forged source records', t => {
  const fixture = setup(t), original = learn(fixture);
  let target = targetProject(fixture, 'target');
  const run = (runId, authorized = true) => {
    const file = path.join(fixture.base, 'request.json'); fs.writeFileSync(file, JSON.stringify(target.task));
    const env = { ...process.env, HUQAN_STATE_ROOT: path.join(fixture.base, 'state') }; delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file, '--synthesize',
      '--root', target.root, '--journal', path.join(fixture.base, 'journal.db'), '--run-id', runId, '--json',
      ...(authorized ? ['--authorize'] : [])], { env, cwd: fixture.base, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.ifError(child.error); assert.equal(child.signal, null);
    let result; try { result = JSON.parse(child.stdout); } catch { assert.fail(child.stdout + child.stderr); }
    return { child, result: result.data };
  };
  const denied = run('denied', false); assert.equal(denied.child.status, 6);
  assert.equal(denied.result.synthesis?.memoryReuse?.fallback, undefined);
  assert.equal(fs.readFileSync(path.join(target.root, 'new/text.js'), 'utf8'), target.text);
  assert.equal(fs.readFileSync(path.join(target.root, 'new/number.js'), 'utf8'), target.number);
  const warm = run('warm'); assert.equal(warm.child.status, 0, JSON.stringify(warm));
  assert.equal(warm.result.synthesis.enumerated, 0); assert.equal(warm.result.synthesis.memoryReuse.attempted, true);
  assert.equal(warm.result.synthesis.memory.state, 'reused_existing_candidate');
  assert.equal(fs.existsSync(path.join(target.root, target.task.synthesis.rememberFile)), false);
  assert.deepEqual(fs.readFileSync(path.join(fixture.root, fixture.task.synthesis.rememberFile)), original);
  assert.deepEqual(fs.readFileSync(path.join(target.root, fixture.task.synthesis.rememberFile)), original);
  target = targetProject(fixture, 'forged');
  const forged = JSON.parse(original.toString('utf8')); forged.params.steps[0].newText = 'tampered';
  const { hash: unusedHash, ...body } = forged; forged.hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
  fs.writeFileSync(path.join(target.root, fixture.task.synthesis.rememberFile), JSON.stringify(forged));
  const failure = run('forged'); assert.equal(failure.child.status, 6);
  assert.deepEqual(failure.result.attempts, []); assert.match(failure.result.reason, /source_procedure_mismatch|candidate_integrity_mismatch/);
  assert.equal(failure.result.synthesis?.memoryReuse?.fallback, undefined);
  assert.equal(fs.readFileSync(path.join(target.root, 'new/text.js'), 'utf8'), target.text);
  assert.equal(fs.readFileSync(path.join(target.root, 'new/number.js'), 'utf8'), target.number);
});
test('failed adapted warm method rolls back both targets and shares budgets one and two with different fresh synthesis', t => {
  const fixture = setup(t), original = learn(fixture);
  for (const budget of [1, 2]) {
    const target = targetProject(fixture, 'budget-' + budget, true);
    const store = openCoderJournal(path.join(fixture.base, 'journal.db')); let clock = 0;
    try {
      const result = runArithmeticSynthesis({ ...target, authorized: true, maxCandidates: budget, runId: 'retry-' + budget,
        journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }),
        repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } });
      assert.equal(result.ok, budget === 2, JSON.stringify(result));
      assert.equal(result.attempts.length, budget);
      assert.equal(result.attempts[0].rolledBack, true);
      assert.deepEqual(fs.readFileSync(path.join(target.root, fixture.task.synthesis.rememberFile)), original);
      if (budget === 1) {
        assert.equal(result.reason, 'SYNTHESIS_BUDGET_EXHAUSTED');
        assert.equal(fs.readFileSync(path.join(target.root, 'new/text.js'), 'utf8'), target.text);
        assert.equal(fs.readFileSync(path.join(target.root, 'new/number.js'), 'utf8'), target.number);
        assert.equal(fs.existsSync(path.join(target.root, target.task.synthesis.rememberFile)), false);
      } else {
        assert.equal(result.attempts[0].stage, 'memory'); assert.equal(result.attempts[1].stage, 'search');
        assert.ok(result.synthesis.excludedCandidates >= 1);
        assert.equal(result.synthesis.selectedCandidate, 2); assert.equal(result.synthesis.retainedCandidateCombinations, 1);
        assert.equal(result.synthesis.sourceRunId, 'retry-2:search:c1');
        const saved = JSON.parse(fs.readFileSync(path.join(target.root, target.task.synthesis.rememberFile), 'utf8'));
        assert.equal(saved.runId, 'retry-2:search:c1');
      }
    } finally { store.close(); }
  }
});

test('qualification, readback and unverified rollback failures never trigger fresh fallback', t => {
  const fixture = setup(t); learn(fixture);
  for (const mode of ['qualification', 'readback', 'rollback']) {
    const target = targetProject(fixture, mode, mode === 'rollback');
    if (mode === 'qualification') fs.writeFileSync(path.join(target.root, 'ambiguous.json'),
      JSON.stringify({ 'text.js': 'missing', 'number.js': 'missing' }));
    if (mode === 'rollback') fs.writeFileSync(path.join(target.root, 'accept.js'),
      "const fs=require('node:fs');fs.unlinkSync('new/text.js');fs.mkdirSync('new/text.js');process.exit(1);");
    const store = openCoderJournal(path.join(fixture.base, 'journal.db')); let clock = 0;
    const spawn = mode !== 'readback' ? null : (...args) => {
      const child = spawnSync(...args);
      fs.appendFileSync(path.join(target.root, 'new/text.js'), '\n// after-test drift');
      return child;
    };
    try {
      const result = runArithmeticSynthesis({ ...target, authorized: true, maxCandidates: 8, runId: mode,
        journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }), spawn,
        repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false } });
      assert.equal(result.ok, false, JSON.stringify(result));
      assert.equal(result.attempts.length, 1, JSON.stringify(result));
      assert.equal(result.synthesis.memoryReuse.fallback, undefined);
      assert.equal(fs.existsSync(path.join(target.root, target.task.synthesis.rememberFile)), false);
      if (mode === 'rollback') {
        assert.equal(result.reason, 'ROLLBACK_NOT_VERIFIED', JSON.stringify(result)); assert.equal(result.attempts[0].rolledBack, false);
      } else {
        assert.equal(fs.readFileSync(path.join(target.root, 'new/text.js'), 'utf8'), target.text);
        assert.equal(fs.readFileSync(path.join(target.root, 'new/number.js'), 'utf8'), target.number);
      }
    } finally { store.close(); }
  }
});

test('runtime independently rejects a resolver proposal whose adapted target text was forged', t => {
  const fixture = setup(t); learn(fixture);
  const target = targetProject(fixture, 'resolver-forgery');
  const store = openCoderJournal(path.join(fixture.base, 'journal.db'));
  try {
    const selected = selectCandidate({ root: target.root, journal: store.journal, workspaceId: 'default',
      task: { ...target.task, operation: { type: 'sequence', paths: target.task.allowedPaths } },
      allowTransfer: true, allowAdaptation: true });
    assert.equal(selected.ok, true, JSON.stringify(selected));
    const forged = structuredClone(selected.task);
    forged.operation.steps[0].replace = forged.operation.steps[0].replace.replace('toLowerCase', 'toUpperCase');
    const result = routeCoderProcedure({ task: forged, root: target.root, journal: store.journal,
      workspaceId: 'default', requestId: 'forged-proposal', transferTestReady: true,
      files: Object.fromEntries(target.task.allowedPaths.map(relative => [relative, fs.readFileSync(path.join(target.root, relative), 'utf8')])) });
    assert.equal(result.ok, false); assert.equal(result.code, 'procedure_binding_mismatch');
    assert.equal(fs.readFileSync(path.join(target.root, 'new/text.js'), 'utf8'), target.text);
    assert.equal(fs.readFileSync(path.join(target.root, 'new/number.js'), 'utf8'), target.number);
  } finally { store.close(); }
});
