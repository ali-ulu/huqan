'use strict';

/**
 * CLI wiring for the B6 ablation runner (#3562).
 *
 * The pure evaluator and the runner are unit-tested on their own; these tests
 * prove the runner is actually reached from the production entry: the real
 * `bin/huqan-cognitive-lab.js` resolves a frozen records file to a
 * `huqan-cognitive-lab-b6-experiment-v1` result with `mechanisms.B6 = 'ENABLED'`
 * and a candidate-only boundary, opens no store and leaves canonical memory
 * alone, and stays out of the default path unless the opt-in `b6 --b6-records`
 * flag is given. The fail-closed cases prove a missing or corrupt request file
 * reports REJECT without touching canonical memory.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');

const { runCognitiveLab } = require('../lib/cognitive-lab-cli');
const { MANIFEST_SCHEMA_VERSION, validateManifest } = require('../lib/cognitive-lab-manifest');

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');
const DIGEST = 'c'.repeat(64);
const COMMIT = 'd'.repeat(40);

function record(taskId, split, baseSolved, candSolved) {
  return {
    taskId,
    split,
    solutionStepId: 's',
    baseline: { stepIds: baseSolved ? ['s'] : [], steps: baseSolved ? 1 : 0 },
    candidate: { stepIds: candSolved ? ['s'] : [], steps: candSolved ? 1 : 0 },
    solvedBaseline: baseSolved ? 1 : 0,
    solvedCandidate: candSolved ? 1 : 0,
  };
}

// A minimal valid corpus: 16 records, 8 holdout, one helped and one hurt task,
// so the anti-case criterion is satisfied and both arms spend equal steps.
function records() {
  return [
    record('h0', 'holdout', 0, 1),
    record('h1', 'holdout', 1, 0),
    ...Array.from({ length: 6 }, (_, i) => record(`h${i + 2}`, 'holdout', 1, 1)),
    ...Array.from({ length: 4 }, (_, i) => record(`t${i}`, 'train', 0, 0)),
    ...Array.from({ length: 4 }, (_, i) => record(`x${i}`, 'transfer', 1, 1)),
  ];
}

function request(overrides = {}) {
  return {
    records: records(),
    corpusDigest: DIGEST,
    sourceCommit: COMMIT,
    sourceDirty: false,
    ...overrides,
  };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-b6-wiring-'));
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
  });
  let output;
  try { output = JSON.parse(result.stdout); } catch { output = null; }
  return { code: result.status, output, stderr: result.stderr };
}

function assertCanonicalUntouched(box) {
  assert.equal(fs.readFileSync(box.canonical, 'utf8'), '{"private":"untouched"}');
}

test('the b6 sub-path resolves a records file to a candidate-only B6 manifest', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'b6.json', JSON.stringify(request()));
  const result = invoke(['b6', '--b6-records', file], box);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.schemaVersion, 'huqan-cognitive-lab-b6-experiment-v1');
  assert.equal(result.output.authority, 'MODEL_AUTHORITY');
  assert.equal(result.output.canonical, false);
  assert.equal(result.output.automaticPromotion, false);
  assert.equal(result.output.intelligenceGain, 'NOT_MEASURED');
  assert.equal(result.output.mechanisms.B6, 'ENABLED');
  assert.equal(Object.values(result.output.mechanisms).filter((flag) => flag === 'ENABLED').length, 1);
  const validated = validateManifest(result.output.manifest);
  assert.equal(validated.status, 'VALID');
  assert.equal(validated.manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.equal(result.output.manifestDigest, validated.digest);
  assertCanonicalUntouched(box);
});

test('b6 usage errors throw before any store is opened', async () => {
  await assert.rejects(
    runCognitiveLab(['b6'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected b6 --b6-records FILE/,
  );
  await assert.rejects(
    runCognitiveLab(['b6', '--b6-records'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected b6 --b6-records FILE/,
  );
});

test('corrupt, non-object and unbounded request files fail closed', (t) => {
  const box = sandbox(t);
  const cases = [
    writeText(box, 'truncated.json', '{"records":'),
    writeText(box, 'null.json', 'null'),
    writeText(box, 'huge.json', `{"padding":"${'x'.repeat(1024 * 1024 + 1)}"}`),
  ];
  for (const entry of cases) {
    const refused = invoke(['b6', '--b6-records', entry], box);
    assert.equal(refused.code, 1, `entry ${entry} must be refused`);
    assert.equal(refused.output.status, 'REJECT');
  }
  assertCanonicalUntouched(box);
});

test('a request with a malformed input is rejected by the runner', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'bad.json', JSON.stringify(request({ sourceCommit: 'short' })));
  const refused = invoke(['b6', '--b6-records', file], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
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
  const refused = invoke(['b6', '--b6-records', link], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
});
