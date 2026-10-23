'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { runM7ValuePilot } = require('../lib/cognitive-lab-m7-experiment');
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

test('measured M9 arousal alone changes an actual safe-family execution and replays after restart', () => {
  const result = runM7ValuePilot();
  assert.equal(result.assertsGain, false);
  assert.equal(result.status, 'CONTROLLED_FIXTURE_ONLY');
  const { candidate, arousalOff, replay } = result.arms;
  assert.deepEqual(candidate.scorer.before, arousalOff.scorer.before);
  assert.deepEqual(candidate.scorer.before, replay.scorer.before);
  const withoutArousal = input => ({ ...input, candidates: input.candidates.map(({ arousal, ...row }) => row) });
  assert.deepEqual(withoutArousal(candidate.scorer.used), withoutArousal(arousalOff.scorer.used));
  const components = candidate.scorer.result.ranked.map(({ components: { arousal, ...rest } }) => rest);
  assert.deepEqual(components[0], components[1]);
  assert.deepEqual(candidate.scorer.result.weights, arousalOff.scorer.result.weights);
  assert.ok(arousalOff.scorer.used.candidates.every(row => row.arousal === 0));
  assert.equal(candidate.step.tool, 'dream');
  assert.equal(arousalOff.step.tool, 'verify');
  assert.equal(replay.step.tool, candidate.step.tool);
  assert.deepEqual(replay.value, candidate.value);
  const entry = family => candidate.value.entries.find(row => row.key === `risk:${family}`);
  assert.equal(entry('dream').arousal, 0.4335);
  assert.equal(entry('verify').arousal, 0.3735);
  for (const family of ['dream', 'verify']) {
    assert.equal(entry(family).nIndependent, 3);
    assert.equal(entry(family).status, 'MEASURED');
  }
  for (const exported of result.training.exports) {
    const projection = exported.family === 'verify' ? { status: exported.raw.data.status } : { hypotheses: exported.raw };
    assert.deepEqual(exported.projection, projection);
    assert.equal(exported.artifactDigest, digest(projection));
    assert.equal(exported.oracleOk, true);
  }
  assert.equal(result.training.outcomes.filter(row => row === 'confirmed').length, 4);
  assert.equal(result.training.outcomes.filter(row => row === 'contradiction').length, 2);
  assert.equal(result.training.exports.filter(row => row.artifactDigest !== row.forecastDigest).length, 2);
  for (const row of result.training.chronology) {
    assert.ok(Date.parse(row.at) <= Date.parse(row.committedAt));
    assert.ok(Date.parse(row.committedAt) <= Date.parse(result.training.valueOptions.asOf));
  }
  for (const arm of Object.values(result.arms)) {
    assert.equal(arm.historyDigest, result.training.historyDigest);
    assert.equal(arm.historyUnchanged, true);
    assert.equal(arm.cost.modelCalls, 0);
    assert.equal(arm.cost.networkAttempts, 0);
    assert.equal(arm.cost.executorEntries, 1);
    assert.equal(arm.output.oracleOk, true);
    assert.equal(arm.scorer.before.candidates[0].predictionError.recentMean, null);
  }
});

for (const guardProbe of ['model', 'network']) test(`the ${guardProbe} guard refuses actual boundary entry`, () => {
  const child = spawnSync(process.execPath, [require.resolve('../lib/cognitive-lab-m7-value-runtime'), JSON.stringify({ guardProbe })],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.equal(result.blocked, true);
  assert.equal(result.cost[guardProbe === 'model' ? 'modelCalls' : 'networkAttempts'], 1);
});

for (const scenario of ['insufficient', 'dependent', 'observationOff']) test(`${scenario} cannot manufacture measured M9 influence`, () => {
  const result = runM7ValuePilot({ scenario });
  assert.equal(result.arms.candidate.step.tool, 'verify');
  assert.equal(result.arms.arousalOff.step.tool, 'verify');
  assert.ok(result.arms.candidate.value.entries.every(row => row.status === 'INSUFFICIENT'));
  assert.deepEqual(result.arms.candidate.scorer.used, result.arms.arousalOff.scorer.used);
  if (scenario === 'dependent') assert.ok(result.arms.candidate.value.entries.every(row => row.nIndependent === 1));
  if (scenario === 'observationOff') assert.equal(result.training.outcomes.length, 0);
});
