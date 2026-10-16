'use strict';

// H-03 (#1978) sözleşme testi: plan() çıktısı run() ile aynı işi vaat etmeli.
// Loop açıkken plan "loop niyeti" diye etiketlenir (adımlar fallback olarak
// korunur); loop kapalıyken run plan adımlarını aynen çalıştırır.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');

const BYPASS = Kernel.createAdmissionBypassOpts('h03-contract');

function freshAgent(dbPath, dreamExperimentLoop) {
  const kernel = new KernelV2({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(path.dirname(dbPath), 'memory.json'),
  });
  kernel.learn('kedi hayvandir', BYPASS);
  return new AgentV3({
    kernel,
    dbPath,
    maxSteps: 4,
    maxIterations: 4,
    timeBudgetMs: 5000,
    dreamExperimentLoop,
  });
}

test('H-03: loop kapalıyken plan adımları run ile aynı işi vaat eder', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h03-loop-off-'));
  const agent = freshAgent(path.join(tmpDir, 'memory.db'), false);

  const plan = agent.plan('kedi hayvandir mi?');
  assert.equal(plan.ok, true);
  assert.equal(plan.data.dreamExperimentLoop.enabled, false);
  assert.equal(plan.data.executionMode, 'plan-steps');
  assert.equal(plan.data.stepsSupersededByLoop, false);

  const run = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1, timeBudgetMs: 5000 });
  assert.equal(run.ok, true);
  assert.equal(run.data.planSupersededByLoop, false);
  assert.equal(run.data.steps[0].action, plan.data.steps[0].action);
});

test('H-03: loop açıkken plan loop niyetini etiketler, run bounded dream cycle çalıştırır', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h03-loop-on-'));
  const agent = freshAgent(path.join(tmpDir, 'memory.db'), true);

  const plan = agent.plan('kedi hayvandir mi?');
  assert.equal(plan.ok, true);
  assert.equal(plan.data.dreamExperimentLoop.enabled, true);
  assert.equal(plan.data.executionMode, 'dream-experiment-loop');
  assert.equal(plan.data.stepsSupersededByLoop, true);
  assert.match(plan.data.executionNote, /bounded dream cycle/);
  // Adımlar fallback olarak korunur, ezilmez.
  assert.deepEqual(plan.data.steps.map((s) => s.action), ['ask', 'verify', 'dream']);

  const run = agent.run('kedi hayvandir mi?', { resume: false, maxIterations: 1, timeBudgetMs: 5000 });
  assert.equal(run.ok, true);
  assert.equal(run.data.planSupersededByLoop, true);
  assert.equal(run.data.steps[0].action, 'dream');
  assert.ok(run.data.dreamExperimentLoop);
});
