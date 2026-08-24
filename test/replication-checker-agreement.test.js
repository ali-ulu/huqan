'use strict';

/**
 * "Repeated enough to be reliable" has to mean the repeats agreed.
 *
 * The plugin counted array length and nothing else, so two runs that
 * contradicted each other, two identical runs, and two empty objects all
 * reported `replicable` / `stable` -- and contradiction *raised* confidence
 * from 0.44 to 0.66, then routed the result to discovery instead of a new
 * experiment. `sourceRefs` shared the same counter, so two source references
 * were read as two replications.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const plugin = require('../plugins/replication-checker');

async function check(input) {
  const result = await plugin.run(null, input, {});
  return { result, output: result.data.output };
}

test('two runs that contradict each other are not replicable', async () => {
  const { result, output } = await check({
    runs: [
      { outcome: 'support', note: 'hipotez dogrulandi' },
      { outcome: 'reject', note: 'hipotez reddedildi' },
    ],
  });

  assert.equal(output.replicationStatus, 'contradicted');
  assert.equal(output.consistency, 'conflicting');
  assert.equal(output.nextAction, 'experimentPlanner', 'a contradiction calls for another experiment');
  assert.ok(result.confidence < 0.44, `contradiction must not beat a single run: ${result.confidence}`);
});

test('two runs that agree are replicable', async () => {
  const { result, output } = await check({ runs: [{ outcome: 'support' }, { outcome: 'support' }] });

  assert.equal(output.replicationStatus, 'replicable');
  assert.equal(output.consistency, 'stable');
  assert.equal(output.nextAction, 'discoveryEngine');
  assert.ok(result.confidence > 0.44);
});

test('runs with no readable outcome carry no evidence of repetition', async () => {
  const { output } = await check({ runs: [{}, {}] });

  assert.equal(output.replicationStatus, 'uncertain');
  assert.equal(output.consistency, 'insufficient');
  assert.equal(output.repeatCount, 2, 'the runs still happened');
  assert.equal(output.agreedCount, 0, 'but nothing about them could be compared');
});

test('a single run stays uncertain', async () => {
  const { output } = await check({ runs: [{ outcome: 'support' }] });

  assert.equal(output.replicationStatus, 'uncertain');
  assert.equal(output.consistency, 'insufficient');
});

test('source references are counted separately and do not decide the verdict', async () => {
  const { output } = await check({ sourceRefs: ['doc://a', 'doc://b'] });

  assert.equal(output.sourceCount, 2);
  assert.equal(output.replicationStatus, 'uncertain', 'two sources are not two replications');
});

test('observations are read the same way as runs', async () => {
  const agreeing = await check({ observations: [{ signal: 'up' }, { signal: 'up' }] });
  const disagreeing = await check({ observations: [{ signal: 'up' }, { signal: 'down' }] });

  assert.equal(agreeing.output.replicationStatus, 'replicable');
  assert.equal(disagreeing.output.replicationStatus, 'contradicted');
});

test('the evidence text says what was measured', async () => {
  const { result } = await check({ runs: [{ outcome: 'support' }, { outcome: 'reject' }] });

  const [evidence] = result.evidence;
  assert.match(evidence.text, /distinctOutcomes=2/);
  assert.match(evidence.text, /status=contradicted/);
  assert.doesNotMatch(evidence.text, /status=replicable/);
});

test('empty input is still refused', async () => {
  const result = await plugin.run(null, {}, {});

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_INPUT');
});
