'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { execFileSync, spawnSync } = require('node:child_process');
const { openCoderJournal } = require('../lib/coder/journal-store');
const digest = value => crypto.createHash('sha256').update(value).digest('hex');
const BUDGET = 8;
// Fixed before training: distinct inputs, names and paths; same bounded method.
const COHORT = [
  { id: 'first', text: 'names/first.js', number: 'fees/first.js', fn: 'normalize', param: 'fresh',
    train: [' RED ', ' BLUE ', ''], holdout: [' ÜNICODE ', ' ÀBC '], nums: [2, 4, 6], checks: [11, 17] },
  { id: 'second', text: 'labels/second.js', number: 'totals/second.js', fn: 'tidy', param: 'item',
    train: [' GREEN ', ' YELLOW ', ''], holdout: [' ÉTÉ ', ' ÖL '], nums: [8, 10, 12], checks: [19, 23] },
  { id: 'third', text: 'codes/third.js', number: 'prices/third.js', fn: 'canonical', param: 'entry',
    train: [' PURPLE ', ' ORANGE ', ''], holdout: [' ÑANDÚ ', ' ÇAY '], nums: [14, 16, 18], checks: [29, 31] },
];
const SOURCE = { id: 'training', text: 'text.js', number: 'number.js', fn: 'clean', param: 'value',
  train: [' ABC ', ' MiXeD ', ''], holdout: [' ß ', ' HÉLLO '], nums: [0, 1, 3], checks: [7, 9] };
const NEGATIVE = { ...COHORT[0], id: 'different-method', train: ['RED', 'BLUE', ''],
  holdout: [' KEEP SPACES ', ' ÉTÉ '] };
const MEMORY = '.huqan/coder/candidates/mixed.json';
const SENTINEL = 'module.exports = { unchanged: 42 };\n';
function write(root, relative, text) {
  const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text);
}
function fixture(item, preserveSpaces = false) {
  const textBefore = `function ${item.fn}(${item.param}) { return ${item.param}.toUpperCase(); }`;
  const numberName = item.fn + 'Amount';
  const numberBefore = `function ${numberName}(${item.param}) { return ${item.param} + 1; }`;
  const files = { [item.text]: textBefore + `\nmodule.exports = ${item.fn};`,
    [item.number]: numberBefore + `\nmodule.exports = ${numberName};` };
  const expected = value => preserveSpaces ? value.toLowerCase() : value.trim().toLowerCase();
  const acceptance = `const fs=require('node:fs');fs.appendFileSync('.huqan/gain.log','test-process\\n');
const a=require('node:assert/strict');const text=require(${JSON.stringify('./' + item.text)});
const number=require(${JSON.stringify('./' + item.number)});
a.equal(require('./sentinel').unchanged,42);a.equal(text('42'),'42');a.equal(number(-4),-3);
${item.holdout.map(value => `a.equal(text(${JSON.stringify(value)}),${JSON.stringify(expected(value))});`).join('\n')}
${item.checks.map(value => `a.equal(number(${value}),${value * 2 + 5});`).join('\n')}
fs.appendFileSync('.huqan/gain.log','test-pass\\n');`;
  const task = { id: item.id, level: 'l0', allowedPaths: [item.text, item.number], operation: { type: 'sequence' },
    qualificationPaths: ['drift.json', 'ambiguous.json'], test: { command: 'node accept.js' },
    synthesis: { family: 'multi-target', searchMode: 'bounded', targets: [
      { path: item.text, family: 'string-expression', functionName: item.fn,
        examples: item.train.map(input => ({ input, expected: expected(input) })) },
      { path: item.number, family: 'affine-integer', functionName: numberName,
        examples: item.nums.map(input => ({ input, expected: input * 2 + 5 })) },
    ] } };
  return { files, acceptance, task,
    drift: JSON.stringify({ [item.text]: 'missing', [item.number]: 'missing' }),
    ambiguous: JSON.stringify({ [item.text]: textBefore + textBefore, [item.number]: numberBefore + numberBefore }),
    hashes: { source: digest(JSON.stringify(files)), requirement: digest(JSON.stringify(task)), acceptance: digest(acceptance) } };
}
function install(root, data) {
  fs.mkdirSync(root); fs.mkdirSync(path.join(root, '.huqan'));
  for (const [file, text] of Object.entries(data.files)) write(root, file, text);
  write(root, 'accept.js', data.acceptance); write(root, 'sentinel.js', SENTINEL);
  write(root, 'drift.json', data.drift); write(root, 'ambiguous.json', data.ambiguous);
  write(root, '.gitignore', '.huqan/\n*.db*\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-qb', 'codex/mixed-gain']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
}
function invoke(base, root, data, id, journal, mode) {
  const task = structuredClone(data.task);
  if (mode === 'training') task.synthesis.rememberFile = MEMORY;
  if (mode === 'warm') task.synthesis.reuseMemory = true;
  // Negative control: deliberately remove reuse. The real warm assertion must fail.
  if (process.env.HUQAN_GAIN_DISABLE_REUSE === '1') delete task.synthesis.reuseMemory;
  const file = path.join(base, id + '.json'); fs.writeFileSync(file, JSON.stringify(task));
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(base, 'state') }; delete env.NODE_TEST_CONTEXT;
  const started = performance.now();
  const child = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', file, '--synthesize',
    '--root', root, '--journal', journal, '--run-id', id, '--authorize', '--json'],
  { cwd: base, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576, env, windowsHide: true });
  const wallMs = performance.now() - started;
  assert.ifError(child.error); assert.equal(child.signal, null);
  assert.equal(child.status, 0, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout).data;
  const log = fs.readFileSync(path.join(root, '.huqan/gain.log'), 'utf8');
  const processes = log.split('test-process\n').length - 1, passes = log.split('test-pass\n').length - 1;
  assert.equal(result.outcome, 'applied_tested', JSON.stringify(result)); assert.ok(result.attempts.length <= BUDGET);
  assert.equal(fs.readFileSync(path.join(root, 'sentinel.js'), 'utf8'), SENTINEL);
  assert.equal(processes, result.attempts.length); assert.ok(passes >= 1);
  // Reopen the actual SQLite journal after the child process has exited.
  const store = openCoderJournal(journal); try { assert.ok(store.journal.manifest(result.synthesis.sourceRunId)); } finally { store.close(); }
  return { result, wallMs, processes, passes, root };
}
function enumeration(run) {
  const synthesis = run.result.synthesis;
  if (synthesis.memoryReuse?.attempted && synthesis.enumerated === 0 && !synthesis.memoryReuse.fallback) return 0;
  assert.ok(Array.isArray(synthesis.targets), JSON.stringify(synthesis));
  return synthesis.targets.reduce((total, target) => {
    if (target.family === 'affine-integer') {
      assert.equal(target.searchBudget, 65); // Budget is not an observed enumeration count.
      return total;
    }
    assert.equal(typeof target.enumerated, 'number', JSON.stringify(target)); return total + target.enumerated;
  }, 0);
}

test('paired mixed-method transfers report full CLI cost and real independent verifier counts', t => {
  // Freeze all fixture bytes and hashes before any source training process starts.
  const sourceFixture = fixture(SOURCE);
  // Qualification examples belong to the sealed source procedure, not target paths.
  const qualify = data => ({ ...data, drift: sourceFixture.drift, ambiguous: sourceFixture.ambiguous,
    hashes: { ...data.hashes, qualification: digest(sourceFixture.drift + sourceFixture.ambiguous) } });
  const fixtures = COHORT.map(item => qualify(fixture(item)));
  const negative = qualify(fixture(NEGATIVE, true));
  const commitments = fixtures.map(data => ({ ...data.hashes }));
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mixed-gain-')));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const journal = path.join(base, 'journal.db'), source = path.join(base, 'source');
  install(source, sourceFixture);
  const training = invoke(base, source, sourceFixture, 'training', journal, 'training');
  assert.equal(training.result.synthesis.memory.ok, true);
  const memory = fs.readFileSync(path.join(source, MEMORY));
  const trainedBytes = Object.fromEntries(Object.keys(sourceFixture.files).map(file => [file, fs.readFileSync(path.join(source, file))]));
  const evidence = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    const data = fixtures[index], item = COHORT[index];
    assert.deepEqual(data.hashes, commitments[index]);
    const roots = ['cold', 'warm'].map(arm => path.join(base, item.id + '-' + arm));
    for (const root of roots) install(root, data);
    write(roots[1], MEMORY, memory);
    for (const file of [...Object.keys(data.files), 'accept.js', 'drift.json', 'ambiguous.json'])
      assert.deepEqual(fs.readFileSync(path.join(roots[0], file)), fs.readFileSync(path.join(roots[1], file)));
    const runs = [];
    // Alternate execution order; wall times remain observations, never speed assertions.
    for (const at of index % 2 ? [1, 0] : [0, 1])
      runs[at] = invoke(base, roots[at], data, item.id + '-' + at, journal, at ? 'warm' : 'cold');
    const [cold, warm] = runs;
    assert.equal(warm.result.synthesis.memoryReuse?.attempted, true);
    assert.equal(warm.result.synthesis.memoryReuse.fallback, undefined);
    assert.equal(enumeration(warm), 0); assert.ok(enumeration(cold) > 0);
    for (const file of Object.keys(data.files))
      assert.deepEqual(fs.readFileSync(path.join(cold.root, file)), fs.readFileSync(path.join(warm.root, file)));
    assert.deepEqual(fs.readFileSync(path.join(warm.root, MEMORY)), memory);
    evidence.push({ id: item.id, hashes: data.hashes,
      cold: { wallMs: cold.wallMs, processes: cold.processes, passes: cold.passes, stringEnumeration: enumeration(cold),
        affineSearchBudget: cold.result.synthesis.targets[1].searchBudget },
      warm: { wallMs: warm.wallMs, processes: warm.processes, passes: warm.passes, stringEnumeration: enumeration(warm) } });
  }
  const different = path.join(base, 'negative'); install(different, negative); write(different, MEMORY, memory);
  const control = invoke(base, different, negative, 'negative', journal, 'warm');
  assert.equal(control.result.attempts[0].stage, 'memory');
  assert.equal(control.result.attempts[0].rolledBack, true);
  assert.equal(control.result.attempts[1].stage, 'search'); assert.equal(control.processes, 2);
  assert.equal(control.passes, 1); assert.ok(enumeration(control) > 0);
  assert.deepEqual(fs.readFileSync(path.join(different, MEMORY)), memory);
  assert.deepEqual(fs.readFileSync(path.join(source, MEMORY)), memory);
  for (const [file, bytes] of Object.entries(trainedBytes)) assert.deepEqual(fs.readFileSync(path.join(source, file)), bytes);
  const sum = (arm, key) => evidence.reduce((total, row) => total + row[arm][key], 0);
  t.diagnostic(JSON.stringify({ scope: 'fixed same-method bounded mixed grammar; CPU not measured',
    timingScope: 'spawnSync wall time includes CLI startup, source verification, qualification, revalidation and acceptance; fixture setup and dependency installation excluded',
    budget: { maximumCandidateAttempts: BUDGET, source: 'unchanged native CLI default' },
    regressionScope: { sentinelHash: digest(SENTINEL), unchangedTextInput: '42', unchangedNumberInput: -4 },
    training: { wallMs: training.wallMs, processes: training.processes, stringEnumeration: enumeration(training),
      affineSearchBudget: training.result.synthesis.targets[1].searchBudget, memoryHash: digest(memory) },
    evidence, totals: { coldWallMs: sum('cold', 'wallMs'), warmWallMs: sum('warm', 'wallMs'),
      warmIncludingTrainingWallMs: sum('warm', 'wallMs') + training.wallMs,
      coldProcesses: sum('cold', 'processes'), warmProcesses: sum('warm', 'processes'),
      warmIncludingTrainingProcesses: sum('warm', 'processes') + training.processes },
    differentMethodControl: { hashes: negative.hashes, failedMemoryRolledBack: true, freshSucceeded: true,
      processes: control.processes, passes: control.passes, wallMs: control.wallMs } }));
});
