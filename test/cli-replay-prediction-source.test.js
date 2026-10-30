'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Graph = require('../graph');
const { recordPrediction, recordOutcome, readPredictionPairs } = require('../lib/prediction-outcome-pairs');
const { openPredictionSource } = require('../lib/cli-replay-prediction-source');
const { openJournalConnection } = require('../lib/experience/journal-connection');

const AT = '2026-01-01T00:00:00.000Z';
function input(id, workspaceId = 'default') {
  const binding = { workspaceId, runId: 'agent-run', stepId: `coder:${id}`, frameHash: 'a'.repeat(64),
    expectationHash: 'b'.repeat(64), sourceGroup: id, sourceRefs: [`coder-run:${id}:c1`] };
  return { decisionId: id, at: AT, score: 20, actionClass: 'coder:replace_text', binding,
    rewardContext: { key: 'risk:coder:replace_text', expected: -1,
      history: { workspaceId, frameHash: binding.frameHash, historyBoundary: { at: AT, decisionId: id, priorDecisionIds: [] } } } };
}
function fixture(t, sqlite = false) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'prediction-source-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const graph = new Graph({ useSQLite: sqlite, memoryPath: path.join(dir, 'memory.json'), dbPath: path.join(dir, 'memory.db') });
  try {
    for (const [id, workspaceId] of [['native', 'default'], ['foreign', 'other']]) {
      const prediction = input(id, workspaceId);
      recordPrediction(graph, prediction);
      recordOutcome(graph, { decisionId: id, outcome: 'confirmed', idempotencyKey: `outcome-${id}`, at: AT,
        acceptance: { sourceRef: prediction.binding.sourceRefs[0], sourceHash: 'c'.repeat(64),
          scopeHash: prediction.binding.expectationHash, runId: `${id}:c1` } });
    }
    return { dir, file: sqlite ? graph._paths.dbPath : graph.jsonJournalPath(), pairs: readPredictionPairs(graph),
      opts: { workspaceId: 'default', asOf: new Date().toISOString() } };
  } finally { graph.close(); }
}
function bytes(dir) {
  return Object.fromEntries(fs.readdirSync(dir).sort().map(name => [name, fs.readFileSync(path.join(dir, name)).toString('base64')]));
}
const invalid = action => assert.throws(action, error => error.code === 'INVALID_PREDICTION_SOURCE' && error.exitCode === 2);

for (const sqlite of [false, true]) test(`closed ${sqlite ? 'SQLite' : 'JSON'} writer reads the same scoped durable pairs without changing files`, t => {
  const f = fixture(t, sqlite), before = bytes(f.dir);
  const first = openPredictionSource(f.file, f.opts);
  assert.deepEqual(Object.keys(first.pairs), ['native']);
  assert.deepEqual(first.pairs.native, f.pairs.native);
  assert.match(first.pairs.native.predictionHash, /^[a-f0-9]{64}$/);
  assert.equal(first.rows.length, 2);
  assert.ok(first.rows.every(row => row.receipt === null));
  assert.deepEqual(openPredictionSource(f.file, f.opts), first);
  assert.deepEqual(bytes(f.dir), before, 'bytes and sidecar inventory stay unchanged');
  assert.deepEqual(openPredictionSource(f.file, { ...f.opts, asOf: AT }), { rows: [], pairs: {} });
  assert.deepEqual(openPredictionSource(f.file, { ...f.opts, workspaceId: 'absent' }), { rows: [], pairs: {} });
});

test('missing, wrong format and corrupt sources refuse without backend fallback or file creation', t => {
  const f = fixture(t), before = bytes(f.dir);
  invalid(() => openPredictionSource(path.join(f.dir, 'missing.db'), f.opts));
  assert.deepEqual(bytes(f.dir), before);
  for (const content of ['not-json', '{}', '{"operations":[]}', 'SQLite format 3\0broken']) {
    const file = path.join(f.dir, 'invalid'); fs.writeFileSync(file, content);
    const snapshot = bytes(f.dir);
    invalid(() => openPredictionSource(file, f.opts));
    assert.deepEqual(bytes(f.dir), snapshot);
  }
});

test('relevant malformed and future evidence refuses while foreign evidence is isolated', t => {
  const f = fixture(t), original = fs.readFileSync(f.file, 'utf8');
  const changes = [
    row => { row.result.storeVersion = 'unknown'; },
    row => { row.result.predictionPair = false; },
    row => { row.result.decisionId = 'another-decision'; },
    row => { row.result.sourceRefs = []; },
    row => { row.result.prediction.score = 101; },
    row => { row.result.rewardContext.history.workspaceId = 'other'; },
    row => { row.committedAt = '2999-01-01T00:00:00.000Z'; },
    row => { row.result.prediction.at = '2999-01-01T00:00:00.000Z'; },
    row => { row.result.prediction.at = 'invalid'; },
  ];
  for (const change of changes) {
    const journal = JSON.parse(original); change(journal.operations['prediction-outcome:prediction:native']);
    fs.writeFileSync(f.file, JSON.stringify(journal));
    invalid(() => openPredictionSource(f.file, f.opts));
    invalid(() => openPredictionSource(f.file, { ...f.opts, asOf: AT }));
  }
  const journal = JSON.parse(original);
  journal.operations['prediction-outcome:prediction:foreign'].result.rewardContext.expected = 99;
  fs.writeFileSync(f.file, JSON.stringify(journal));
  assert.deepEqual(openPredictionSource(f.file, f.opts).pairs.native, f.pairs.native);
});

test('orphan and duplicate outcome rows cannot fabricate a paired decision', t => {
  const f = fixture(t), original = fs.readFileSync(f.file, 'utf8');
  for (const mode of ['orphan', 'duplicate', 'reversed']) {
    const journal = JSON.parse(original);
    if (mode === 'orphan') delete journal.operations['prediction-outcome:prediction:native'];
    if (mode === 'duplicate') journal.operations['prediction-outcome:outcome:duplicate'] =
      structuredClone(journal.operations['prediction-outcome:outcome:outcome-native']);
    if (mode === 'reversed') journal.operations['prediction-outcome:outcome:outcome-native'].result.outcome.at =
      '2025-12-31T23:59:59.000Z';
    fs.writeFileSync(f.file, JSON.stringify(journal));
    invalid(() => openPredictionSource(f.file, f.opts));
  }
});

test('historical cutoff retains the prediction but excludes its later outcome', t => {
  const f = fixture(t), journal = JSON.parse(fs.readFileSync(f.file, 'utf8'));
  for (const [id, row] of Object.entries(journal.operations))
    row.committedAt = id.includes(':prediction:') ? AT : '2026-01-01T00:00:00.002Z';
  fs.writeFileSync(f.file, JSON.stringify(journal));
  const result = openPredictionSource(f.file, { ...f.opts, asOf: '2026-01-01T00:00:00.001Z' });
  assert.equal(result.rows.length, 1);
  assert.equal(result.pairs.native.outcome, null);
  assert.equal(result.pairs.native.predictionHash, f.pairs.native.predictionHash);
});

test('a real SQLite WAL refuses; closed malformed SQLite records also fail without fallback', t => {
  const f = fixture(t, true), connection = openJournalConnection({ dbPath: f.file });
  assert.ok(connection);
  try {
    connection.db.prepare('UPDATE mutation_journal SET completed_at = ? WHERE operation_id = ?')
      .run('2999-01-01T00:00:00.000Z', 'prediction-outcome:prediction:native');
    assert.ok(fs.statSync(`${f.file}-wal`).size > 0, 'writer has a real uncheckpointed WAL');
    const before = bytes(f.dir);
    invalid(() => openPredictionSource(f.file, f.opts));
    assert.deepEqual(bytes(f.dir), before);
  } finally { connection.close(); }
  const before = bytes(f.dir);
  invalid(() => openPredictionSource(f.file, f.opts));
  assert.deepEqual(bytes(f.dir), before);
});

test('pending sidecars, hardlinks and linked sources are rejected without changing source files', t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  for (const suffix of ['-wal', '-shm', '-journal', '.redo.json']) {
    fs.writeFileSync(`${f.file}${suffix}`, 'pending');
    invalid(() => openPredictionSource(f.file, f.opts));
    fs.rmSync(`${f.file}${suffix}`);
  }
  const hardlink = path.join(f.dir, 'hardlink'); fs.linkSync(f.file, hardlink);
  invalid(() => openPredictionSource(hardlink, f.opts));
  invalid(() => openPredictionSource(f.file, f.opts)); fs.rmSync(hardlink);
  const linked = path.join(f.dir, 'linked');
  try { fs.symlinkSync(f.file, linked, 'file'); }
  catch (error) { if (!['EPERM', 'EACCES'].includes(error.code)) throw error; t.diagnostic('file symlink unavailable; directory junction checked below'); }
  if (fs.existsSync(linked)) invalid(() => openPredictionSource(linked, f.opts));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'prediction-link-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  const junction = path.join(outside, 'junction'); fs.symlinkSync(f.dir, junction, 'junction');
  invalid(() => openPredictionSource(path.join(junction, path.basename(f.file)), f.opts));
  fs.rmSync(junction);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('a source replaced during its read is refused', t => {
  const f = fixture(t), read = fs.readFileSync;
  let changed = false;
  t.mock.method(fs, 'readFileSync', function(file, ...args) {
    const result = read.call(this, file, ...args);
    if (typeof file === 'number' && !changed) { changed = true; fs.appendFileSync(f.file, ' '); }
    return result;
  });
  invalid(() => openPredictionSource(f.file, f.opts));
  assert.equal(changed, true);
});
