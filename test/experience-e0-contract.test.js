/**
 * Experience Core E0-b — the ten contract tests, GREEN milestone (#2374).
 *
 * Status: GREEN. These tests were written BEFORE any implementation of the
 * journal/contract and watched to fail against the naive stub (PR #2539,
 * RED milestone). The stub is gone: the suite now runs against the real
 * E2 journal (`lib/experience/journal.js`, #2377) over the E1 contract
 * (`lib/experience/contract.js`, #2376), and every test passes.
 *
 * Notes:
 * - Rule 5 of #2374 is split into 5a (payload conflict) and 5b (stale-head
 *   conflict): one rule, two independently breakable behaviors.
 * - E1's "repair starts a new attempt and does NOT inherit the old approval"
 *   is a pure-admissibility rule for `lib/experience/contract.js` (#2376), not
 *   a journal rule, so it has no test here. It has one there.
 * - Hermetic: in-memory only, no I/O, no timers, no network.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert');

const { createExperienceJournal } = require('../lib/experience/journal');

/** GREEN milestone: the naive stub is replaced by the real journal. */
function createNaiveJournal() {
  return createExperienceJournal();
}

describe('E0-b contract tests, GREEN against the real journal (#2374)', () => {
  it('1. run isolation — events of one run never appear in another read', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'runA', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    assert.strictEqual(j.read('runB', { workspaceId: 'ws' }).length, 0);
  });

  it('2. sequence integrity — replayed or reordered writes are rejected', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    const res = j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e2', type: 'action_proposed', sequence: 99 });
    assert.strictEqual(res.ok, false);
  });

  it('3. attempt correlation — attemptId/invocationId resolve back to one runId', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'runA', workspaceId: 'ws', eventId: 'e1', type: 'action_proposed', attemptId: 'att1', invocationId: 'inv1' });
    j.append({ runId: 'runB', workspaceId: 'ws', eventId: 'e2', type: 'action_proposed', attemptId: 'att1', invocationId: 'inv2' });
    assert.deepStrictEqual(j.runsForAttempt('att1'), ['runA']);
  });

  it('4. idempotency — same eventId twice is one event, reported as duplicate', () => {
    const j = createNaiveJournal();
    const evt = { runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' };
    j.append(evt);
    const second = j.append({ ...evt });
    assert.strictEqual(second.duplicate, true);
    assert.strictEqual(j.read('r', { workspaceId: 'ws' }).length, 1);
  });

  it('5a. conflict detection — same eventId with different payload is rejected', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'action_proposed', payload: { a: 1 } });
    const res = j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'action_proposed', payload: { a: 2 } });
    assert.strictEqual(res.ok, false);
  });

  it('5b. conflict detection — stale expected-head appends conflict', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    const first = j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e2', type: 'action_proposed' }, { expectedHead: 1 });
    assert.strictEqual(first.ok, true);
    const stale = j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e3', type: 'action_proposed' }, { expectedHead: 1 });
    assert.strictEqual(stale.ok, false);
  });

  it('6. closed-run immutability — appends after run_closed are refused', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    j.close('r');
    const res = j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e2', type: 'action_proposed' });
    assert.strictEqual(res.ok, false);
  });

  it('7. missing-outcome handling — no verification means unknown, ineligible', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e2', type: 'execution_finished', executionStatus: 'completed' });
    const m = j.manifest('r');
    assert.strictEqual(m.outcomeStatus, 'unknown');
    assert.strictEqual(m.learningEligibility, 'ineligible');
  });

  it('8. workspace isolation — runs are invisible across workspaces', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws1', eventId: 'e1', type: 'run_started' });
    assert.strictEqual(j.read('r', { workspaceId: 'ws2' }).length, 0);
  });

  it('9. parent-child causality — cross-run causedBy is refused, parent recoverable', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'runA', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    const cross = j.append({ runId: 'runB', workspaceId: 'ws', eventId: 'e2', type: 'action_proposed', causedByEventId: 'e1' });
    assert.strictEqual(cross.ok, false);
    j.append({ runId: 'child', workspaceId: 'ws', eventId: 'e3', type: 'run_started', parentRunId: 'parent' });
    assert.strictEqual(j.parentOf('child'), 'parent');
  });

  it('10. verification separation — completed alone never yields verified', () => {
    const j = createNaiveJournal();
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e1', type: 'run_started' });
    j.append({ runId: 'r', workspaceId: 'ws', eventId: 'e2', type: 'execution_finished', executionStatus: 'completed' });
    assert.notStrictEqual(j.manifest('r').outcomeStatus, 'verified');
  });
});
