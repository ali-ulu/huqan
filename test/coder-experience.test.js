'use strict';

/**
 * Coder Experience pilot (#2388 kabul 1).
 *
 * The agent step executor cannot run `replace_text`: its internal tools are
 * exactly learn/ask/verify/reason/compare/dream, so the pilot runs through
 * `applyDerivation` instead. These tests use a real Experience journal and a
 * real working tree — no mocks — and check the full chain under one runId:
 * run_started (pilot manifest) -> action_proposed -> policy_decided ->
 * execution_started -> execution_finished (patch evidence) -> verification
 * (disk re-read + hash compare) -> run_closed (verdict).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DERIVATION_OUTCOMES } = require('../lib/coder/derivation-record');
const { REFUSAL_REASONS, applyDerivation } = require('../lib/coder/apply-derivation');
const { createExperienceJournal } = require('../lib/experience/journal');
const { buildExperienceRead } = require('../lib/experience/read-model');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coder-xp-'));
  return fs.realpathSync(root);
}

function write(root, relative, content) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
}

function read(root, relative) {
  return fs.readFileSync(path.join(root, relative), 'utf8');
}

function docsTask(overrides = {}) {
  return {
    id: 'task-docs-xp-1',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
    ...overrides,
  };
}

const CLEAN_BRANCH = { branch: 'feat/coder-xp', dirty: false, hasUntracked: false };
const FIXED_NOW = '2026-09-27T00:00:00.000Z';

function typesOf(journal, runId) {
  return journal.read(runId).map((event) => event.type);
}

describe('coder experience pilot', () => {
  it('without a journal the pipeline behaves exactly as before (no experience field)', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');

    const result = applyDerivation({
      task: docsTask(), root, repoState: CLEAN_BRANCH, now: () => FIXED_NOW,
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
    assert.equal('experience' in result, false);
    assert.equal(read(root, 'docs/notes.md'), 'release v1.1.0 shipped\n');
  });

  it('a real replace_text pilot writes the full chain under one runId and closes complete', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');
    const journal = createExperienceJournal();

    const result = applyDerivation({
      task: docsTask(), root, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
    assert.equal(result.experience.failed, null);
    const { runId } = result.experience;

    // Executor report and independent read-back are separate: the file the
    // transform claims to have written is what the disk actually holds.
    assert.equal(read(root, 'docs/notes.md'), 'release v1.1.0 shipped\n');

    const events = journal.read(runId);
    assert.deepEqual(typesOf(journal, runId), [
      'run_started',
      'action_proposed',
      'policy_decided',
      'execution_started',
      'execution_finished',
      'verification',
      'run_closed',
    ]);

    // Every event after the first is caused by its predecessor — the chain
    // is one linked run, not seven loose claims.
    for (let index = 1; index < events.length; index += 1) {
      assert.equal(events[index].causedByEventId, events[index - 1].eventId);
      assert.equal(events[index].runId, runId);
    }

    const byType = Object.fromEntries(events.map((event) => [event.type, event]));
    assert.equal(byType.run_started.payload.pilot, 'coder-replace_text');
    assert.equal(byType.run_started.payload.taskId, 'task-docs-xp-1');
    assert.equal(byType.policy_decided.payload.decision, 'allow');
    assert.equal(byType.execution_finished.executionStatus, 'completed');
    assert.equal(byType.execution_finished.payload.derivationHash, result.record.derivationHash);
    assert.equal(byType.verification.outcomeStatus, 'verified');
    assert.deepEqual(byType.verification.proofs, {
      integrity: true, coverage: true, verification: true, provenance: true, permission: true,
    });
    assert.equal(journal.manifest(runId).learningEligibility, 'positive_procedure');
    assert.equal(byType.verification.payload.checks.length, 1);
    assert.equal(byType.verification.payload.checks[0].match, true);
    assert.equal(byType.run_closed.payload.verdict, 'complete');
    assert.equal(byType.run_closed.outcomeStatus, 'verified');
  });

  it('persists an eligible coder run and reads the same sealed projection after restart', (t) => {
    const Database = require('better-sqlite3');
    const root = makeRoot();
    const dbPath = path.join(root, 'experience.sqlite');
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');
    const firstDb = new Database(dbPath);
    const firstStore = { db: firstDb, withTransaction: (fn) => firstDb.transaction(fn)() };
    let runId;
    let firstEvents;
    try {
      const journal = createExperienceJournal({ store: firstStore });
      const result = applyDerivation({
        task: docsTask(), root, repoState: CLEAN_BRANCH,
        now: () => FIXED_NOW, journal, workspaceId: 'default',
      });
      assert.equal(result.ok, true);
      runId = result.experience.runId;
      assert.equal(journal.manifest(runId).learningEligibility, 'positive_procedure');
      firstEvents = journal.read(runId);
      for (const row of firstDb.prepare('SELECT event_id, body FROM experience_journal').all()) {
        assert.doesNotThrow(() => JSON.parse(row.body), row.event_id);
      }
    } finally {
      firstDb.close();
    }
    const reopenedDb = new Database(dbPath);
    t.after(() => reopenedDb.close());
    const reopened = createExperienceJournal({
      store: { db: reopenedDb, withTransaction: (fn) => reopenedDb.transaction(fn)() },
    });
    const projection = buildExperienceRead(reopened, { runId, workspaceId: 'default' });
    assert.equal(projection.ok, true, JSON.stringify(projection));
    assert.equal(projection.manifest.learningEligibility, 'positive_procedure');
    assert.deepEqual(projection.events, firstEvents);
    assert.deepEqual(projection.events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6, 7]);
    assert.equal(read(root, 'docs/notes.md'), 'release v1.1.0 shipped\n');
  });

  it('an injected filesystem cannot claim independent native read-back', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');
    const journal = createExperienceJournal();
    const delegatedFs = new Proxy(fs, {});
    const result = applyDerivation({
      task: docsTask(), root, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal, workspaceId: 'default', fs: delegatedFs,
    });
    assert.equal(result.ok, true);
    assert.equal(journal.manifest(result.experience.runId).learningEligibility, 'ineligible');
    const verification = journal.read(result.experience.runId).find((event) => event.type === 'verification');
    assert.equal(verification.proofs.verification, false);
    assert.equal(verification.outcomeStatus, 'unknown');
  });

  it('a gate refusal closes incomplete and writes nothing (no fake execution events)', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');
    const journal = createExperienceJournal();

    const result = applyDerivation({
      task: docsTask(), root,
      repoState: { branch: 'main', dirty: false, hasUntracked: false },
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REFUSAL_REASONS.GATE_REFUSED);
    assert.equal(result.gate.reason, 'MAIN_BRANCH_WRITE_BLOCKED');
    assert.equal(read(root, 'docs/notes.md'), 'release v1.0.0 shipped\n');

    assert.deepEqual(typesOf(journal, result.experience.runId), [
      'run_started',
      'action_proposed',
      'policy_decided',
      'failure',
      'run_closed',
    ]);
    const events = journal.read(result.experience.runId);
    const byType = Object.fromEntries(events.map((event) => [event.type, event]));
    assert.equal(byType.failure.causedByEventId, byType.policy_decided.eventId);
    assert.equal(byType.run_closed.payload.verdict, 'incomplete');
    assert.equal(byType.run_closed.outcomeStatus, 'failed');
    assert.equal(journal.manifest(result.experience.runId).learningEligibility, 'ineligible');
  });

  it('a journal that cannot write never blocks the derivation (evidence gap is reported)', () => {
    const root = makeRoot();
    write(root, 'docs/notes.md', 'release v1.0.0 shipped\n');
    // A journal handle whose append always refuses: the derivation must still
    // land, and the missing evidence must be visible, not silent.
    const brokenJournal = { append: () => ({ ok: false, code: 'persist_failed' }) };

    const result = applyDerivation({
      task: docsTask(), root, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal: brokenJournal, workspaceId: 'default',
    });

    assert.equal(result.ok, true);
    assert.equal(result.outcome, DERIVATION_OUTCOMES.APPLIED);
    assert.equal(result.experience.failed, 'persist_failed');
    assert.equal(read(root, 'docs/notes.md'), 'release v1.1.0 shipped\n');
  });

  it('journal and journal-less runs derive the same patch (wiring changes nothing)', () => {
    const rootA = makeRoot();
    const rootB = makeRoot();
    write(rootA, 'docs/notes.md', 'release v1.0.0 shipped\n');
    write(rootB, 'docs/notes.md', 'release v1.0.0 shipped\n');
    const journal = createExperienceJournal();

    const plain = applyDerivation({
      task: docsTask(), root: rootA, repoState: CLEAN_BRANCH, now: () => FIXED_NOW,
    });
    const wired = applyDerivation({
      task: docsTask(), root: rootB, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });

    assert.deepEqual(wired.patch, plain.patch);
    assert.equal(wired.record.derivationHash, plain.record.derivationHash);
  });
});
