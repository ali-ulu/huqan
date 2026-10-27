'use strict';

// #4065 G1 through the production HTTP entry: an independently observed Coder
// acceptance failure changes the next approved choice, and a fresh process
// rebuilds the same preference from the journal without writing to it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { execFileSync } = require('node:child_process');
const { FILTER_KIND, MAP_KIND, g1Arm, routeCognition } = require('./helpers/http-coder-fixture');

test('an observed acceptance failure moves the next choice to the same kind of work', async t => {
  const { f, steps, trail, selections } = await g1Arm(t, { failing: true });
  assert.ok(trail.some(row => row.reason === 'native_acceptance_observed' && row.outcome === 'contradiction'));
  assert.equal(steps[1].id, 'coder:same', 'the failed kind gets attention before the other kind');
  const kindValue = row => row.values.find(value => value.key === `risk:coder:${MAP_KIND}`);
  assert.ok(kindValue(selections[1]).arousal > kindValue(selections[0]).arousal, 'the surprise raised arousal');

  // Fresh process: same graph, same frame, same remaining queue -> same order, no writes.
  const files = ['graph.json', 'graph.mutations.json'].map(file => path.join(f.dir, file)).filter(file => fs.existsSync(file));
  const before = files.map(file => fs.readFileSync(file));
  const queued = [{ id: 'coder:alt', tool: 'coder', action: 'code_change', workKind: FILTER_KIND },
    { id: 'coder:same', tool: 'coder', action: 'code_change', workKind: MAP_KIND }];
  const { cognition, cognitiveScheduler, cognitionFrame } = routeCognition(f);
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
  const replayed = JSON.parse(execFileSync(process.execPath, ['-e',
    "const Graph=require('./graph');const {prepareCognition}=require('./lib/agent-cognition-seam');"
      + "const d=JSON.parse(process.argv[2]);const g=new Graph({useSQLite:false,memoryPath:process.argv[1]});"
      + "const state={workspaceId:'default',observabilityRunId:'restarted',iteration:1,goal:d.goal};"
      + "const result=prepareCognition({state,graph:g,queued:d.queued,opts:d.opts,goal:d.goal,objective:''});"
      + "console.log(JSON.stringify({result,order:d.queued.map(s=>s.id)}));",
    path.join(f.dir, 'graph.json'), JSON.stringify({ goal: cognitionFrame.goal, queued,
      opts: { cognition, cognitiveScheduler, cognitionFrame } })],
  { cwd: path.resolve(__dirname, '..'), env, encoding: 'utf8', windowsHide: true, timeout: 30000 }));
  assert.equal(replayed.result.status, 'MEASURED', JSON.stringify(replayed.result));
  assert.equal(replayed.order[0], 'coder:same');
  files.forEach((file, index) => assert.deepEqual(fs.readFileSync(file), before[index]));
});
