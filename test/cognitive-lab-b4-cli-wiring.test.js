'use strict';

/**
 * CLI wiring for the B4 transfer runner (#3562).
 *
 * The pure evaluator and the runner are unit-tested on their own; these tests
 * prove the runner is actually reached from the production entry: the real
 * `bin/huqan-cognitive-lab.js` resolves a frozen records file to a
 * `huqan-cognitive-lab-b4-experiment-v1` result with `mechanisms.B4 = 'ENABLED'`
 * and a candidate-only boundary, opens no store and leaves canonical memory
 * alone, and stays out of the default path unless the opt-in `b4 --b4-records`
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

// A minimal valid corpus: 24 holdout (one class iii counter-case), 8 transfer.
// A2 never writes a wrong change; A1 both helps (refuses safely where it used
// to write) and hurts (misses a change A2 would have made), so the anti-case
// criterion holds and the pair scores cleanly without the runtime harness.
function arm(correct, expected, wrong = false) {
  const changed = wrong || (correct && expected === 'change') ? ['t'] : [];
  return { correct, wrongWrite: wrong ? 1 : 0, changed, dispatches: 1, events: 1 };
}

function records() {
  const rows = [];
  for (let i = 0; i < 12; i += 1) {
    // 'change' tasks: A2 held 8, hurt 4 (it refused where A1 applied the edit).
    const hurt = i >= 8;
    rows.push({ taskId: `c${i}`, split: 'holdout', class: 'ii', expected: 'change',
      A0: arm(0, 'change'), A1: arm(1, 'change'), A2: arm(hurt ? 0 : 1, 'change'), O: arm(1, 'change') });
  }
  for (let i = 0; i < 12; i += 1) {
    // 'refuse' tasks: A2 correct 12; A1 wrote a wrong change on 4 of them.
    const wrong = i >= 8;
    rows.push({ taskId: `r${i}`, split: 'holdout', class: i === 0 ? 'iii' : 'ii', expected: 'refuse',
      A0: arm(1, 'refuse'), A1: arm(wrong ? 0 : 1, 'refuse', wrong), A2: arm(1, 'refuse'), O: arm(1, 'refuse') });
  }
  for (let i = 0; i < 8; i += 1) {
    rows.push({ taskId: `t${i}`, split: 'transfer', class: 'transfer', expected: 'refuse',
      A0: arm(1, 'refuse'), A1: arm(1, 'refuse'), A2: arm(1, 'refuse'), O: arm(1, 'refuse') });
  }
  return rows;
}

function request(overrides = {}) {
  return {
    records: records(),
    corpusDigest: DIGEST,
    sourceCommit: COMMIT,
    sourceDirty: false,
    trainIds: ['source-version', 'source-url'],
    ...overrides,
  };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-b4-wiring-'));
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

test('the b4 sub-path resolves a records file to a candidate-only B4 manifest', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'b4.json', JSON.stringify(request()));
  const result = invoke(['b4', '--b4-records', file], box);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.output.schemaVersion, 'huqan-cognitive-lab-b4-experiment-v1');
  assert.equal(result.output.authority, 'MODEL_AUTHORITY');
  assert.equal(result.output.canonical, false);
  assert.equal(result.output.automaticPromotion, false);
  assert.equal(result.output.intelligenceGain, 'NOT_MEASURED');
  assert.equal(result.output.mechanisms.B4, 'ENABLED');
  assert.equal(Object.values(result.output.mechanisms).filter((flag) => flag === 'ENABLED').length, 1);
  const validated = validateManifest(result.output.manifest);
  assert.equal(validated.status, 'VALID');
  assert.equal(validated.manifest.schemaVersion, MANIFEST_SCHEMA_VERSION);
  assert.deepEqual(validated.manifest.split.train, ['source-url', 'source-version']);
  assert.equal(result.output.manifestDigest, validated.digest);
  assertCanonicalUntouched(box);
});

test('b4 usage errors throw before any store is opened', async () => {
  await assert.rejects(
    runCognitiveLab(['b4'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected b4 --b4-records FILE/,
  );
  await assert.rejects(
    runCognitiveLab(['b4', '--b4-records'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected b4 --b4-records FILE/,
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
    const refused = invoke(['b4', '--b4-records', entry], box);
    assert.equal(refused.code, 1, `entry ${entry} must be refused`);
    assert.equal(refused.output.status, 'REJECT');
  }
  assertCanonicalUntouched(box);
});

test('a request with a malformed input is rejected by the runner', (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'bad.json', JSON.stringify(request({ sourceCommit: 'short' })));
  const refused = invoke(['b4', '--b4-records', file], box);
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
  const refused = invoke(['b4', '--b4-records', link], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
});
