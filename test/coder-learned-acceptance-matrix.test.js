'use strict';

// #3310 B4 acceptance matrix for the opt-in learned coder caller: every source
// a lesson must not come from is refused at the public applyDerivation entry,
// against a real reopened SQLite journal, before the target file changes.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const { loadSqliteDriver } = require('../lib/sqlite-availability');

const TASK = { id: 'matrix', level: 'l0', allowedPaths: ['docs/a.md'],
  operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
const REPO_STATE = { branch: 'feat/test', dirty: false, hasUntracked: false };
const CANDIDATE = { capabilityId: 'replace', sourceRunIds: ['source'],
  qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] };
// Each row runs as a full task and as an intent-only task (#3310 B4 §11): the
// intent-only form carries no text and takes it from hash-bound params.
const MODES = Object.freeze({
  full: () => ({ ...TASK, experience: { riskTier: 'low', candidates: [CANDIDATE] } }),
  intentOnly: () => ({ ...TASK, operation: { type: 'replace_text', path: 'docs/a.md' },
    experience: { intentOnly: true, riskTier: 'low', candidates: [{ ...CANDIDATE,
      params: { path: 'docs/a.md', oldText: 'before', newText: 'after' } }] } }),
});

// Slow CI commits would trip the real-clock write-cost budget; a deterministic
// clock keeps the matrix about source admission alone.
function openJournal(root) {
  const store = openCoderJournal(path.join(root, 'journal.db'));
  let clock = 0;
  return { ...store, journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }) };
}

function withRoot(t, sourceContent = 'before') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-learned-matrix-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'docs'));
  fs.writeFileSync(path.join(root, 'docs/a.md'), sourceContent);
  fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
  fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
  return root;
}

function runSource(root) {
  const store = openJournal(root);
  try {
    const result = applyDerivation({ task: TASK, root, repoState: REPO_STATE, journal: store.journal, runId: 'source' });
    return { result, manifest: store.journal.manifest('source') };
  } finally { store.close(); }
}

function alterJournal(root, statement) {
  const { Database } = loadSqliteDriver();
  const db = new Database(path.join(root, 'journal.db'));
  try { db.exec(statement); } finally { db.close(); }
}

// Every dispatch reopens the journal, as a new process would.
function dispatchLearned(root, { runId = 'learned', workspaceId, mode = 'full' } = {}) {
  const target = path.join(root, 'docs/a.md');
  fs.writeFileSync(target, 'before');
  let store = openJournal(root);
  let result;
  try {
    result = applyDerivation({ task: MODES[mode](), root, repoState: REPO_STATE,
      journal: store.journal, runId, ...(workspaceId ? { workspaceId } : {}) });
  } finally { store.close(); }
  store = openJournal(root);
  try {
    return { result, content: fs.readFileSync(target, 'utf8'), types: store.journal.read(runId).map(event => event.type) };
  } finally { store.close(); }
}

function assertRefusedBeforeDisk(observed, reason) {
  assert.equal(observed.result.ok, false);
  assert.equal(observed.result.reason, reason);
  assert.equal(observed.content, 'before', 'a refused learned dispatch must not touch the target');
  assert.ok(!observed.types.includes('execution_started'), 'refusal precedes the execution record');
  assert.ok(observed.types.includes('run_closed'), 'the refusal itself is sealed evidence');
}

for (const mode of Object.keys(MODES)) {
  test(`${mode}: control: a verified sealed source dispatches its learned procedure to disk`, (t) => {
    const root = withRoot(t);
    assert.equal(runSource(root).manifest.learningEligibility, 'positive_procedure');
    const observed = dispatchLearned(root, { mode });
    assert.equal(observed.result.ok, true);
    assert.equal(observed.content, 'after');
    assert.ok(observed.types.includes('routing_decided') && observed.types.includes('execution_finished'));
  });

  test(`${mode}: a source record altered on disk is refused as an integrity mismatch`, (t) => {
    const root = withRoot(t);
    runSource(root);
    alterJournal(root, `UPDATE experience_journal SET body = replace(body, 'feat/test', 'feat/forged')
      WHERE run_id = 'source' AND type = 'run_started'`);
    assertRefusedBeforeDisk(dispatchLearned(root, { mode }), 'integrity_mismatch');
  });

  test(`${mode}: a source with the same operation but no qualified outcome cannot teach`, (t) => {
    const root = withRoot(t, 'before before');
    const source = runSource(root);
    assert.equal(source.result.ok, false);
    assert.equal(source.manifest.learningEligibility, 'ineligible');
    assertRefusedBeforeDisk(dispatchLearned(root, { mode }), 'source_not_eligible');
  });

  test(`${mode}: an executed source whose verification was censored cannot teach`, (t) => {
    const root = withRoot(t);
    runSource(root);
    alterJournal(root, `DELETE FROM experience_journal WHERE run_id = 'source' AND type = 'verification'`);
    const store = openJournal(root);
    try {
      const manifest = store.journal.manifest('source');
      assert.equal(manifest.executionStatus, 'completed');
      assert.equal(manifest.outcomeStatus, 'unknown');
    } finally { store.close(); }
    assertRefusedBeforeDisk(dispatchLearned(root, { mode }), 'source_not_eligible');
  });

  test(`${mode}: a source that never sealed is refused as still being written`, (t) => {
    const root = withRoot(t);
    runSource(root);
    alterJournal(root, `DELETE FROM experience_journal WHERE run_id = 'source' AND type = 'run_closed'`);
    assertRefusedBeforeDisk(dispatchLearned(root, { mode }), 'run_not_sealed');
  });

  test(`${mode}: a source from another workspace does not transfer across the workspace boundary`, (t) => {
    const root = withRoot(t);
    runSource(root);
    assertRefusedBeforeDisk(dispatchLearned(root, { workspaceId: 'other-workspace', mode }), 'workspace_mismatch');
  });

  test(`${mode}: replaying a completed learned request id after restart cannot repeat its disk effect`, (t) => {
    const root = withRoot(t);
    runSource(root);
    const first = dispatchLearned(root, { runId: 'once', mode });
    assert.equal(first.result.ok, true);
    const replay = dispatchLearned(root, { runId: 'once', mode });
    assert.equal(replay.result.ok, false);
    assert.equal(replay.result.reason, 'learned_execution_evidence_failed');
    assert.equal(replay.content, 'before', 'the replay must not rewrite the restored target');
    assert.deepEqual(replay.types, first.types, 'the sealed first run is not extended by the replay');
  });
}
