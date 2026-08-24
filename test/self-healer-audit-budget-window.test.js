'use strict';

/**
 * AB10's ceiling is per workspace and per time window. The audit plugin's
 * counter was neither.
 *
 * Without a window it behaved like "200 iterations for the lifetime of the
 * process": once spent, self-healer auditing was blocked permanently, and
 * waiting an hour did not help because nothing read the clock. Without a
 * workspace, one tenant's audit volume consumed another tenant's budget --
 * exactly what a workspace-scoped ceiling exists to prevent.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { _test: { governFindings } } = require('../plugins/self-healer-audit');
const { DEFAULT_WINDOW_MS } = require('../lib/agent-loop-budget-gate');

function findings(count) {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'release_hygiene',
    severity: 'low',
    title: `finding ${index}`,
    summary: 'x',
    evidence: [],
    affectedFiles: [],
  }));
}

test('the budget refills once the window has passed', () => {
  const kernel = {};
  const start = 1_000_000;

  // Spend the default ceiling inside one window.
  for (let round = 0; round < 4; round += 1) {
    governFindings(kernel, findings(50), { workspaceId: 'ws', now: start + round });
  }
  const exhausted = governFindings(kernel, findings(50), { workspaceId: 'ws', now: start + 5 });
  assert.equal(exhausted.blockedByBudget, true, 'the ceiling must still be reached');

  const afterWindow = governFindings(kernel, findings(50), { workspaceId: 'ws', now: start + DEFAULT_WINDOW_MS + 1 });

  assert.equal(afterWindow.blockedByBudget, false, 'a rolling window has to refill');
});

test('spending inside the window still counts', () => {
  const kernel = {};
  const start = 2_000_000;

  for (let round = 0; round < 4; round += 1) {
    governFindings(kernel, findings(50), { workspaceId: 'ws', now: start + round });
  }
  const stillInWindow = governFindings(kernel, findings(50), {
    workspaceId: 'ws',
    now: start + DEFAULT_WINDOW_MS - 1,
  });

  assert.equal(stillInWindow.blockedByBudget, true);
});

test('one tenant cannot spend another tenant budget', () => {
  const kernel = {};
  const now = 3_000_000;

  for (let round = 0; round < 4; round += 1) {
    governFindings(kernel, findings(50), { workspaceId: 'tenant-a', now: now + round });
  }
  const aBlocked = governFindings(kernel, findings(50), { workspaceId: 'tenant-a', now });
  const bFresh = governFindings(kernel, findings(50), { workspaceId: 'tenant-b', now });

  assert.equal(aBlocked.blockedByBudget, true, 'tenant-a spent its own budget');
  assert.equal(bFresh.blockedByBudget, false, 'tenant-b must not pay for it');
});

test('a blocked run does not consume more budget', () => {
  const kernel = {};
  const now = 4_000_000;

  for (let round = 0; round < 4; round += 1) {
    governFindings(kernel, findings(50), { workspaceId: 'ws', now: now + round });
  }
  governFindings(kernel, findings(50), { workspaceId: 'ws', now });

  const afterWindow = governFindings(kernel, findings(1), { workspaceId: 'ws', now: now + DEFAULT_WINDOW_MS + 1 });
  assert.equal(afterWindow.blockedByBudget, false);
});

test('a normal audit under the ceiling is not blocked', () => {
  const kernel = {};

  const result = governFindings(kernel, findings(3), { workspaceId: 'ws', now: 5_000_000 });

  assert.equal(result.blockedByBudget, false);
});

test('the default workspace is a workspace like any other', () => {
  const kernel = {};
  const now = 6_000_000;

  for (let round = 0; round < 4; round += 1) {
    governFindings(kernel, findings(50), { now: now + round });
  }

  assert.equal(governFindings(kernel, findings(50), { now }).blockedByBudget, true);
  assert.equal(governFindings(kernel, findings(50), { workspaceId: 'other', now }).blockedByBudget, false);
});
