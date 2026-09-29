'use strict';

/**
 * The wiring-debt ratchet (#3014).
 *
 * The dead-code gate already fails when an unreachable module appears without
 * a classification, so the classified total cannot grow silently. What it
 * cannot see is the opposite motion inside the ledger: acknowledgements can
 * churn (a reason is reworded, a module is swapped for another) while the
 * genuine wiring debt stays flat or grows. This test pins the NOT_YET_WIRED
 * count to config/reachability-baseline.json.
 *
 * The baseline moves only in the same PR as the ledger change that justifies
 * it: lowering it is the measurable goal of #3014 (a module gained a real
 * production caller or was proven unnecessary and removed); raising it is a
 * debt decision that has to say why in that PR's review, visibly, the same
 * way check-file-size makes a grown file argue for itself.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { NOT_YET_WIRED, analyzeReachability } = require('../lib/module-reachability');

const BASELINE_PATH = path.join(__dirname, '..', 'config', 'reachability-baseline.json');
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));

test('the wiring-debt ledger matches its recorded baseline', () => {
  assert.equal(
    Object.keys(NOT_YET_WIRED).length,
    baseline.measuredNotYetWired,
    'NOT_YET_WIRED count drifted from config/reachability-baseline.json: update the baseline in the same PR as the ledger change, with the reason in the PR description',
  );
});

test('the recorded baseline describes the live reachability surface', () => {
  const analysis = analyzeReachability();
  assert.equal(
    analysis.unreachable.length,
    baseline.unreachableTotal,
    'the classified-unreachable total moved without its baseline: re-measure and update config/reachability-baseline.json in the same PR',
  );
  // Every acknowledged module is still genuinely unreachable, so the ledger
  // cannot hide reachable modules behind stale acknowledgements.
  for (const acknowledged of Object.keys(NOT_YET_WIRED)) {
    assert.ok(
      !analysis.reachable.includes(acknowledged),
      `${acknowledged} is now reachable: remove its NOT_YET_WIRED acknowledgement (the dead-code gate would also flag it as stale)`,
    );
  }
});
