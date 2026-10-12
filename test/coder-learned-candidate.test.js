'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const { loadSqliteDriver } = require('../lib/sqlite-availability');
const { rememberCandidate, resolveCandidate, selectCandidate } = require('../lib/coder/learned-candidate');

const STATE = { branch: 'feat/candidate', dirty: false, hasUntracked: false };
const SOURCE = { id: 'source', level: 'l0', allowedPaths: ['docs/a.md'],
  operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-candidate-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
  fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
  fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
  const file = path.join(root, '.huqan', 'coder', 'candidates', 'candidate.json');
  const open = () => {
    const store = openCoderJournal(path.join(root, 'journal.db'));
    let clock = 0;
    return { ...store, journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }) };
  };
  const store = open();
  try { assert.equal(applyDerivation({ task: SOURCE, root, repoState: STATE,
    journal: store.journal, runId: 'source' }).ok, true); } finally { store.close(); }
  return { root, file, open };
}

function remember(f, task = SOURCE) {
  const store = f.open();
  try { return rememberCandidate({ task, journal: store.journal, runId: 'source',
    workspaceId: 'default', file: f.file, root: f.root,
    qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }); } finally { store.close(); }
}

test('a persisted candidate supplies method text after reopening without installing authority', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const intent = { id: 'unseen-context', level: 'l0', allowedPaths: ['docs/a.md'],
    operation: { type: 'replace_text', path: 'docs/a.md' } };
  const store = f.open();
  try {
    const resolved = resolveCandidate({ task: intent, journal: store.journal, file: f.file,
      workspaceId: 'default', root: f.root });
    assert.equal(resolved.ok, true);
    assert.equal(resolved.task.experience.intentOnly, true);
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'new context\nbefore\n');
    const result = applyDerivation({ task: resolved.task, root: f.root, repoState: STATE,
      journal: store.journal, runId: 'heldout' });
    assert.equal(result.ok, true, result.reason);
    assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'new context\nafter\n');
    assert.equal(JSON.parse(fs.readFileSync(f.file, 'utf8')).registered, false);
    const nextFile = path.join(f.root, '.huqan', 'coder', 'candidates', 'next.json');
    const next = rememberCandidate({ task: SOURCE, journal: store.journal, runId: 'heldout',
      workspaceId: 'default', file: nextFile, root: f.root,
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] });
    assert.equal(next.reason, 'routed_source_requires_original_candidate');
    assert.equal(fs.existsSync(nextFile), false);
    const again = resolveCandidate({ task: intent, journal: store.journal, file: f.file,
      workspaceId: 'default', root: f.root });
    assert.equal(again.ok, true, again.reason);
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'third context\nbefore\n');
    const reused = applyDerivation({ task: again.task, root: f.root, repoState: STATE,
      journal: store.journal, runId: 'third' });
    assert.equal(reused.ok, true, reused.reason);
  } finally { store.close(); }
});

test('the production CLI can remember and load a method without task text', t => {
  const f = fixture(t);
  const git = args => execFileSync('git', args, { cwd: f.root, stdio: 'pipe' });
  fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '*.json\n*.db*\n.huqan/\n');
  git(['init', '-b', 'feat/candidate-cli', '-q']);
  git(['add', 'docs', '.gitignore']);
  const commit = () => git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'fixture', '-q']);
  commit();
  const { runCliCoder } = require('../lib/cli-coder');
  const sourceFile = path.join(f.root, 'source.json');
  const intentFile = path.join(f.root, 'intent.json');
  fs.writeFileSync(sourceFile, JSON.stringify({ ...SOURCE,
    qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }));
  fs.writeFileSync(intentFile, JSON.stringify({ id: 'cli-intent', level: 'l0',
    allowedPaths: ['docs/a.md'], operation: { type: 'replace_text', path: 'docs/a.md' } }));
  const flags = ['--root', f.root, '--journal', path.join(f.root, 'journal.db'), '--candidate-file', f.file];
  const opts = { json: true, coderLoop: { rememberCandidate, resolveCandidate } };
  assert.equal(runCliCoder(['remember', sourceFile, ...flags, '--run-id', 'source'], opts).status, 'remembered');
  fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before');
  const result = runCliCoder([intentFile, ...flags, '--run-id', 'cli-target'], opts);
  assert.equal(result.status, 'completed', result.data.reason);
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'after');
  fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'process restart\nbefore\n');
  git(['add', 'docs/a.md']);
  commit();
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '..', 'cli.js'),
    'coder', intentFile, '--root', f.root, '--journal', path.join(f.root, 'journal.db'),
    '--use-memory', '--run-id', 'cli-restart', '--json'],
  { cwd: f.root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(f.root, '.huqan', 'runtime-state') } });
  const restarted = JSON.parse(output);
  assert.equal(restarted.status, 'completed', restarted.data?.reason);
  assert.equal(restarted.data.repoStateKnown, true);
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'process restart\nafter\n',
    JSON.stringify({ outcome: restarted.data.outcome, reason: restarted.data.reason,
      experience: restarted.data.experience }));
});

test('memory selects a sealed method for a new context without method text or a filename', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const task = { id: 'new-task', level: 'l0', allowedPaths: ['docs/a.md'],
    operation: { type: 'replace_text', path: 'docs/a.md' } };
  fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'unseen context\nbefore\n');
  const store = f.open();
  try {
    const baseline = applyDerivation({ task, root: f.root, repoState: STATE });
    assert.equal(baseline.ok, false);
    const alternate = { ...SOURCE, operation: { ...SOURCE.operation, find: 'other-before', replace: 'other-after' } };
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'other-before');
    assert.equal(applyDerivation({ task: alternate, root: f.root, repoState: STATE,
      journal: store.journal, runId: 'unrelated-source' }).ok, true);
    assert.equal(rememberCandidate({ task: alternate, root: f.root, journal: store.journal,
      file: path.join(path.dirname(f.file), 'unrelated.json'), runId: 'unrelated-source',
      workspaceId: 'default', qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }).ok, true);
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'unseen context\nbefore\n');
    const selected = selectCandidate({ task, root: f.root, journal: store.journal, workspaceId: 'default' });
    assert.equal(selected.ok, true, selected.reason);
    assert.equal(selected.selectedFile, f.file);
    const learned = applyDerivation({ task: selected.task, root: f.root, repoState: STATE,
      journal: store.journal, runId: 'selected-new-task' });
    assert.equal(learned.ok, true, learned.reason);
    assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'unseen context\nafter\n');
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'no matching text');
    assert.equal(selectCandidate({ task, root: f.root, journal: store.journal,
      workspaceId: 'default' }).reason, 'no_applicable_candidate');
  } finally { store.close(); }
});

test('memory refuses competing verified replacements and corrupted candidates without writing', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const store = f.open();
  const task = { id: 'ambiguous-memory', level: 'l0', allowedPaths: ['docs/a.md'],
    operation: { type: 'replace_text', path: 'docs/a.md' } };
  try {
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before');
    const alternate = { ...SOURCE, operation: { ...SOURCE.operation, replace: 'another' } };
    assert.equal(applyDerivation({ task: alternate, root: f.root, repoState: STATE,
      journal: store.journal, runId: 'alternate-source' }).ok, true);
    const otherFile = path.join(path.dirname(f.file), 'other.json');
    assert.equal(rememberCandidate({ task: alternate, root: f.root, journal: store.journal,
      file: otherFile, runId: 'alternate-source', workspaceId: 'default',
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }).ok, true);
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before');
    assert.equal(selectCandidate({ task, root: f.root, journal: store.journal,
      workspaceId: 'default' }).reason, 'candidate_selection_ambiguous');
    fs.writeFileSync(otherFile, '{}');
    assert.equal(selectCandidate({ task, root: f.root, journal: store.journal,
      workspaceId: 'default' }).reason, 'invalid_candidate');
    assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'before');
  } finally { store.close(); }
});

test('restarted production CLI selects a learned code repair and passes independent held-out tests', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, 'src'));
  fs.mkdirSync(path.join(f.root, 'test'));
  const buggy = 'module.exports = value => value + 1;\n';
  fs.writeFileSync(path.join(f.root, 'src/double.js'), buggy);
  fs.writeFileSync(path.join(f.root, 'test/double.js'),
    "const assert = require('node:assert/strict'); const double = require('../src/double'); assert.equal(double(3), 6);\n");
  fs.writeFileSync(path.join(f.root, 'docs/ambiguous.md'), 'value + 1\nvalue + 1');
  fs.writeFileSync(path.join(f.root, '.gitignore'), '*.json\n*.db*\n.huqan/\n');
  const git = args => execFileSync('git', args, { cwd: f.root, stdio: 'pipe' });
  const commit = () => { git(['add', 'src', 'test', 'docs', '.gitignore']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']); };
  git(['init', '-qb', 'feat/code-memory']);
  commit();
  const taskFile = path.join(f.root, 'task.json');
  const source = { id: 'code-source', level: 'l0', allowedPaths: ['src/double.js'],
    operation: { type: 'replace_text', path: 'src/double.js', find: 'value + 1', replace: 'value * 2' },
    qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'], test: { command: 'node test/double.js' } };
  fs.writeFileSync(taskFile, JSON.stringify(source));
  const flags = ['--root', f.root, '--journal', path.join(f.root, 'journal.db')];
  const run = args => JSON.parse(execFileSync(process.execPath,
    [path.resolve(__dirname, '..', 'cli.js'), 'coder', ...args, '--json'], {
      cwd: f.root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
      env: { ...process.env, HUQAN_STATE_ROOT: path.join(f.root, '.huqan', 'runtime-state') },
    }));
  const trained = run([taskFile, ...flags, '--authorize', '--run-id', 'code-source']);
  assert.equal(trained.status, 'completed', trained.data.reason);
  assert.equal(trained.data.record.observedVerification.ok, true);
  const saved = run(['remember', taskFile, ...flags, '--candidate-file', f.file, '--run-id', 'code-source:c1']);
  assert.equal(saved.status, 'completed', JSON.stringify(saved));
  assert.equal(saved.data.ok, true);
  assert.equal(saved.data.registered, false);
  fs.writeFileSync(path.join(f.root, 'src/double.js'), '// held-out context\n' + buggy);
  fs.writeFileSync(path.join(f.root, 'test/double.js'),
    "const assert = require('node:assert/strict'); const double = require('../src/double'); assert.equal(double(5), 10); assert.equal(double(8), 16);\n");
  commit();
  const intent = { id: 'held-out-code', level: 'l0', allowedPaths: ['src/double.js'],
    operation: { type: 'replace_text', path: 'src/double.js' }, test: source.test };
  fs.writeFileSync(taskFile, JSON.stringify(intent));
  const { runCliCoder } = require('../lib/cli-coder');
  const baseline = runCliCoder([taskFile, ...flags, '--authorize'], {
    json: true, coderLoop: require('../lib/coder/fix-loop') });
  assert.equal(baseline.status, 'refused');
  assert.equal(fs.readFileSync(path.join(f.root, 'src/double.js'), 'utf8'), '// held-out context\n' + buggy);
  const learned = run([taskFile, ...flags, '--use-memory', '--authorize', '--run-id', 'held-out-code']);
  assert.equal(learned.status, 'completed', learned.data.reason);
  assert.equal(learned.data.attempts.length, 1);
  assert.equal(learned.data.attempts[0].test.ok, true);
  assert.equal(learned.data.record.observedVerification.ok, true);
  assert.equal(fs.readFileSync(path.join(f.root, 'src/double.js'), 'utf8'),
    '// held-out context\nmodule.exports = value => value * 2;\n');
});

test('selection is read-only when memory is absent and bounds the pool and target', t => {
  const f = fixture(t);
  const store = f.open();
  const task = { id: 'bounded-selection', level: 'l0', allowedPaths: ['docs/a.md'],
    operation: { type: 'replace_text', path: 'docs/a.md' } };
  const select = () => selectCandidate({ task, root: f.root, journal: store.journal, workspaceId: 'default' });
  try {
    assert.equal(select().reason, 'no_applicable_candidate');
    assert.equal(fs.existsSync(path.dirname(f.file)), false);
    assert.equal(remember(f).ok, true);
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before');
    for (let i = 0; i < 31; i++) fs.copyFileSync(f.file, path.join(path.dirname(f.file), `extra-${i}.json`));
    assert.equal(select().reason, 'candidate_selection_ambiguous');
    fs.writeFileSync(path.join(path.dirname(f.file), 'extra-31.json'), '{}');
    assert.equal(select().reason, 'candidate_pool_limit');
    for (let i = 0; i < 32; i++) fs.unlinkSync(path.join(path.dirname(f.file), `extra-${i}.json`));
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before' + 'x'.repeat(131066));
    assert.equal(select().ok, true);
    fs.appendFileSync(path.join(f.root, 'docs/a.md'), 'x');
    assert.equal(select().reason, 'candidate_target_limit');
    assert.equal(fs.statSync(path.join(f.root, 'docs/a.md')).size, 131073);
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before');
    assert.equal(selectCandidate({ task, root: f.root, journal: store.journal,
      workspaceId: 'foreign' }).reason, 'invalid_candidate');
  } finally { store.close(); }
});

test('CLI rejects incompatible memory-selection modes before reading a task or opening a journal', () => {
  const { runCliCoder } = require('../lib/cli-coder');
  for (const args of [
    ['missing-task.json', '--use-memory', '--dry-run'],
    ['missing-task.json', '--use-memory', '--candidate-file', 'candidate.json'],
    ['create', 'missing-task.json', '--use-memory', '--dry-run'],
    ['remember', 'missing-task.json', '--use-memory'],
  ]) assert.throws(() => runCliCoder(args, { json: true }), /Memory selection requires/);
});

test('selection refuses a candidate-directory link before reading any method', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const directory = path.dirname(f.file);
  fs.renameSync(directory, `${directory}-original`);
  fs.symlinkSync(f.root, directory, process.platform === 'win32' ? 'junction' : 'dir');
  const store = f.open();
  try {
    const result = selectCandidate({ task: { allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md' } }, root: f.root,
      journal: store.journal, workspaceId: 'default' });
    assert.equal(result.reason, 'candidate_symlink_refused');
    assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'after');
  } finally { store.close(); }
});

test('a candidate from another workspace is refused', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const store = f.open();
  try { assert.equal(resolveCandidate({ task: SOURCE, journal: store.journal, file: f.file,
    workspaceId: 'foreign', root: f.root }).reason, 'invalid_candidate'); } finally { store.close(); }
});

test('editing a sealed source after remembering is refused on the next load', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const { Database } = loadSqliteDriver();
  const db = new Database(path.join(f.root, 'journal.db'));
  try { db.exec("UPDATE experience_journal SET body = replace(body, 'feat/candidate', 'feat/forged') WHERE run_id = 'source' AND type = 'run_started'"); }
  finally { db.close(); }
  const store = f.open();
  try { assert.equal(resolveCandidate({ task: SOURCE, journal: store.journal, file: f.file,
    workspaceId: 'default', root: f.root }).reason, 'integrity_mismatch'); }
  finally { store.close(); }
});

test('a remembered method still refuses an ambiguous target without writing it', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const store = f.open();
  try {
    const task = { ...SOURCE, operation: { type: 'replace_text', path: 'docs/a.md' } };
    const resolved = resolveCandidate({ task, journal: store.journal, file: f.file,
      workspaceId: 'default', root: f.root });
    fs.writeFileSync(path.join(f.root, 'docs/a.md'), 'before before');
    const result = applyDerivation({ task: resolved.task, root: f.root, repoState: STATE,
      journal: store.journal, runId: 'ambiguous' });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'before before');
  } finally { store.close(); }
});

test('remember refuses method text that differs from sealed evidence and writes nothing', t => {
  const f = fixture(t);
  assert.equal(remember(f, { ...SOURCE, operation: { ...SOURCE.operation, replace: 'forged' } }).ok, false);
  assert.equal(fs.existsSync(f.file), false);
});

test('remember never overwrites an existing candidate file', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const original = fs.readFileSync(f.file, 'utf8');
  assert.equal(remember(f).ok, false);
  assert.equal(fs.readFileSync(f.file, 'utf8'), original);
});

test('edited candidate data is refused before it can supply a task', t => {
  const f = fixture(t);
  assert.equal(remember(f).ok, true);
  const data = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  data.params.newText = 'forged';
  fs.writeFileSync(f.file, JSON.stringify(data));
  const store = f.open();
  try { assert.equal(resolveCandidate({ task: SOURCE, journal: store.journal, file: f.file,
    workspaceId: 'default', root: f.root }).ok, false); } finally { store.close(); }
});

test('candidate storage cannot create a package or source file', t => {
  const f = fixture(t);
  f.file = path.join(f.root, 'package.json');
  assert.equal(remember(f).reason, 'invalid_candidate_path');
  assert.equal(fs.existsSync(f.file), false);
});

test('a candidate-directory junction cannot redirect a write into the repository root', t => {
  const f = fixture(t);
  fs.mkdirSync(path.join(f.root, '.huqan', 'coder'), { recursive: true });
  fs.symlinkSync(f.root, path.join(f.root, '.huqan', 'coder', 'candidates'), 'junction');
  f.file = path.join(f.root, '.huqan', 'coder', 'candidates', 'package.json');
  assert.equal(remember(f).reason, 'candidate_symlink_refused');
  assert.equal(fs.existsSync(path.join(f.root, 'package.json')), false);
});
