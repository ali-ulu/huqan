'use strict';

/**
 * CLI wiring for the contradiction rule-baseline runner (#3582, R50 PR2).
 *
 * The evaluator and calibrator are unit-tested on their own; these tests prove
 * the runner is reached from the production entry: the real
 * `bin/huqan-cognitive-lab.js` resolves a frozen `{corpus,labels}` file to a
 * `huqan-contradiction-rule-baseline-v1` report with the A/B arms, the
 * exclusion counts and a candidate-only boundary, opens no store and leaves
 * canonical memory alone. The opt-in flag keeps it out of the default path, and
 * a missing or corrupt request file reports REJECT without touching memory.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { runCognitiveLab } = require('../lib/cognitive-lab-cli');
const corpus = require('./fixtures/contradiction-eval-v1.corpus.json');
const labels = require('./fixtures/contradiction-eval-v1.labels.json').labels;

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');

function request() {
  return { corpus, labels };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-contradiction-wiring-'));
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

function invoke(args, box) {
  const result = spawnSync(process.execPath, [BIN, ...args], {
    cwd: box.root, input: '', encoding: 'utf8', timeout: 30000,
  });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = null; }
  return { code: result.status, output, stderr: result.stderr };
}

function assertCanonicalUntouched(box) {
  assert.equal(fs.readFileSync(box.canonical, 'utf8'), '{"private":"untouched"}');
}

test('the contradiction sub-path resolves a corpus file to a candidate-only A/B report', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'contradiction.json', JSON.stringify(request()));
  const result = invoke(['contradiction', '--contradiction-records', file], box);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.schemaVersion, 'huqan-contradiction-rule-baseline-v1');
  assert.equal(result.output.status, 'MEASURED');
  assert.equal(result.output.arms.A.probabilityKind, 'DECLARED_HEURISTIC');
  assert.equal(result.output.arms.B.probabilityKind, 'CALIBRATED');
  assert.equal(result.output.arms.A.probability.brier, null);
  assert.equal(typeof result.output.arms.B.probability.brier, 'number');
  assert.equal(result.output.exclusions.UNCERTAIN, 10);
  assert.equal(result.output.exclusions.INVALID_PAIR, 6);
  assert.equal(result.output.assertsGain, false);
  assert.deepEqual(result.output.authority, {
    kind: 'DETERMINISTIC', locality: 'LOCAL', authority: 'CANDIDATE_ONLY',
    canonical: false, modelCalls: 0, tokens: 0, externalCalls: 0,
  });
  assert.match(result.output.calibration.mappingDigest, /^[a-f0-9]{64}$/);
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
  }
  assertCanonicalUntouched(box);
});

test('a request with a malformed corpus is rejected by the runner', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'bad.json', JSON.stringify({ corpus: { records: 'x' }, labels }));
  const refused = invoke(['contradiction', '--contradiction-records', file], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
});

test('the contradiction flag is opt-in: an unknown command throws', async () => {
  await assert.rejects(
    runCognitiveLab(['contradictions', '--contradiction-records', 'x'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /unknown command/,
  );
});

test('a symlinked request file is refused rather than followed', (t) => {
  if (process.platform === 'win32') {
    t.skip('O_NOFOLLOW is not honoured on Windows');
    return;
  }
  const box = sandbox(t);
  const target = writeText(box, 'real.json', JSON.stringify(request()));
  const link = path.join(box.root, 'link.json');
  fs.symlinkSync(target, link, 'file');
  const refused = invoke(['contradiction', '--contradiction-records', link], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
});
