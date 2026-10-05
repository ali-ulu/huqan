'use strict';

/**
 * CLI wiring for the B1 baseline replay runner (#3501).
 *
 * The pure runner (`lib/cognitive-lab-b1-replay.js`) is unit-tested on its
 * own; these tests prove it is actually reached from the production entry:
 * the real `bin/huqan-cognitive-lab.js` resolves a frozen manifest file to a
 * `huqan-cognitive-lab-b1-replay-v1` result on an isolated temp store, leaves
 * canonical memory alone, and stays out of the default path unless the
 * opt-in `--replay-manifest` flag is given. The fail-closed cases prove a
 * missing, corrupt or invalid manifest reports REJECT without opening any
 * store the product owns.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const Graph = require('../graph');
const { runCognitiveLab } = require('../lib/cognitive-lab-cli');
const { MANIFEST_SCHEMA_VERSION, computeManifestDigest } = require('../lib/cognitive-lab-manifest');
const {
  REPLAY_SCHEMA_VERSION,
  REPLAY_STATUS,
  REPLAY_ERROR_CODES,
  replayBaseline,
} = require('../lib/cognitive-lab-b1-replay');
const { comparisonInput } = require('./helpers/cognitive-lab-comparison');

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');
const DIGEST = 'a'.repeat(64);
const COMMIT = 'b'.repeat(40);

function manifest(overrides = {}) {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    source: { repository: 'ali-ulu/huqan', commit: COMMIT, dirty: false },
    fixture: { digest: DIGEST },
    split: {
      identity: DIGEST,
      train: ['t1', 't2', 't3'],
      holdout: ['h1', 'h2', 'h3', 'h4', 'h5'],
      transfer: [],
    },
    frame: { repository: 'ali-ulu/huqan', branch: 'main', environment: 'offline', task: 'B1-baseline' },
    seed: 7,
    mechanisms: {
      B1: 'ENABLED',
      B2: 'NOT_MEASURED',
      B3: 'NOT_MEASURED',
      B4: 'NOT_MEASURED',
      B5: 'NOT_MEASURED',
      B6: 'NOT_MEASURED',
      B7: 'NOT_MEASURED',
      B8: 'NOT_MEASURED',
    },
    budget: { modelCalls: 8, toolCalls: 0, humanCalls: 0, tokens: null, wallTimeMs: null, compute: null },
    measurementVersion: 'cognitive-lab-v0.1',
    thresholdConfigHash: DIGEST,
    ...overrides,
  };
}

function experiment(overrides = {}) {
  return {
    benchmark: 'B1',
    split: { train: ['t1', 't2', 't3'], holdout: ['h1', 'h2', 'h3', 'h4', 'h5'], transfer: [] },
    budget: { modelCalls: 8 },
    mechanisms: {
      B1: 'ENABLED',
      B2: 'NOT_MEASURED',
      B3: 'NOT_MEASURED',
      B4: 'NOT_MEASURED',
      B5: 'NOT_MEASURED',
      B6: 'NOT_MEASURED',
      B7: 'NOT_MEASURED',
      B8: 'NOT_MEASURED',
    },
    // h4 is missing an outcome; h5 is censored; h1..h3 are observed.
    outcomes: { h1: 'confirmed', h2: 'confirmed', h3: 'incident', h5: 'censored' },
    observations: {
      h1: 'observed', h2: 'observed', h3: 'observed', h5: 'observed',
    },
    recordedAt: '2026-09-01T00:00:00.000Z',
    outcomeAt: '2026-09-10T00:00:00.000Z',
    ...overrides,
  };
}

function replayRequest(overrides = {}) {
  const frozen = manifest();
  return {
    manifest: frozen,
    manifestDigest: computeManifestDigest(frozen),
    experiment: experiment(),
    ...overrides,
  };
}

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-b1-wiring-'));
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
  assert.ifError(result.error);
  assert.ok(result.stdout.trim(), result.stderr);
  return { code: result.status, output: JSON.parse(result.stdout.trim()), stderr: result.stderr };
}

function libraryResult(request) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cl-b1-direct-'));
  try {
    const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
    return replayBaseline(graph, {
      manifest: request.manifest, manifestDigest: request.manifestDigest, experiment: request.experiment,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertCanonicalUntouched(box) {
  assert.equal(fs.readFileSync(box.canonical, 'utf8'), '{"private":"untouched"}');
}

test('replay sub-path resolves a frozen manifest through the real CLI entry', { timeout: 60000 }, (t) => {
  const box = sandbox(t);
  const request = replayRequest();
  const file = writeText(box, 'replay.json', JSON.stringify(request));

  const first = invoke(['replay', '--replay-manifest', file], box);
  const second = invoke(['replay', '--replay-manifest', file], box);
  assert.equal(first.code, 0, first.stderr);
  assert.equal(second.code, 0, second.stderr);

  for (const output of [first.output, second.output]) {
    assert.equal(output.schemaVersion, REPLAY_SCHEMA_VERSION);
    assert.equal(output.status, REPLAY_STATUS.REPLAYED);
    assert.equal(output.benchmark, 'B1');
    assert.equal(output.error, null);
    assert.equal(output.counts.eligible, 5);
    assert.equal(output.counts.observed, 3);
    assert.equal(output.counts.censored, 1);
    assert.equal(output.integrity.status, 'PASS');
    assert.equal(output.mechanisms.B1, 'MEASURED');
    for (const id of ['B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']) {
      assert.equal(output.mechanisms[id], 'NOT_MEASURED', `${id} must not be measured by this slice`);
    }
    assert.ok(!('state' in output), 'replay must not mint a comparison state directory');
  }
  assert.equal(first.output.correctnessDigest, second.output.correctnessDigest);
  assert.equal(first.output.correctnessDigest, libraryResult(request).correctnessDigest);

  // Temp isolation: the sandbox holds only the canary and the request file;
  // no store was opened beside the removed scratch directory.
  assert.deepEqual(fs.readdirSync(box.root).sort(), ['canonical-memory.json', 'replay.json']);
  assertCanonicalUntouched(box);
});

test('the default path never replays without the opt-in flag', { timeout: 60000 }, (t) => {
  const box = sandbox(t);
  const initialized = invoke(['init', '--root', box.root], box, comparisonInput());
  // `init` takes its manifest on stdin, so pass it the comparison contract
  // input the same way the CLI tests do -- the point is only that whatever
  // comes back is not a replay result.
  assert.equal(initialized.code, 0, initialized.stderr);
  assert.ok('state' in initialized.output, 'init must keep minting comparison state');
  assert.ok(!('correctnessDigest' in initialized.output), 'replay digest must not appear without the replay flag');
  assert.ok(!('mechanisms' in initialized.output), 'replay mechanisms must not appear without the replay flag');
  assert.notEqual(initialized.output.schemaVersion, REPLAY_SCHEMA_VERSION);
  assertCanonicalUntouched(box);
});

test('a missing manifest file fails closed without touching any store', (t) => {
  const box = sandbox(t);
  const missing = invoke(['replay', '--replay-manifest', path.join(box.root, 'absent.json')], box);
  assert.equal(missing.code, 1);
  assert.equal(missing.output.status, 'REJECT');
  assert.deepEqual(fs.readdirSync(box.root), ['canonical-memory.json']);
  assertCanonicalUntouched(box);
});

test('corrupt, non-object and unbounded request files fail closed', (t) => {
  const box = sandbox(t);
  const cases = [
    writeText(box, 'truncated.json', '{"manifest":'),
    writeText(box, 'null.json', 'null'),
    writeText(box, 'huge.json', `{"padding":"${'x'.repeat(1024 * 1024 + 1)}"}`),
    box.root,
  ];
  for (const entry of cases) {
    const refused = invoke(['replay', '--replay-manifest', entry], box);
    assert.equal(refused.code, 1, `entry ${entry} must be refused`);
    assert.equal(refused.output.status, 'REJECT');
  }
  assertCanonicalUntouched(box);
});

test('a symlinked request file is refused rather than followed', (t) => {
  const box = sandbox(t);
  const target = writeText(box, 'real.json', JSON.stringify(replayRequest()));
  const link = path.join(box.root, 'link.json');
  try {
    fs.symlinkSync(target, link, 'file');
  } catch (error) {
    t.skip(`symlink unsupported on this platform: ${error.code}`);
    return;
  }
  const refused = invoke(['replay', '--replay-manifest', link], box);
  assert.equal(refused.code, 1);
  assert.equal(refused.output.status, 'REJECT');
  assertCanonicalUntouched(box);
});

test('a tampered or schema-invalid manifest is rejected with no canonical writes', (t) => {
  const box = sandbox(t);
  const tampered = replayRequest({ manifestDigest: DIGEST });
  const tamperedFile = writeText(box, 'tampered.json', JSON.stringify(tampered));
  const tamperedResult = invoke(['replay', '--replay-manifest', tamperedFile], box);
  assert.equal(tamperedResult.code, 1);
  assert.equal(tamperedResult.output.status, REPLAY_STATUS.REJECT);
  assert.equal(tamperedResult.output.error.code, REPLAY_ERROR_CODES.DIGEST_MISMATCH);
  assert.equal(tamperedResult.output.correctnessDigest, null);

  const invalidManifest = manifest();
  invalidManifest.budget.tokens = 'unknown';
  const invalid = {
    manifest: invalidManifest,
    manifestDigest: computeManifestDigest(invalidManifest),
    experiment: experiment(),
  };
  const invalidFile = writeText(box, 'invalid.json', JSON.stringify(invalid));
  const invalidResult = invoke(['replay', '--replay-manifest', invalidFile], box);
  assert.equal(invalidResult.code, 1);
  assert.equal(invalidResult.output.status, REPLAY_STATUS.REJECT);
  assert.equal(invalidResult.output.error.code, REPLAY_ERROR_CODES.INVALID_MANIFEST);

  assertCanonicalUntouched(box);
});

test('replay usage errors throw before any store is opened', async (t) => {
  const box = sandbox(t);
  const file = writeText(box, 'replay.json', JSON.stringify(replayRequest()));
  await assert.rejects(
    runCognitiveLab(['replay'], { openGraph: () => { throw new Error('must not open a graph'); } }),
    /expected replay --replay-manifest FILE/,
  );
  await assert.rejects(
    runCognitiveLab(['replay', '--replay-manifest', file], {}),
    /replay requires a graph opener/,
  );
  assert.deepEqual(fs.readdirSync(box.root).sort(), ['canonical-memory.json', 'replay.json']);
  assertCanonicalUntouched(box);
});
