'use strict';

/**
 * CLI wiring for the R50 contradiction A/B runner (#3582).
 *
 * The evaluator and calibrator are unit-tested on their own; these tests prove
 * the runner is reached from the production entry: the real
 * `bin/huqan-cognitive-lab.js` resolves a frozen `{corpus, labels, contract}`
 * request to an A/B measurement, opens no store and leaves canonical memory
 * alone, and stays out of the default path unless the opt-in
 * `contradiction --contradiction-records` flag is given. The fail-closed cases
 * prove a missing or corrupt request file reports REJECT without touching
 * canonical memory.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { runCognitiveLab } = require('../lib/cognitive-lab-cli');

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');
const CORPUS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.corpus.json'), 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/contradiction-eval-v1.labels.json'), 'utf8'));

function request(overrides = {}) {
  return {
    corpus: CORPUS,
    labels: LABELS,
    contract: { minimumSamples: 10, smoothingAlpha: 0.5 },
    threshold: 0.5,
    ...overrides,
  };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-r50-wiring-'));
  const canonical = path.join(root, 'canonical-memory.json');
  fs.writeFileSync(canonical, '{"private":"untouched"}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, canonical };
}

function writeText(box, name, text) {
  const file = path.join(box.root, name);
  fs.writeFileSync(file, text);
  return file;
}

function invoke(args, box, input) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: box.root, input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', timeout: 30000,
    env: { ...process.env, HUQAN_MEMORY_PATH: box.canonical, HUQAN_STATE_ROOT: box.root },
  });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = null; }
  return { code: result.status, output, stderr: result.stderr };
}

function assertCanonicalUntouched(box) {
  assert.equal(fs.readFileSync(box.canonical, 'utf8'), '{"private":"untouched"}');
}

test('the contradiction sub-path resolves a request file to an A/B measurement', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'r50.json', JSON.stringify(request()));
  const result = invoke(['contradiction', '--contradiction-records', file], box);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'MEASURED');
  assert.equal(result.output.arms.A.probabilityKind, 'DECLARED_HEURISTIC');
  assert.equal(result.output.arms.B.probabilityKind, 'CALIBRATED');
  assert.equal(result.output.arms.A.calibration, null);
  assert.equal(result.output.assertsGain, false);
  assertCanonicalUntouched(box);
});

test('a request with a pinned source commit also reports the C fusion arm', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'r50-c.json', JSON.stringify(request({ sourceCommit: 'a'.repeat(40) })));
  const result = invoke(['contradiction', '--contradiction-records', file], box);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'MEASURED');
  assert.deepEqual(Object.keys(result.output.arms), ['A', 'B', 'C']);
  assert.equal(result.output.arms.C.probabilityKind, 'CALIBRATED');
  assert.equal(result.output.fusion.status, 'MEASURED');
  assert.equal(result.output.fusion.authority.canonical, false);
  assertCanonicalUntouched(box);
});

test('the contradiction-report sub-path resolves a request file to the A/B/C report', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'r50-report.json', JSON.stringify(request({ sourceCommit: 'a'.repeat(40) })));
  const result = invoke(['contradiction-report', '--contradiction-report-records', file], box);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.status, 'MEASURED');
  assert.deepEqual(Object.keys(result.output.arms), ['A', 'B', 'C']);
  assert.equal(result.output.comparison.primary.baseline, 'B');
  assert.equal(result.output.comparison.primary.candidate, 'C');
  assert.equal(result.output.productionBehaviorChanged, false);
  assert.equal(result.output.automaticPromotion, false);
  assert.equal(result.output.policy.productionWiring, false);
  assert.equal(result.output.weakness.length, 9);
  assertCanonicalUntouched(box);
});

test('contradiction usage errors throw before any store is opened', async () => {
  await assert.rejects(
    runCognitiveLab(['contradiction'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected contradiction --contradiction-records FILE/,
  );
  await assert.rejects(
    runCognitiveLab(['contradiction', '--contradiction-records'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected contradiction --contradiction-records FILE/,
  );
});

test('corrupt, non-object and unbounded request files fail closed', (t) => {
  const box = sandbox(t);
  const cases = [
    writeText(box, 'truncated.json', '{"corpus":'),
    writeText(box, 'null.json', 'null'),
    writeText(box, 'huge.json', `{"padding":"${'x'.repeat(1024 * 1024 + 1)}"}`),
  ];
  for (const entry of cases) {
    const refused = invoke(['contradiction', '--contradiction-records', entry], box);
    assert.equal(refused.code, 1, `entry ${entry} must be refused`);
    assert.equal(refused.output.status, 'REJECT');
    assertCanonicalUntouched(box);
  }
});

test('a request with an unknown contract field is refused without scoring', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'bad-contract.json', JSON.stringify(request({ contract: { minimumSamples: 10, smoothingAlpha: 0.5, extra: 1 } })));
  const refused = invoke(['contradiction', '--contradiction-records', file], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
});
