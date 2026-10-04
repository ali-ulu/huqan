'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { loadSqliteDriver } = require('../lib/sqlite-availability');

test('learned dispatch refuses before disk effect when SQLite cannot record execution start', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-learned-durability-'));
  const journalPath = path.join(root, 'journal.db');
  const target = path.join(root, 'docs/a.md');
  let store;
  try {
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'before');
    fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
    fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
    const task = { id: 'durable-learned', level: 'l0', allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
    const repoState = { branch: 'feat/test', dirty: false, hasUntracked: false };
    store = openCoderJournal(journalPath);
    const source = applyDerivation({ task, root, repoState, journal: store.journal, runId: 'source' });
    assert.equal(source.ok, true);
    assert.equal(store.journal.manifest('source').learningEligibility, 'positive_procedure');
    store.close();

    // A real committed SQLite rejection, with normal clocks, driver and I/O.
    const { Database } = loadSqliteDriver();
    const db = new Database(journalPath);
    try {
      db.exec(`CREATE TRIGGER refuse_learned_start BEFORE INSERT ON experience_journal
        WHEN NEW.run_id = 'denied' AND NEW.type = 'execution_started'
        BEGIN SELECT RAISE(FAIL, 'fixture execution-start commit refused'); END`);
    } finally { db.close(); }
    store = openCoderJournal(journalPath);
    fs.writeFileSync(target, 'before');
    const experience = { riskTier: 'low', candidates: [{ capabilityId: 'replace',
      sourceRunIds: ['source'], qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }] };
    const denied = applyDerivation({ task: { ...task, experience }, root, repoState,
      journal: store.journal, runId: 'denied' });
    assert.equal(denied.ok, false, 'unacknowledged learned execution must not write');
    assert.equal(denied.reason, 'learned_execution_evidence_failed');
    assert.equal(denied.experience.failed, 'persist_failed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    store.close();
    store = openCoderJournal(journalPath);
    const events = store.journal.read('denied');
    assert.ok(events.some(event => event.type === 'routing_decided'));
    assert.ok(!events.some(event => event.type === 'execution_started' || event.type === 'execution_finished'));
    assert.notEqual(store.journal.manifest('denied').learningEligibility, 'positive_procedure');
    assert.equal(store.journal.manifest('source').learningEligibility, 'positive_procedure');
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a read-only journal cannot authorize a learned disk effect', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-learned-readonly-'));
  const target = path.join(root, 'docs/a.md');
  let store;
  try {
    fs.mkdirSync(path.dirname(target));
    fs.writeFileSync(target, 'before');
    fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
    fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
    const task = { id: 'readonly-learned', level: 'l0', allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
    const repoState = { branch: 'feat/test', dirty: false, hasUntracked: false };
    const journalPath = path.join(root, 'journal.db');
    store = openCoderJournal(journalPath);
    assert.equal(applyDerivation({ task, root, repoState, journal: store.journal, runId: 'source' }).ok, true);
    store.close();
    store = openCoderJournal(journalPath);
    fs.writeFileSync(target, 'before');
    const experience = { riskTier: 'low', candidates: [{ capabilityId: 'replace',
      sourceRunIds: ['source'], qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }] };
    const readOnlyJournal = { ...store.journal, append: undefined };
    const denied = applyDerivation({ task: { ...task, experience }, root, repoState,
      journal: readOnlyJournal, runId: 'readonly-denied' });
    assert.equal(denied.ok, false, 'sealed source reads do not acknowledge a new execution');
    assert.equal(denied.reason, 'learned_execution_evidence_failed');
    assert.equal(fs.readFileSync(target, 'utf8'), 'before');
    assert.deepEqual(store.journal.read('readonly-denied'), []);
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
