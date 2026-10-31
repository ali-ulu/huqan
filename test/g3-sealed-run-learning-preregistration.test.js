'use strict';

/**
 * G3 sealed-run learning source pin (#4432).
 *
 * The preregistration for the learning measurement
 * (`docs/task-packs/g3-sealed-run-learning-preregistration-20261030.md`) sources
 * tasks from a sealed synthesis run journal: a real `coder --synthesize
 * --journal` invocation whose `experience_journal` rows are hash-chained and
 * closed. This file drives the real CLI, the real journal store and the real
 * sealed-read seam, so the frozen protocol cannot be re-run against a source
 * that does not carry the learning mechanism (which #4428 showed the failure
 * record does not).
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', 'cli.js');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { readSealedRun, buildLearningProposal } = require('../lib/experience/learning-intake');
const { loadSqliteDriver } = require('../lib/sqlite-availability');

// A real synthesis task: buggy `n => n + 1`, target `n => n * 3 - 2`. The test
// command is independent, which is exactly what the learning arms require.
const SYNTH_TASK = Object.freeze({
  id: 'affine', level: 'l0', allowedPaths: ['src/f.js'],
  operation: { type: 'replace_text', path: 'src/f.js' },
  test: { command: 'node check.js' },
  synthesis: { family: 'arithmetic-expression', examples: [
    { input: 0, expected: -2 }, { input: 1, expected: 1 }, { input: 3, expected: 7 },
  ] },
});

function realRoot() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g3-sealed-')));
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init', '-qb', 'feat/g3-sealed');
  git('config', 'user.email', 'g3@example.invalid');
  git('config', 'user.name', 'g3');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'f.js'), 'module.exports = n => n + 1;\n', 'utf8');
  fs.writeFileSync(path.join(root, 'check.js'),
    "const a=require('node:assert/strict'),f=require('./src/f');a.equal(f(5),13);a.equal(f(8),22);\n", 'utf8');
  git('add', '.');
  git('commit', '-qm', 'base');
  return root;
}

/** Runs a real sealed synthesis invocation and returns its journal + runId. */
function sealedRun() {
  const root = realRoot();
  const taskFile = path.join(root, 'task.json');
  fs.writeFileSync(taskFile, JSON.stringify(SYNTH_TASK), 'utf8');
  const journalPath = path.join(root, 'journal.db');
  const stdout = execFileSync(process.execPath, [CLI, 'coder', taskFile, '--synthesize',
    '--authorize', '--root', root, '--journal', journalPath, '--run-id', 'affine', '--json'],
    { cwd: root, encoding: 'utf8', timeout: 120000 });
  const result = JSON.parse(stdout);
  return { root, journalPath, result, runId: 'affine:c1' };
}

test('a real synthesis run writes a sealed, hash-chained journal', () => {
  const { root, journalPath, result } = sealedRun();
  try {
    assert.equal(result.status, 'completed');
    assert.equal(result.data.outcome, 'applied_tested');
    assert.equal(result.data.synthesis.family, 'arithmetic-expression');

    const { Database } = loadSqliteDriver();
    const db = new Database(journalPath, { readonly: true });
    const rows = db.prepare('SELECT sequence, type, hash FROM experience_journal ORDER BY sequence').all();
    db.close();
    assert.deepEqual(rows.map(row => row.type), [
      'run_started', 'action_proposed', 'policy_decided', 'execution_started',
      'execution_finished', 'verification', 'run_closed',
    ]);
    assert.ok(rows.every(row => typeof row.hash === 'string' && row.hash.length === 64));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('the sealed read admits the run and refuses an open one', () => {
  const { root, journalPath, runId } = sealedRun();
  const { journal, close } = openCoderJournal(journalPath);
  try {
    const sealed = readSealedRun(journal, runId, 'default');
    assert.equal(sealed.ok, true);
    assert.equal(sealed.events.length, 7);
    assert.equal(sealed.manifest.closed, true);
    assert.equal(sealed.manifest.learningEligibility, 'positive_procedure');
    assert.equal(sealed.manifest.outcomeStatus, 'verified');
    assert.equal(typeof sealed.sourceHash, 'string');

    // A run id that was never sealed is refused, not invented.
    assert.equal(readSealedRun(journal, 'never-ran:c1', 'default').ok, false);
    assert.equal(readSealedRun(journal, 'never-ran:c1', 'default').code, 'run_not_found');

    // The sealed read feeds the real proposal builder, which never installs.
    const proposal = buildLearningProposal(journal, { runId, workspaceId: 'default' });
    assert.equal(proposal.ok, true);
    assert.equal(proposal.registered, false);
    assert.equal(proposal.admission.decision, 'admitted');
  } finally {
    close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
