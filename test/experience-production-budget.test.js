'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAgent } = require('../agentRuntime');
const { createExperienceJournal } = require('../lib/experience/journal');
const { budgetExperienceJournal } = require('../lib/experience/budgeted-journal');
const { applyDerivation } = require('../lib/coder/apply-derivation');

test('a slow acknowledged journal does not refuse the real coder disk effect', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-budget-effect-'));
  try {
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    let clock = 0;
    const journal = budgetExperienceJournal(createExperienceJournal(), { now: () => (clock += 10) });
    const result = applyDerivation({ root, journal, runId: 'over-budget', repoState: { branch: 'feat/test' },
      task: { id: 'budgeted', level: 'l0', allowedPaths: ['docs/a.md'],
        operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } } });
    assert.equal(result.ok, true, result.reason);
    assert.equal(journal.writeCost('over-budget').reason, 'write_cost_event_too_slow');
    assert.equal(journal.writeCostGuard('over-budget').decision, 'allow');
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'after');
    assert.equal(journal.manifest('over-budget').closed, true);
    assert.ok(journal.read('over-budget').some(event => event.proofs?.verification === true));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

for (const ceiling of [{ MAX_JSON_BYTES_PER_EVENT: 1 }, { MAX_EVENTS_PER_RUN: 1 }]) {
  test(`coder refuses a deterministic journal ceiling: ${Object.keys(ceiling)[0]}`, t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-budget-guard-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs/a.md'), 'before');
    const journal = budgetExperienceJournal(createExperienceJournal(), { ceiling, now: () => 0 });
    const result = applyDerivation({ root, journal, runId: 'guard', repoState: { branch: 'feat/test' },
      task: { id: 'guard', level: 'l0', allowedPaths: ['docs/a.md'],
        operation: { type: 'replace_text', path: 'docs/a.md', find: 'before', replace: 'after' } } });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'WRITE_COST_BUDGET_REFUSED');
    assert.equal(fs.readFileSync(path.join(root, 'docs/a.md'), 'utf8'), 'before');
    assert.equal(journal.manifest('guard').closed, true);
    assert.ok(journal.read('guard').some(event => event.type === 'failure'));
  });
}

test('slow committed writes keep their acknowledgement and later audit events', () => {
  const clock = [0, 10, 15, 20, 21];
  const journal = budgetExperienceJournal(createExperienceJournal(), { now: () => clock.shift() });
  const first = { runId: 'slow', eventId: 'start', type: 'run_started' };
  const result = journal.append(first);
  assert.equal(result.ok, true);
  assert.equal(result.writeCost.reason, 'write_cost_event_too_slow');
  assert.equal(journal.append(first).duplicate, true);
  assert.equal(journal.append({ ...first, eventId: 'next', type: 'action_proposed' }).ok, true);
  assert.equal(journal.read('slow').length, 2);
  assert.equal(journal.writeCost('slow').reason, 'write_cost_event_too_slow');
});

test('the run ceiling refuses the measured budget without discarding audit events', () => {
  const journal = budgetExperienceJournal(createExperienceJournal(), {
    ceiling: { MAX_EVENTS_PER_RUN: 1 }, now: () => 0,
  });
  const first = { runId: 'count', eventId: 'start', type: 'run_started' };
  assert.equal(journal.append(first).ok, true);
  assert.equal(journal.append({ ...first, eventId: 'next', type: 'action_proposed' }).writeCost.reason,
    'write_cost_too_many_events');
  assert.equal(journal.append(first).duplicate, true);
  assert.equal(journal.manifest('count').eventCount, 2);
});

test('production factory measures oversized events without breaking the audit chain', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-production-budget-'));
  const kernel = {};
  const agent = createAgent({ kernel, dbPath: path.join(dir, 'journal.db') });
  try {
    const journal = kernel.experienceJournal;
    assert.ok(journal);
    const result = journal.append({ runId: 'budget', eventId: 'large', type: 'run_started',
      workspaceId: 'default', payload: { content: 'x'.repeat(5000) } });
    assert.equal(result.ok, true);
    assert.equal(result.writeCost.decision, 'refuse');
    assert.ok(result.writeCost.measured.bytesPerEvent > result.writeCost.ceiling.MAX_JSON_BYTES_PER_EVENT);
    assert.equal(journal.read('budget').length, 1);
  } finally {
    agent.storage?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
