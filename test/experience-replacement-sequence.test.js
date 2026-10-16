'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { compile, qualify } = require('../lib/experience/compiler');
const { runTask, STATUS } = require('../lib/deterministic-task-runner');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { runFixLoop } = require('../lib/coder/fix-loop');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const { rememberCandidate, resolveCandidate } = require('../lib/coder/learned-candidate');
const candidate = { status: 'candidate', trace: { sources: ['sealed-source'], scope: { workspaceId: 'default' }, revision: 'fixture' } };

test('replacement sequence compilation binds every step and qualifies complete output without losing untouched files', () => {
  const steps = [{ path: 'a.js', oldText: 'x + 1', newText: 'x * 3 - 2' },
    { path: 'b.js', oldText: 'x + 1', newText: 'x * 2 + 5' }];
  const built = compile({ candidate, kind: 'replacement_sequence', params: { steps } });
  assert.equal(built.ok, true, built.code);
  steps[0].newText = 'tampered';
  assert.equal(built.procedure.params.steps[0].newText, 'x * 3 - 2');
  assert.ok(Object.isFrozen(built.procedure.params.steps[0]));
  const files = { 'a.js': 'module.exports = x => x + 1;', 'b.js': 'module.exports = x => x + 1;', 'untouched.js': 'keep' };
  const apply = procedure => {
    const result = runTask({ id: 'qualify', level: 'l0', files, allowedPaths: ['a.js', 'b.js'], operation: { type: 'sequence',
      steps: procedure.params.steps.map(step => ({ type: 'replace_text', path: step.path, find: step.oldText, replace: step.newText })) } });
    assert.equal(result.status, STATUS.COMPLETED);
    return result;
  };
  const options = { procedure: built.procedure, inputs: ['holdout'], observe: () => files, apply };
  assert.equal(qualify(options).qualified, true);
  assert.equal(qualify({ ...options, observe: () => ({ ...files, 'b.js': 'missing' }) }).code, 'qualify_rejected:drift');
  assert.equal(qualify({ ...options, observe: () => ({ ...files, 'b.js': 'x + 1; x + 1;' }) }).code, 'qualify_rejected:ambiguous');
  assert.equal(qualify({ ...options, apply: procedure => ({ files: { ...apply(procedure).files, 'untouched.js': 'changed' } }) }).code,
    'qualify_rejected:postcondition');
  for (const bad of [[], Array(2), [built.procedure.params.steps[0], built.procedure.params.steps[0]],
    [{ ...built.procedure.params.steps[0], path: '../escape.js' }, built.procedure.params.steps[1]]])
    assert.equal(compile({ candidate, kind: 'replacement_sequence', params: { steps: bad } }).ok, false);
});

test('a sealed replacement sequence is remembered and requalified after journal restart with no target method text', t => {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-replacement-memory-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const original = 'module.exports = x => x + 1;\n';
  for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), original);
  fs.writeFileSync(path.join(root, 'accept.js'),
    "const a=require('./a'),b=require('./b'),assert=require('node:assert/strict');assert.equal(a(5),13);assert.equal(b(5),15);");
  fs.writeFileSync(path.join(root, 'drift.json'), JSON.stringify({ 'a.js': 'missing', 'b.js': 'missing' }));
  fs.writeFileSync(path.join(root, 'ambiguous.json'), JSON.stringify({ 'a.js': original + original, 'b.js': original }));
  const source = { id: 'source-sequence', level: 'l0', allowedPaths: ['a.js', 'b.js'],
    operation: { type: 'sequence', steps: [
      { type: 'replace_text', path: 'a.js', find: 'x + 1', replace: 'x * 3 - 2' },
      { type: 'replace_text', path: 'b.js', find: 'x + 1', replace: 'x * 2 + 5' },
    ] }, test: { command: 'node accept.js' } };
  const open = () => {
    const store = openCoderJournal(path.join(root, 'journal.db')); let clock = 0;
    return { ...store, journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }) };
  };
  const options = { root, repoState: { branch: 'codex/fixture', dirty: false, hasUntracked: false }, authorized: true };
  const file = '.huqan/coder/candidates/sequence.json';
  let store = open();
  try {
    const taught = runFixLoop({ ...options, task: source, journal: store.journal, runId: 'source' });
    assert.equal(taught.ok, true, taught.reason);
    const saved = rememberCandidate({ task: source, root, journal: store.journal, runId: 'source:c1', workspaceId: 'default',
      file, qualificationPaths: ['drift.json', 'ambiguous.json'] });
    assert.equal(saved.ok, true, saved.reason);
  } finally { store.close(); }
  const savedBytes = fs.readFileSync(path.join(root, file), 'utf8');
  for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), '// independent context\n' + original);
  const intent = { id: 'target-sequence', level: 'l0', allowedPaths: ['a.js', 'b.js'],
    operation: { type: 'sequence', paths: ['a.js', 'b.js'] }, test: { command: 'node accept.js' } };
  store = open();
  try {
    const loaded = resolveCandidate({ task: intent, root, journal: store.journal, workspaceId: 'default', file, allowTransfer: true });
    assert.equal(loaded.ok, true, loaded.reason);
    const reused = runFixLoop({ ...options, task: loaded.task, journal: store.journal, runId: 'target' });
    assert.equal(reused.ok, true, JSON.stringify(reused));
    assert.equal(reused.attempts[0].test.exitCode, 0);
    assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), savedBytes);
    for (const name of ['a.js', 'b.js']) fs.writeFileSync(path.join(root, name), original);
    const denied = runFixLoop({ ...options, authorized: false, task: loaded.task, journal: store.journal, runId: 'denied' });
    assert.equal(denied.ok, false);
    for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), original);
    assert.equal(resolveCandidate({ task: intent, root, journal: store.journal, workspaceId: 'wrong-workspace', file,
      allowTransfer: true }).ok, false);
    const renamedPaths = structuredClone(intent); renamedPaths.operation.paths[1] = 'unseen.js';
    assert.equal(resolveCandidate({ task: renamedPaths, root, journal: store.journal, workspaceId: 'default', file,
      allowTransfer: true }).ok, false);
    fs.writeFileSync(path.join(root, 'accept.js'), "require('node:assert/strict').fail('independent veto');");
    const veto = runFixLoop({ ...options, task: loaded.task, journal: store.journal, runId: 'veto' });
    assert.equal(veto.ok, false);
    assert.equal(veto.attempts[0].rolledBack, true);
    for (const name of ['a.js', 'b.js']) assert.equal(fs.readFileSync(path.join(root, name), 'utf8'), original);
    const changed = JSON.parse(savedBytes); changed.params.steps[1].newText = '0';
    const { hash: unusedHash, ...body } = changed;
    changed.hash = require('node:crypto').createHash('sha256').update(JSON.stringify(body)).digest('hex');
    fs.writeFileSync(path.join(root, file), JSON.stringify(changed));
    assert.equal(resolveCandidate({ task: intent, root, journal: store.journal, workspaceId: 'default', file, allowTransfer: true }).ok, false);
  } finally { store.close(); }
  fs.writeFileSync(path.join(root, file), savedBytes);
  fs.writeFileSync(path.join(root, 'accept.js'),
    "const a=require('./a'),b=require('./b'),assert=require('node:assert/strict');assert.equal(a(8),22);assert.equal(b(8),21);");
  fs.writeFileSync(path.join(root, '.gitignore'), '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe', windowsHide: true });
  git(['init', '-qb', 'codex/fixture']); git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  const requestFile = path.join(root, 'intent.json'); fs.writeFileSync(requestFile, JSON.stringify(intent));
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'state') }; delete env.NODE_TEST_CONTEXT;
  const cli = spawnSync(process.execPath, [path.resolve(__dirname, '../cli.js'), 'coder', requestFile, '--root', root,
    '--journal', path.join(root, 'journal.db'), '--use-memory', '--transfer-memory', '--authorize', '--run-id', 'cli-restart', '--json'],
  { cwd: root, encoding: 'utf8', timeout: 120000, windowsHide: true, env });
  assert.ifError(cli.error);
  assert.equal(cli.status, 0, cli.stdout + cli.stderr);
  assert.equal(JSON.parse(cli.stdout).data.outcome, 'applied_tested');
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), savedBytes);
});
