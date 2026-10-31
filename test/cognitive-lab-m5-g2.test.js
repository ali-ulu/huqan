'use strict';

// #4068 [COG-M5] G2 H1 measurement: router-based arm vs always-SYSTEM2 arm.
//
// Preregistration (LOCKED): docs/task-packs/cog-m5-g2-preregistration-20261029.md
// Result record:           docs/task-packs/cog-m5-g2-result-20261030.md
//
// Both arms run the same real Coder path through the two-arm Lab harness
// (test/helpers/cog-m5-harness.js). The test asserts the measurement is real and
// honest — arms diverge, integrity counters are measured (not assumed), the
// decision uses the preregistered N=24 — and prints the result document body so
// the record can be checked against what actually ran.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { measure } = require('./helpers/cog-m5-harness');

// §5, frozen before any episode.
const CONTRACT = Object.freeze({
  preregistration: 'docs/task-packs/cog-m5-g2-preregistration-20261029.md',
  pairedSamples: 24,
  warmupRuns: 30,
});

test('M5 G2: two-arm Lab measures a real router-vs-SYSTEM2 paired delta', { timeout: 600000 }, t => {
  const m = measure({ pairs: CONTRACT.pairedSamples, warmup: CONTRACT.warmupRuns });
  t.after(() => fs.rmSync(m.parent, { recursive: true, force: true }));

  // (i) The arms really took different paths: the candidate consulted the router
  // and the baseline never did. Without this the "measurement" would be scoring
  // advice nobody acted on, or two runs of the same arm.
  assert.equal(m.diverged, true, `arms did not diverge: ${JSON.stringify(m.modes)}`);
  assert.ok(m.modes.candidate.SYSTEM1 >= 1, 'candidate arm never took the router fast path');
  assert.equal(m.modes.candidate.SYSTEM2 || 0, 0, 'candidate arm fell back to deliberation');
  assert.equal(m.modes.baseline.SYSTEM1 || 0, 0, 'baseline arm took a shortcut');
  assert.equal(m.modes.baseline.SYSTEM2, CONTRACT.pairedSamples, 'baseline arm did not always deliberate');

  // (ii) Integrity: the firewall refuses an unauthorized write (measured), so the
  // bypass counters passed to the evaluator are observed, not assumed.
  assert.equal(m.firewall.refused, true, 'firewall did not refuse an unauthorized write');

  // The paired cost is a real measured difference: the shortcut arm spawns fewer
  // verification processes than the deliberating arm on every pair.
  assert.ok(m.runs.every(run => run.candidate.processes < run.baseline.processes),
    'the shortcut arm did not save verification processes');
  assert.ok(m.runs.every(run => run.baseline.success && run.candidate.success),
    'an arm failed a supported task; failed work must stay visible, not be excluded');

  // The decision uses the frozen N=24 and the frozen evaluator. The cost
  // advantage is measured; the success gate is scored on the exact lower bound,
  // and at N=24 with no discordant pair that bound (~-0.117) does not clear the
  // -0.05 margin. So H1 is not passed: the cost advantage is real, the
  // non-inferiority claim is not established at this N. A zero-variance plug-in
  // interval would have reported 0 and a false PASS (#4422 review).
  assert.equal(m.result.pairedSamples, CONTRACT.pairedSamples);
  assert.equal(m.result.integrityGuard, true);
  assert.ok(m.result.meanCostDelta > 0, 'candidate was not cheaper per task');
  assert.equal(m.result.nonInferior, false, `non-inferiority was claimed from a degenerate bound: ${m.result.message}`);
  assert.equal(m.result.success, false, 'H1 was recorded as passed from a zero-width success bound');
  assert.ok(m.successCILower < -0.05 && m.successCILower > -0.2,
    `the success bound is not the conservative one the review asked for: ${m.successCILower}`);

  // Evidence for the result document.
  const evidence = {
    preregistration: CONTRACT.preregistration,
    pairedSamples: CONTRACT.pairedSamples, warmupRuns: CONTRACT.warmupRuns,
    warmupProcesses: m.warm.processes, warmupWallMs: Math.round(m.warm.wallMs),
    modes: m.modes, diverged: m.diverged, firewall: m.firewall,
    baselineProcesses: m.runs.map(run => run.baseline.processes),
    candidateProcesses: m.runs.map(run => run.candidate.processes),
    baselineWallMedianMs: Math.round(m.baselineMedianWallMs),
    candidateWallMedianMs: Math.round(m.candidateMedianWallMs),
    costDelta: m.result.costDelta, meanCostDelta: m.result.meanCostDelta,
    successCILower: m.successCILower, nonInferior: m.result.nonInferior,
    integrityGuard: m.result.integrityGuard, decision: m.result.message,
  };
  console.log(`M5_G2_EVIDENCE ${JSON.stringify(evidence)}`);
});
