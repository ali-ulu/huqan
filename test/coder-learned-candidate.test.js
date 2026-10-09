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
const { rememberCandidate, resolveCandidate } = require('../lib/coder/learned-candidate');

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
    'coder', intentFile, ...flags, '--run-id', 'cli-restart', '--json'],
  { cwd: f.root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576,
    env: { ...process.env, HUQAN_STATE_ROOT: path.join(f.root, '.huqan', 'runtime-state') } });
  const restarted = JSON.parse(output);
  assert.equal(restarted.status, 'completed', restarted.data?.reason);
  assert.equal(restarted.data.repoStateKnown, true);
  assert.equal(fs.readFileSync(path.join(f.root, 'docs/a.md'), 'utf8'), 'process restart\nafter\n',
    JSON.stringify({ outcome: restarted.data.outcome, reason: restarted.data.reason,
      experience: restarted.data.experience }));
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
