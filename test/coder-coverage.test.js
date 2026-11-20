'use strict';

/**
 * Coder pilot observation coverage (#2388: pilot adapter korelasyonu ve
 * gözlem kapsamı).
 *
 * The pilot's required adapter set is declared up front (filesystem only —
 * `CODER_PILOT_SCOPE` in lib/coder/experience-reporter.js) and the closing
 * verdict is derived from both proofs: disk (verified) and observation
 * (covered). No event is fabricated for a class the run never installed.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { REFUSAL_REASONS, applyDerivation } = require('../lib/coder/apply-derivation');
const { CODER_PILOT_SCOPE, createCoderReporter } = require('../lib/coder/experience-reporter');
const { createExperienceJournal } = require('../lib/experience/journal');

function makeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coder-cov-'));
  return fs.realpathSync(root);
}

function docsTask(overrides = {}) {
  return {
    id: 'task-cov-1',
    level: 'l0',
    allowedPaths: ['docs/notes.md'],
    operation: { type: 'replace_text', path: 'docs/notes.md', find: 'v1.0.0', replace: 'v1.1.0' },
    ...overrides,
  };
}

const CLEAN_BRANCH = { branch: 'feat/coder-cov', dirty: false, hasUntracked: false };
const FIXED_NOW = '2026-09-27T00:00:00.000Z';

function byType(journal, runId) {
  return Object.fromEntries(journal.read(runId).map((event) => [event.type, event]));
}

describe('coder pilot coverage', () => {
  it('declares the filesystem scope and closes covered + complete', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
    const journal = createExperienceJournal();

    const result = applyDerivation({
      task: docsTask(), root, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });

    assert.equal(result.ok, true);
    const events = byType(journal, result.experience.runId);
    assert.deepEqual(events.run_started.payload.adapterScope, {
      installed: ['filesystem'],
      active: ['filesystem'],
      required: ['filesystem'],
    });
    assert.equal(events.run_closed.payload.coverage.covered, true);
    assert.deepEqual(events.run_closed.payload.coverage.missingRequired, []);
    assert.equal(events.run_closed.payload.verdict, 'complete');
  });

  it('a refused run closes uncovered: required filesystem observed nothing', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
    const journal = createExperienceJournal();

    const result = applyDerivation({
      task: docsTask(), root,
      repoState: { branch: 'main', dirty: false, hasUntracked: false },
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, REFUSAL_REASONS.GATE_REFUSED);
    const events = byType(journal, result.experience.runId);
    assert.equal(events.run_closed.payload.coverage.covered, false);
    assert.deepEqual(events.run_closed.payload.coverage.missingRequired, ['filesystem']);
    assert.equal(events.run_closed.payload.verdict, 'incomplete');
  });

  it('never-installed classes are unsupported, never observed, never fabricated', () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
    const journal = createExperienceJournal();

    const result = applyDerivation({
      task: docsTask(), root, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });

    const events = journal.read(result.experience.runId);
    const types = events.map((event) => event.type);
    assert.ok(!types.includes('routing_decided'));
    for (const event of events) {
      const text = JSON.stringify(event.payload || {});
      assert.ok(!text.includes('browser'), `no browser claim in ${event.type}`);
    }
    assert.deepEqual(CODER_PILOT_SCOPE, {
      installed: ['filesystem'],
      active: ['filesystem'],
      required: ['filesystem'],
    });
  });

  it('a malformed scope fails fast instead of running uncovered', () => {
    const journal = createExperienceJournal();
    assert.throws(
      () => createCoderReporter(journal, {
        runId: 'run-bad-scope',
        task: docsTask(),
        adapterScope: { installed: ['filesystem'], active: [], required: ['browser'] },
      }),
      /valid adapter scope/,
    );
  });
});

describe('learning evidence reaches the journal (#4621)', () => {
  // The task shape `coder propose --source` emits: the producer attaches the
  // resolved acceptance evidence (lib/experience/learning-source.js
  // attachLearningSource) and the coder path must not drop it on the way in.
  const LEARNING_SOURCE = Object.freeze({
    eligibility: 'positive_procedure',
    sourceHash: 'a'.repeat(64),
    outcomeStatus: 'verified',
    observedHash: 'b'.repeat(64),
    expectedHash: 'c'.repeat(64),
    allowedPaths: ['docs/notes.md'],
    oracle: {
      commandHash: 'd'.repeat(64),
      channel: 'ci',
      approvalId: 'acceptance-1',
      actionHash: 'e'.repeat(64),
    },
  });

  function runWith(taskOverrides) {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
    fs.writeFileSync(path.join(root, 'docs/notes.md'), 'release v1.0.0 shipped\n', 'utf8');
    const journal = createExperienceJournal();
    const result = applyDerivation({
      task: docsTask(taskOverrides), root, repoState: CLEAN_BRANCH,
      now: () => FIXED_NOW, journal, workspaceId: 'default',
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    return byType(journal, result.experience.runId);
  }

  it('seals the source hash, oracle binding and outcome into run_started', () => {
    const events = runWith({ learningSource: { ...LEARNING_SOURCE } });
    assert.deepEqual(events.run_started.payload.learningSource, LEARNING_SOURCE);
  });

  it('leaves a plain task\'s payload unchanged', () => {
    const events = runWith({});
    assert.equal('learningSource' in events.run_started.payload, false);
  });

  it('copies only the sealed fields, never the command body', () => {
    // The task may carry the resolved `test` command; the payload must carry
    // its hash (inside oracle.commandHash) and not the executable text.
    const events = runWith({
      learningSource: { ...LEARNING_SOURCE, oracle: { ...LEARNING_SOURCE.oracle } },
      test: { command: 'node --test test/version.test.js', timeoutMs: 120000 },
    });
    const payload = events.run_started.payload.learningSource;
    assert.deepEqual(Object.keys(payload.oracle).sort(),
      ['actionHash', 'approvalId', 'channel', 'commandHash']);
    assert.equal(JSON.stringify(payload).includes('test/version.test.js'), false);
  });
});
