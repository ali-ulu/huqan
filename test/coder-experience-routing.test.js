'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { applyDerivation } = require('../lib/coder/apply-derivation');
const { openCoderJournal } = require('../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');

function openRoutingJournal(file) {
  const store = openCoderJournal(file);
  let clock = 0;
  return { ...store, journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }) };
}

test('coder dispatches a learned procedure through real trust, registry and routing after restart', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-learned-route-'));
  let store;
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    fs.writeFileSync(path.join(root, 'docs/drift.md'), 'absent');
    fs.writeFileSync(path.join(root, 'docs/ambiguous.md'), 'before before');
    const task = { id: 'learned', level: 'l0', allowedPaths: ['docs/a.md'],
      operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } };
    const repoState = { branch: 'feat/test', dirty: false, hasUntracked: false };
    const journalPath = path.join(root, 'journal.db');
    store = openRoutingJournal(journalPath);
    const source = applyDerivation({ task, root, repoState, journal: store.journal, runId: 'source' });
    assert.equal(source.ok, true);
    assert.equal(store.journal.manifest('source').learningEligibility, 'positive_procedure');
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    assert.equal(applyDerivation({ task, root, repoState, journal: store.journal, runId: 'source-2' }).ok, true);
    store.close();
    store = openRoutingJournal(journalPath);
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const experience = { candidates: [{ capabilityId: 'replace', sourceRunIds: ['source', 'source-2'],
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] },
    { capabilityId: 'replace-secondary', sourceRunIds: ['source-2'],
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'] }], riskTier: 'low' };
    const result = applyDerivation({ task: { ...task, experience }, root, repoState,
      journal: store.journal, runId: 'routed' });
    assert.equal(result.ok, true);
    const events = store.journal.read('routed');
    const routing = events.find(event => event.type === 'routing_decided');
    assert.ok(routing, 'a live routing decision must precede the disk effect');
    assert.equal(routing.payload.chosenCapabilityId, 'replace');
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
    assert.equal(store.journal.manifest('routed').learningEligibility, 'positive_procedure');
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const denied = applyDerivation({ task: { ...task, experience: { ...experience, riskTier: 'high' } },
      root, repoState, journal: store.journal, runId: 'high-risk' });
    assert.equal(denied.ok, false);
    assert.equal(denied.reason, 'no_eligible_match');
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
    const alternate = { ...task, operation: { ...task.operation, replace: 'after-alternative' } };
    assert.equal(applyDerivation({ task: alternate, root, repoState, journal: store.journal, runId: 'alternate-source' }).ok, true);
    const trialExperience = { ...experience, candidates: [experience.candidates[0], {
      capabilityId: 'replace-secondary', sourceRunIds: ['alternate-source'], parentVersion: 1,
      params: { path: 'docs/a.md', oldText: 'before', newText: 'after-alternative' },
      qualificationPaths: ['docs/drift.md', 'docs/ambiguous.md'],
    }], canary: { trialId: 'trial-one',
      baselineCapabilityId: 'replace', candidateCapabilityId: 'replace-secondary' } };
    for (let index = 1; index <= 5; index += 1) {
      fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
      const trialRun = applyDerivation({ task: { ...task, experience: trialExperience }, root, repoState,
        journal: store.journal, runId: `trial-${index}` });
      assert.equal(trialRun.ok, true);
      const decision = store.journal.read(`trial-${index}`).find(event => event.type === 'routing_decided').payload;
      assert.equal(decision.canary.requestSequenceNumber, index);
      assert.equal(decision.chosenCapabilityId, index === 5 ? 'replace-secondary' : 'replace');
      assert.equal(decision.canary.sampled, index === 5);
      assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), index === 5 ? 'after-alternative' : 'after');
      const closed = store.journal.read(`trial-${index}`).at(-1);
      assert.ok(Number.isFinite(closed.payload.measurements.executionCost));
      if (index === 3) { store.close(); store = openRoutingJournal(journalPath); }
    }
    const oneCandidate = { ...experience, candidates: [experience.candidates[0]] };
    for (let index = 1; index <= 3; index += 1) {
      fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
      const failed = applyDerivation({ task: { ...task, experience: oneCandidate }, root, repoState,
        journal: store.journal, runId: `failed-${index}`,
        verify() { fs.writeFileSync(path.join(root, 'docs/a.md'), 'unexpected'); return { passed: false }; } });
      assert.equal(failed.ok, true);
      assert.equal(store.journal.manifest(`failed-${index}`).learningEligibility, 'negative_example');
    }
    store.close(); store = openRoutingJournal(journalPath);
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const refused = applyDerivation({ task: { ...task, experience: oneCandidate }, root, repoState,
      journal: store.journal, runId: 'demoted-refused' });
    assert.equal(refused.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
    const fallback = applyDerivation({ task: { ...task, experience: { ...oneCandidate, fallbackOnRefusal: true } },
      root, repoState, journal: store.journal, runId: 'explicit-fallback' });
    assert.equal(fallback.ok, true);
    assert.deepEqual(store.journal.read('explicit-fallback').find(event => event.type === 'routing_decided')
      .payload.fallback.capabilityIds, ['replace']);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
  } finally {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requested learned dispatch fails closed without its journal', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-no-route-store-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const result = applyDerivation({ root, repoState: { branch: 'feat/test' },
      task: { id: 'missing', level: 'l0', allowedPaths: ['docs/a.md'],
        operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' },
        experience: { candidates: [] } } });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
