'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runSeries, parseArgs } = require('./bench-admitted-series');

test('admitted series rejects unbounded or misspelled workload arguments', () => {
  assert.deepEqual(parseArgs(['--nodes=10000', '--writes=1000']), { nodes: 10000, writes: 1000 });
  for (const args of [['--nodes=-1'], ['--nodes=100001'], ['--writes=0'],
    ['--writes=1001'], ['--writes=1.5'], ['--write=100'], ['--nodes=1', '--nodes=2']]) {
    assert.throws(() => parseArgs(args), /ARGUMENT/);
  }
});

test('real admitted series includes default maintenance and proves all writes after reopen', async () => {
  const result = await runSeries({ nodes: 12, writes: 7 });
  assert.equal(result.backend, 'sqlite');
  assert.equal(result.workspaceId, 'default');
  assert.equal(result.seedNodes, 12);
  assert.equal(result.seedEdges, 0);
  assert.equal(result.writes, 7);
  assert.equal(result.reopenedEdges, 7);
  assert.equal(result.maintenance.every, 5);
  assert.equal(result.maintenance.calls, 1);
  assert.equal(result.maintenance.errors, 0);
  assert.equal(result.exportMirror.errors, 0);
  assert.ok(result.exportMirror.calls >= 1);
  assert.equal(result.receipts.computed, 7);
  assert.equal(result.receipts.upper_bound, 0);
  assert.equal(result.cold.count, 1);
  assert.equal(result.warm.count, 6);
  assert.ok(result.seriesMs >= result.cold.ms);
  assert.ok(result.writesPerSecond > 0);
});

test('invalid direct API workload is rejected before opening storage', async () => {
  await assert.rejects(runSeries({ nodes: 0, writes: 1 }), /ARGUMENT/);
});
