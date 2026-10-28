'use strict';

// #4065 G1 runner: corpus, split audit, decision arithmetic, arm preload and
// one real two-arm episode through the production Coder HTTP route handler.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const corpusApi = require('../lib/cognitive-lab-g1-corpus');
const stats = require('../lib/cognitive-lab-g1-stats');
const { runPair, prepareSource, runHoldout, armViolations, checkLockedManifest, fingerprint, MANIFEST_SCHEMA } = require('../lib/cognitive-lab-g1-holdout');
const { execFileSync } = require('node:child_process');

const small = () => corpusApi.buildG1Corpus({ sizes: { train: 3, calibration: 2, holdout: 2 } });

test('the corpus is deterministic, clean, and every group spans two families', () => {
  const first = small();
  const second = small();
  assert.equal(corpusApi.corpusDigest(first), corpusApi.corpusDigest(second));
  assert.equal(corpusApi.auditSplits(first).status, 'CLEAN');
  for (const group of Object.values(first.splits).flat()) {
    assert.notEqual(group.units[0].family, group.units[1].family);
    for (const unit of group.units) for (const variant of unit.variants) {
      assert.equal(variant.examples.length, 3);
      assert.ok(variant.examples.some(row => row.input.length === 0));
      const trained = new Set(variant.examples.map(row => JSON.stringify(row.input)));
      assert.ok(variant.acceptanceExamples.every(row => !trained.has(JSON.stringify(row.input))));
    }
  }
  const families = new Set(first.splits.train.flatMap(group => group.units.map(unit => unit.family)));
  assert.equal(families.size, corpusApi.FAMILIES.length, 'train history covers every kind');
});

test('the split audit reports a found leak as LEAK and a broken audit as UNAVAILABLE', () => {
  const corpus = small();
  const leaked = { ...corpus, splits: { ...corpus.splits, holdout: [corpus.splits.train[0], ...corpus.splits.holdout] } };
  assert.equal(corpusApi.auditSplits(leaked).status, 'LEAK');
  const tampered = structuredClone(corpus);
  tampered.splits.holdout[0].units[0].variants[0].acceptanceExamples[0].expected = 999;
  assert.deepEqual(corpusApi.auditSplits(tampered).status, 'UNAVAILABLE');
  assert.equal(corpusApi.auditSplits({ splits: null }).status, 'UNAVAILABLE');
});

test('the episode order is the preregistered seeded Fisher-Yates over two variants per kind', () => {
  const group = small().splits.calibration[0];
  const order = seed => corpusApi.episodeTasks(group, seed).map(task => task.id);
  assert.deepEqual(order(1), order(1));
  assert.equal(order(1).length, 4);
  for (const unit of group.units) assert.equal(corpusApi.episodeTasks(group, 1).filter(task => task.workKind === unit.workKind).length, 2);
  assert.ok([2, 3, 4, 5, 6].some(seed => order(seed).join() !== order(1).join()), 'the seed changes the order');
});

test('sigma uses n - 1 and N is clamped to 32-64', () => {
  assert.equal(stats.sampleSd([0, 0.5]).toFixed(6), Math.sqrt(0.125).toFixed(6));
  assert.equal(stats.lockGroupCount(0), 32);
  assert.equal(stats.lockGroupCount(0.3), 32);
  assert.equal(stats.lockGroupCount(0.32), Math.ceil((2.8 * 0.32 / 0.15) ** 2));
  assert.equal(stats.lockGroupCount(1), 64);
  assert.throws(() => stats.sampleSd([1]), /G1_SD_NEEDS_TWO_FINITE/);
});

test('the bootstrap is reproducible and the sign test is exact', () => {
  const deltas = [0.25, -0.25, 0.5, 0, 0.25, 0.25, -0.25, 0.5];
  assert.deepEqual(stats.pairedBootstrap(deltas), stats.pairedBootstrap(deltas));
  const interval = stats.pairedBootstrap(deltas);
  assert.ok(interval.lower <= interval.mean && interval.mean <= interval.upper);
  assert.equal(stats.signTest([1, 1, 1, 1, 1]).p, 0.0625);
  assert.equal(stats.signTest([0, 0]).p, 1);
});

test('every result gets exactly one label in the preregistered priority', () => {
  const cost = { modelCalls: 0, networkCalls: 0, wallRatio: 1 };
  const stratum = { groups: 8, minGroups: 8, interval: { lower: 0 } };
  const label = input => stats.labelResult({ interval: { lower: 0.1, upper: 0.3 }, stratum, cost, ...input }).label;
  assert.equal(label({ rejectReasons: ['x'], insufficientReasons: ['y'] }), 'REJECT');
  assert.equal(label({ insufficientReasons: ['y'], interval: { lower: -0.4, upper: -0.1 } }), 'INSUFFICIENT');
  assert.equal(label({ interval: { lower: -0.4, upper: -0.1 } }), 'ZARAR');
  assert.equal(label({}), 'GAIN');
  assert.equal(label({ interval: { lower: -0.1, upper: 0.2 } }), 'MEASURED_NO_GAIN');
  assert.equal(label({ cost: { ...cost, wallRatio: 2 } }), 'MEASURED_GATE_FAIL');
  const empty = stats.labelResult({ interval: { lower: 0.1, upper: 0.3 }, stratum: { groups: 3, minGroups: 8, interval: null }, cost });
  assert.deepEqual(empty, { label: 'MEASURED_GATE_FAIL', reasons: ['non_inferiority_not_evaluable'] });
});

function preloadProbe(arm) {
  const sink = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'g1-preload-')), 'inputs.jsonl');
  const script = "const Module=require('node:module'),path=require('node:path');"
    + "const file=path.resolve('lib/agent-cognition-seam.js');const seam=new Module(file);seam.filename=file;"
    + "seam.paths=Module._nodeModulePaths(path.dirname(file));"
    + "const progression=Module._load('./agent-step-progression',seam,false);"
    + "const queued=[{id:'a',urgency:0.7},{id:'b',urgency:0.2}];"
    + "try{progression.scheduleQueuedSteps({state:{runId:'r1'},queued,opts:{}});}catch(_){}"
    + "process.stdout.write(JSON.stringify(queued.map(s=>s.urgency)));";
  const child = spawnSync(process.execPath, ['--require', './lib/cognitive-lab-g1-arm-preload.js', '-e', script], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, NODE_TEST_CONTEXT: '', HUQAN_G1_ARM: arm, HUQAN_G1_INPUTS: sink } });
  assert.equal(child.status, 0, child.stderr);
  const rows = fs.readFileSync(sink, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { urgencies: JSON.parse(child.stdout), rows };
}

test('the arm preload zeroes urgency only in control and records both arms', () => {
  const control = preloadProbe('control');
  const candidate = preloadProbe('candidate');
  assert.deepEqual(control.urgencies, [0, 0]);
  assert.deepEqual(candidate.urgencies, [0.7, 0.2]);
  assert.deepEqual(control.rows[0].exceptUrgency, candidate.rows[0].exceptUrgency);
  assert.equal(control.rows[0].used.state.runId, '<isolated-id-or-clock>');
  assert.deepEqual(control.rows.at(-1).cost, { modelCalls: 0, networkCalls: 0 });
  const refused = spawnSync(process.execPath, ['--require', './lib/cognitive-lab-g1-arm-preload.js', '-e', '0'], {
    cwd: path.resolve(__dirname, '..'), encoding: 'utf8', windowsHide: true, env: { ...process.env, HUQAN_G1_ARM: '' } });
  assert.notEqual(refused.status, 0, 'an unconfigured preload refuses to run');
});

test('one episode runs both arms through the production Coder route with matching inputs', { timeout: 240000 }, t => {
  const baseDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'g1-pair-')));
  t.after(() => fs.rmSync(baseDir, { recursive: true, force: true }));
  const source = prepareSource(baseDir);
  const stateDir = path.join(baseDir, 'empty-history'); fs.mkdirSync(stateDir);
  const pair = runPair({ tasks: corpusApi.episodeTasks(small().splits.calibration[0], 1), history: { stateDir },
    baseDir, source, label: 'test' });
  assert.deepEqual(pair.reject, []);
  assert.deepEqual(pair.insufficient, []);
  for (const arm of ['control', 'candidate']) {
    assert.equal(pair[arm].denominator, 4);
    assert.equal(pair[arm].executed.length, 2, 'two of four approved tasks execute');
    assert.deepEqual(pair[arm].cost, { modelCalls: 0, networkCalls: 0 });
  }
  assert.ok(pair.control.urgencyUsed.every(value => value === 0));
  assert.equal(pair.candidate.urgencyUsed.length, 4, 'the scheduler chooses among the whole approved queue');
});

test('an arm with a missing cost record, a touched source or a false completion is rejected', () => {
  const clean = { denominator: 4, steps: [{ steps: [{ id: 'coder:a', status: 'done' }] }], outcome: { a: { accepted: true } },
    cost: { modelCalls: 0, networkCalls: 0 }, sourceIntact: true };
  assert.deepEqual(armViolations(clean), []);
  assert.deepEqual(armViolations({ ...clean, cost: null }), ['cost_missing']);
  assert.deepEqual(armViolations({ ...clean, cost: { modelCalls: 1, networkCalls: 0 } }), ['model_or_network_call']);
  assert.deepEqual(armViolations({ ...clean, sourceIntact: false }), ['source_mutated']);
  assert.deepEqual(armViolations({ ...clean, outcome: { a: { accepted: false } } }), ['false_completion:a']);
  assert.deepEqual(armViolations({ ...clean, denominator: 3 }), ['denominator_changed']);
});

test('the holdout refuses a stale or unlocked manifest before consuming its single run', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g1-holdout-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const reportFile = path.join(dir, 'report.json');
  const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..'), encoding: 'utf8' }).trim();
  const corpus = corpusApi.buildG1Corpus();
  const locked = { schemaVersion: MANIFEST_SCHEMA, phase: 'calibration', sourceSha: head, ...fingerprint(corpus),
    lock: { holdoutGroups: 32, sigma: 0.2, stratum: [] } };
  assert.throws(() => runHoldout({ manifest: { ...locked, lock: null }, baseDir: dir, reportFile }), /NEEDS_LOCKED_MANIFEST/);
  // A checkout with untracked or modified runner-external files (CI writes
  // artifacts/) is itself refused first; that refusal must not consume the run.
  let productionClean = true;
  try { checkLockedManifest(locked, corpus); } catch (error) {
    assert.match(error.message, /G1_MANIFEST_MISMATCH:production/);
    productionClean = false;
  }
  assert.throws(() => runHoldout({ manifest: { ...locked, digests: { ...locked.digests, episode: '0'.repeat(64) } }, baseDir: dir, reportFile }),
    new RegExp(`G1_MANIFEST_MISMATCH:${productionClean ? 'digests' : 'production'}`));
  assert.throws(() => runHoldout({ manifest: { ...locked, protocol: { ...locked.protocol, seeds: [1] } }, baseDir: dir, reportFile }),
    new RegExp(`G1_MANIFEST_MISMATCH:${productionClean ? 'protocol' : 'production'}`));
  assert.throws(() => fs.readFileSync(reportFile), { code: 'ENOENT' }, 'a refused run writes no marker');
  if (!productionClean) return t.diagnostic('runner-external tree differs from HEAD here; the single-run check needs a clean checkout');
  fs.writeFileSync(reportFile, '{}', { flag: 'wx' });
  assert.throws(() => runHoldout({ manifest: locked, baseDir: dir, reportFile }), /G1_HOLDOUT_ALREADY_RUN/);
});
