'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lockfile = require('proper-lockfile');
const { Readable } = require('node:stream');
const { runCognitiveLab } = require('../lib/cognitive-lab-cli');
const Database = require('better-sqlite3');
const { comparisonInput, budgets } = require('./helpers/cognitive-lab-comparison');

const BIN = path.resolve(__dirname, '../bin/huqan-cognitive-lab.js');

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-paired-cli-test-'));
  const canonical = path.join(root, 'canonical-memory.json');
  fs.writeFileSync(canonical, '{"private":"untouched"}');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, canonical };
}

function invoke(args, input, box, bin = BIN) {
  const result = spawnSync(process.execPath, [bin, ...args], {
    cwd: box.root, input: input === undefined ? '' : JSON.stringify(input), encoding: 'utf8', timeout: 15000,
    env: { ...process.env, HUQAN_MEMORY_PATH: box.canonical, HUQAN_STATE_ROOT: box.root },
  });
  assert.ifError(result.error);
  assert.ok(result.stdout.trim(), result.stderr);
  const output = JSON.parse(result.stdout.trim());
  return { code: result.status, output, stderr: result.stderr };
}

test('CLI separates processes, preserves canonical memory and retains paired results after restart', { timeout: 120000 }, t => {
  const box = sandbox(t);
  const input = comparisonInput();
  const initialized = invoke(['init', '--root', box.root], input, box);
  assert.equal(initialized.code, 0, initialized.stderr);
  const state = initialized.output.state;
  assert.equal(path.dirname(state), fs.realpathSync(box.root));
  assert.ok(path.basename(state).startsWith('huqan-cognitive-lab-'));
  assert.equal(initialized.output.runtime.backend, 'sqlite');
  const args = command => [command, '--state', state];
  for (const task of input.tasks.filter(t => t.split !== 'train')) {
    for (const [variant, probability] of [['baseline', 0.5], ['candidate', 0.8]]) {
      assert.equal(invoke(args('forecast'), { runId: input.runId, variant, taskId: task.taskId, probability }, box).code, 0);
    }
    assert.equal(invoke(args('outcome'), { runId: input.runId, taskId: task.taskId, outcome: 'confirmed' }, box).code, 0);
  }
  for (const [variant, budget] of Object.entries(budgets(input))) {
    assert.equal(invoke(args('budget'), { runId: input.runId, variant, ...budget }, box).code, 0);
  }
  const first = invoke(args('report'), { runId: input.runId }, box);
  const second = invoke(args('report'), { runId: input.runId }, box);
  assert.equal(first.code, 0);
  assert.equal(first.output.status, 'MEASURED');
  assert.equal(first.output.calibrationComparison, 'MEANINGFUL_IMPROVEMENT');
  assert.equal(first.output.assertsGain, false);
  assert.equal(first.output.intelligenceGain, 'NOT_MEASURED');
  assert.equal(first.output.budget.usageEvidence, 'CALLER_REPORTED');
  assert.equal(first.output.correctnessDigest, second.output.correctnessDigest);
  assert.equal(first.output.splits.holdout.counts.observed, 10);
  assert.equal(fs.readFileSync(box.canonical, 'utf8'), '{"private":"untouched"}');
  assert.equal(fs.existsSync(path.join(box.root, 'memory.db')), false);
  assert.equal(invoke(args('forecast'), { runId: input.runId, variant: 'candidate', taskId: 'holdout-0', probability: 0.99 }, box).code, 1);
});

test('CLI refuses an unowned state, malformed input, concurrent writer and late forecast', t => {
  const box = sandbox(t);
  assert.equal(invoke(['report', '--state', box.root], { runId: 'x' }, box).code, 1);
  assert.equal(fs.existsSync(path.join(box.root, 'memory.db')), false);
  assert.equal(invoke(['init', '--root', box.root], { confidence: 1 }, box).code, 1);
  const input = comparisonInput();
  const state = invoke(['init', '--root', box.root], input, box).output.state;
  const entry = { runId: input.runId, variant: 'candidate', taskId: 'holdout-0', probability: 0.5 };
  const release = lockfile.lockSync(state, { realpath: true });
  try {
    const blocked = invoke(['forecast', '--state', state], entry, box);
    assert.equal(blocked.code, 1);
    assert.match(blocked.output.error, /locked|lock/i);
  } finally { release(); }
  assert.equal(invoke(['outcome', '--state', state], { runId: input.runId, taskId: entry.taskId, outcome: 'confirmed' }, box).code, 0);
  const late = invoke(['forecast', '--state', state], entry, box);
  assert.equal(late.code, 1);
  assert.match(late.output.error, /outcome/);
  assert.equal(invoke(['report', '--state', state], { runId: input.runId }, box).output.status, 'INSUFFICIENT');
  assert.equal(invoke(['report', '--state', state, '--unknown'], { runId: input.runId }, box).code, 1);
});

test('CLI help opens no store and rejects linked state files before writes', t => {
  const box = sandbox(t);
  assert.equal(invoke(['--help'], undefined, box).code, 0);
  assert.deepEqual(fs.readdirSync(box.root), ['canonical-memory.json']);
  const input = comparisonInput();
  const state = invoke(['init', '--root', box.root], input, box).output.state;
  const dbPath = path.join(state, 'memory.db');
  const copy = path.join(box.root, 'linked.db');
  fs.linkSync(dbPath, copy);
  const report = invoke(['report', '--state', state], { runId: input.runId }, box);
  assert.equal(report.code, 1);
  assert.match(report.output.error, /link/);
});

test('bounded input and unavailable native SQLite fail closed and release the state lock', async t => {
  const box = sandbox(t);
  let opened = 0;
  const opener = () => { opened += 1; throw new Error('unexpected graph open'); };
  for (const text of ['null', '{}x', 'x'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(runCognitiveLab(['init', '--root', box.root], { stdin: Readable.from([text]), openGraph: opener }));
  }
  assert.equal(opened, 0);
  assert.deepEqual(fs.readdirSync(box.root), ['canonical-memory.json']);
  let closed = false;
  await assert.rejects(runCognitiveLab(['init', '--root', box.root], {
    stdin: Readable.from([JSON.stringify(comparisonInput())]),
    openGraph: () => ({ _db: null, closeSqlite() { closed = true; } }),
  }), /native SQLite/);
  assert.equal(closed, true);
  const state = path.join(box.root, fs.readdirSync(box.root).find(name => name.startsWith('huqan-cognitive-lab-')));
  const release = lockfile.lockSync(state, { realpath: true });
  release();
});

test('marker path replacement cannot change the already-opened marker evidence', async t => {
  const box = sandbox(t);
  const input = comparisonInput();
  const state = invoke(['init', '--root', box.root], input, box).output.state;
  const markerPath = path.join(state, 'comparison-state.json');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  const read = fs.readFileSync;
  const readSync = fs.readSync;
  let swapped = false;
  let opened = 0;
  const replacePath = file => {
    if (!swapped && (file === markerPath || typeof file === 'number')) {
      fs.renameSync(markerPath, `${markerPath}.prior`);
      fs.writeFileSync(markerPath, JSON.stringify({ ...marker, designDigest: 'a'.repeat(64) }));
      swapped = true;
    }
  };
  fs.readFileSync = (file, ...args) => {
    replacePath(file);
    return read(file, ...args);
  };
  fs.readSync = (file, ...args) => { replacePath(file); return readSync(file, ...args); };
  try {
    await assert.rejects(runCognitiveLab(['report', '--state', state], {
      stdin: Readable.from([JSON.stringify({ runId: input.runId })]),
      readDesign: () => ({ digest: marker.designDigest }),
      openGraph: () => { opened += 1; throw new Error('verified initial marker'); },
    }), /verified initial marker/);
    assert.equal(swapped, true);
    assert.equal(opened, 1);
  } finally { fs.readFileSync = read; fs.readSync = readSync; }
});

test('forged marker and absent store are rejected before any SQLite schema or file write', t => {
  const box = sandbox(t);
  const state = fs.mkdtempSync(path.join(box.root, 'huqan-cognitive-lab-'));
  fs.writeFileSync(path.join(state, 'comparison-state.json'), JSON.stringify({
    schemaVersion: 'huqan-cognitive-lab-state-v1', runId: 'forged', designDigest: 'a'.repeat(64),
  }));
  const args = ['report', '--state', state];
  const dbPath = path.join(state, 'memory.db');
  assert.equal(invoke(args, { runId: 'forged' }, box).code, 1);
  assert.equal(fs.existsSync(dbPath), false, 'refused state must not create a database');
  const db = new Database(dbPath);
  db.exec('CREATE TABLE canonical_sentinel(value TEXT); INSERT INTO canonical_sentinel VALUES (\'private\')');
  db.close();
  const before = fs.readFileSync(dbPath);
  assert.equal(invoke(args, { runId: 'forged' }, box).code, 1);
  assert.deepEqual(fs.readFileSync(dbPath), before, 'refused state must not migrate an unrelated database');
  const checked = new Database(dbPath, { readonly: true });
  try { assert.deepEqual(checked.prepare('SELECT name FROM sqlite_master WHERE type=\'table\'').all(), [{ name: 'canonical_sentinel' }]); }
  finally { checked.close(); }
});

test('refused WAL database creates no sidecar files in the supplied state', t => {
  const box = sandbox(t);
  const state = fs.mkdtempSync(path.join(box.root, 'huqan-cognitive-lab-'));
  fs.writeFileSync(path.join(state, 'comparison-state.json'), JSON.stringify({
    schemaVersion: 'huqan-cognitive-lab-state-v1', runId: 'forged', designDigest: 'a'.repeat(64),
  }));
  const dbPath = path.join(state, 'memory.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec('CREATE TABLE canonical_sentinel(value TEXT)');
  db.close();
  const before = fs.readFileSync(dbPath);
  const files = fs.readdirSync(state).sort();
  assert.equal(invoke(['report', '--state', state], { runId: 'forged' }, box).code, 1);
  assert.deepEqual(fs.readdirSync(state).sort(), files);
  assert.deepEqual(fs.readFileSync(dbPath), before);
});

test('a committed design and forecast survive an abruptly terminated WAL writer', t => {
  const box = sandbox(t);
  const state = fs.mkdtempSync(path.join(box.root, 'huqan-cognitive-lab-'));
  const input = comparisonInput();
  const forecast = { runId: input.runId, variant: 'baseline', taskId: 'holdout-0', probability: 0.5 };
  const script = `
    const fs = require('node:fs');
    const Graph = require(${JSON.stringify(path.resolve(__dirname, '../graph'))});
    const store = require(${JSON.stringify(path.resolve(__dirname, '../lib/cognitive-lab-comparison-store'))});
    const {buildComparisonManifest} = require(${JSON.stringify(path.resolve(__dirname, '../lib/cognitive-lab-comparison-contract'))});
    const input = ${JSON.stringify(input)};
    const design = buildComparisonManifest(input);
    fs.writeFileSync(${JSON.stringify(path.join(state, 'comparison-state.json'))}, JSON.stringify({
      schemaVersion:'huqan-cognitive-lab-state-v1',runId:input.runId,designDigest:design.digest
    }));
    const graph = new Graph({memoryPath:${JSON.stringify(path.join(state, 'memory.json'))},dbPath:${JSON.stringify(path.join(state, 'memory.db'))}});
    store.prepareComparison(graph,input);
    store.recordComparisonForecast(graph,${JSON.stringify(forecast)});
    process.stdout.write('committed', () => process.kill(process.pid, 'SIGKILL'));
  `;
  const crashed = spawnSync(process.execPath, ['-e', script], { cwd: box.root, encoding: 'utf8', timeout: 15000 });
  assert.ifError(crashed.error);
  assert.equal(crashed.stdout, 'committed', crashed.stderr);
  assert.ok(fs.statSync(path.join(state, 'memory.db-wal')).size > 0);
  const replay = invoke(['forecast', '--state', state], forecast, box);
  assert.equal(replay.code, 0, replay.output.error);
  assert.equal(replay.output.replayed, true);
  assert.equal(invoke(['report', '--state', state], {runId:input.runId}, box).output.status, 'INSUFFICIENT');
});
