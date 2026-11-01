'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { sha256Hex, stableStringify } = require('../lib/hash-chain');
const { CONTRACT } = require('../lib/cognitive-lab-b4-evaluator');
const { emptyMutationJournal } = require('../lib/mutation-journal');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { createExperienceJournal } = require('../lib/experience/journal');
const { runM3FamilyExperiment } = require('../lib/cognitive-lab-m3-experiment');

const schemaVersion = 'huqan-cog-m3-family-evaluation-v1';
const digest = file => sha256Hex(fs.readFileSync(file));
test('library callers must inject the M3 runner instead of opening a Graph or an implicit store', async () => {
  const { runCognitiveLab } = require('../lib/cognitive-lab-cli');
  await assert.rejects(runCognitiveLab(['m3', '--m3-records', 'unused.json'], {
    openGraph() { throw new Error('unexpected Graph'); },
  }), /M3 runner unavailable/);
});

function inventory(dir) {
  const result = {};
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) for (const [name, value] of Object.entries(inventory(file))) result[`${entry.name}/${name}`] = value;
    else result[entry.name] = digest(file);
  }
  return result;
}
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'm3-family-lab-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = name => path.join(dir, name);
  const source = openJournalConnection({ dbPath: file('source.db') });
  try { createExperienceJournal({ store: source }); } finally { source.close(); }
  fs.writeFileSync(file('prediction.json'), JSON.stringify(emptyMutationJournal()));
  fs.writeFileSync(file('replay.json'), JSON.stringify({ capabilityId: 'fixture-replacement', parentVersion: 0,
    params: { path: 'value.js', oldText: 'old', newText: 'new' },
    qualificationInputs: [{ id: 'qualification', before: 'qualification old', expectedAfter: 'qualification new' }] }));
  fs.writeFileSync(file('oracle.json'), JSON.stringify({ schemaVersion,
    rows: [{ id: 'oracle', expected: 'change', files: [{ path: 'value.js', sha256: sha256Hex('unseen expected value') }] }] }));
  const request = { schemaVersion, contract: { ...CONTRACT }, workspaceId: 'default', asOf: '2026-10-27T00:00:00.000Z',
    splits: { source: ['source-family'], qualification: ['qualification-family'], evaluation: ['evaluation-family'] },
    families: [{ familyId: 'evaluation-family', journal: 'source.db', predictionJournal: 'prediction.json', request: 'replay.json',
      journalHash: digest(file('source.db')), predictionHash: digest(file('prediction.json')), requestHash: digest(file('replay.json')) }],
    tasks: [{ taskId: 'held-out', familyId: 'evaluation-family', split: 'holdout', oracleId: 'oracle' }],
    records: [{ taskId: 'held-out', A1: null, A2: null }], oracleFile: 'oracle.json', oracleHash: digest(file('oracle.json')),
    protocolHash: sha256Hex(fs.readFileSync(path.resolve(__dirname, '../docs/task-packs/cog-m3-family-evaluation-contract.md'), 'utf8').replace(/\r\n/g, '\n')) };
  const save = () => {
    delete request.lockHash;
    request.lockHash = sha256Hex(stableStringify(request));
    fs.writeFileSync(file('request.json'), JSON.stringify(request));
  };
  save();
  fs.writeFileSync(file('no-graph.js'), `const p=require.resolve(${JSON.stringify(path.resolve(__dirname, '../graph'))});require(p);require.cache[p].exports=class {constructor(){throw Error('Graph constructor forbidden')}};
const fs=require('node:fs'),open=fs.openSync;fs.openSync=function(file,...args){if(String(file).replaceAll('\\\\','/').includes('/docs/task-packs/'))throw Error('Packaged runtime must not read task-pack docs');return open.call(this,file,...args)};`);
  const invoke = (...args) => spawnSync(process.execPath,
    ['--require', file('no-graph.js'), path.resolve(__dirname, '../bin/huqan-cognitive-lab.js'), ...args],
    { cwd: dir, windowsHide: true, encoding: 'utf8', timeout: 20000 });
  return { dir, file, request, save, invoke };
}

test('fresh Lab CLI validates real empty snapshots at the locked cutoff without opening a Graph or changing files', t => {
  const f = fixture(t), before = inventory(f.dir);
  const child = f.invoke('m3', '--m3-records', f.file('request.json'));
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'INSUFFICIENT'); assert.equal(report.reason, 'sample_below_minimum');
  assert.equal(report.assertsGain, false); assert.equal(report.experiment, 'NOT_RUN');
  assert.equal(report.cost, 'NOT_MEASURED'); assert.equal(report.familyLabels, 'CALLER_DECLARED');
  assert.equal(report.comparisons[0].cutoff, f.request.asOf);
  assert.deepEqual(report.comparisons[0].A1, []); assert.deepEqual(report.comparisons[0].A2, []);
  assert.deepEqual(inventory(f.dir), before);
});

test('missing locks, changed sources, split leakage and caller-declared outcomes cannot become gain evidence', t => {
  for (const change of [f => { delete f.request.lockHash; },
    f => { f.request.protocolHash = '0'.repeat(64); f.save(); },
    f => { f.request.splits.qualification = [...f.request.splits.source]; f.save(); },
    f => { f.request.families[0].journalHash = '0'.repeat(64); f.save(); },
    f => { f.request.contract.minimumSamples = 1; f.save(); },
    f => { f.request.records[0].correct = true; f.save(); }]) {
    const f = fixture(t); change(f);
    if (!f.request.lockHash) fs.writeFileSync(f.file('request.json'), JSON.stringify(f.request));
    const before = inventory(f.dir), child = f.invoke('m3', '--m3-records', f.file('request.json'));
    assert.equal(child.status, 1, child.stderr || child.stdout);
    assert.equal(JSON.parse(child.stdout).status, 'REJECT');
    assert.equal(JSON.parse(child.stdout).assertsGain, false);
    assert.deepEqual(inventory(f.dir), before);
  }
});

test('an unselected execution rejects before small-sample checks in either arm', t => {
  for (const arm of ['A1', 'A2']) {
    const f = fixture(t); f.request.records[0][arm] = { journal: 'invented', runId: 'fake' }; f.save();
    const report = runM3FamilyExperiment(f.file('request.json'));
    assert.equal(report.status, 'REJECT'); assert.equal(report.reason, 'trust_violation');
  }
});

test('help exposes the opt-in command and unknown mutation flags are rejected', t => {
  const f = fixture(t);
  assert.match(f.invoke('--help').stdout, /m3 --m3-records FILE/);
  assert.equal(f.invoke('m3', '--m3-records', f.file('request.json'), '--apply').status, 1);
});

test('actual learned Coder executions in both arms are verified against the independent oracle', t => {
  const { applyDerivation } = require('../lib/coder/apply-derivation');
  const { runFixLoop } = require('../lib/coder/fix-loop');
  const { readSealedRun } = require('../lib/experience/learning-intake');
  const { runReplayComparison } = require('../lib/cli-replay');
  const f = fixture(t), sourceRoot = f.file('source-root'); fs.mkdirSync(sourceRoot);
  const repoState = { branch: 'fixture/m3', dirty: false, hasUntracked: false };
  const task = { id: 'source', level: 'l0', allowedPaths: ['value.js'],
    operation: { type: 'replace_text', path: 'value.js', find: 'old', replace: 'new' } };
  let store = openJournalConnection({ dbPath: f.file('source.db') });
  try {
    const journal = createExperienceJournal({ store });
    for (let index = 0; index < 3; index++) {
      fs.writeFileSync(path.join(sourceRoot, 'value.js'), `separate source ${index} old`);
      assert.equal(applyDerivation({ task, root: sourceRoot, journal, repoState, authorized: true, runId: `source-${index}`,
        now: () => `2026-10-26T00:00:0${index}.000Z` }).ok, true);
    }
  } finally { store.close(); }
  const comparison = runReplayComparison(['--from-replay', '--dry-run', '--journal', f.file('source.db'),
    '--prediction-journal', f.file('prediction.json'), '--workspace', 'default', '--request', f.file('replay.json')], { asOf: f.request.asOf });
  assert.equal(comparison.priority.candidates.length, 1, JSON.stringify(comparison));
  const slots = {};
  store = openJournalConnection({ dbPath: f.file('source.db') });
  try {
    const journal = createExperienceJournal({ store });
    for (const [arm, selected] of [['A1', comparison.recent], ['A2', comparison.priority]]) {
      const candidate = selected.candidates[0], root = f.file(arm); fs.mkdirSync(root);
      fs.writeFileSync(path.join(root, 'value.js'), 'held-out old');
      fs.writeFileSync(path.join(root, 'drift.md'), 'no matching token');
      fs.writeFileSync(path.join(root, 'ambiguous.md'), 'old old');
      fs.writeFileSync(path.join(root, 'check.js'), "require('node:assert/strict').equal(require('node:fs').readFileSync('value.js','utf8'),'held-out new');");
      const learned = { ...task, id: `heldout-${arm}`, operation: { type: 'replace_text', path: 'value.js' },
        test: { command: 'node check.js' }, experience: { intentOnly: true, riskTier: 'low', candidates: [{
          capabilityId: candidate.capabilityId, sourceRunIds: candidate.support, compiledSupport: candidate.compiledSupport,
          sourceProcedureHash: candidate.procedure.hash, params: candidate.procedure.params,
          qualificationPaths: ['drift.md', 'ambiguous.md'],
        }] } };
      const run = runFixLoop({ task: learned, root, journal, workspaceId: 'default', repoState, authorized: true, runId: `heldout-${arm}` });
      assert.equal(run.ok, true, JSON.stringify(run));
      assert.equal(fs.readFileSync(path.join(root, 'value.js'), 'utf8'), 'held-out new');
      const runId = `heldout-${arm}:c1`, sealed = readSealedRun(journal, runId, 'default');
      assert.equal(sealed.ok, true);
      const started = sealed.events.find(row => row.type === 'run_started').payload;
      const proposed = sealed.events.find(row => row.type === 'action_proposed').payload;
      const spec = { id: started.taskId, allowedPaths: started.allowedPaths,
        candidates: [{ type: 'replace_text', path: proposed.path, findSha256: proposed.findSha256, replaceSha256: proposed.replaceSha256 }],
        testCommandHash: sha256Hex('node check.js') };
      const accepted = require('../lib/agent-coder-project-task').readOrdinaryAcceptance({ journal, workspaceId: 'default', spec,
        ticket: { baseRunId: `heldout-${arm}`, scopeHash: 'a'.repeat(64), sourceGroup: 'fixture', decisionId: 'fixture' } });
      assert.ok(accepted, JSON.stringify(sealed.events));
      const routed = sealed.events.find(row => row.type === 'routing_decided').payload;
      assert.equal(routed.boundProcedureVersion, candidate.procedure.hash, JSON.stringify(routed));
      slots[arm] = { journal: 'source.db', journalHash: '', runId, sourceHash: sealed.sourceHash };
    }
  } finally { store.close(); }
  const journalHash = digest(f.file('source.db'));
  slots.A1.journalHash = slots.A2.journalHash = journalHash;
  f.request.families[0].journalHash = journalHash;
  f.request.records[0] = { taskId: 'held-out', ...slots };
  fs.writeFileSync(f.file('oracle.json'), JSON.stringify({ schemaVersion,
    rows: [{ id: 'oracle', expected: 'change', files: [{ path: 'value.js', sha256: sha256Hex('held-out new') }] }] }));
  f.request.oracleHash = digest(f.file('oracle.json')); f.save();
  const before = inventory(f.dir), child = f.invoke('m3', '--m3-records', f.file('request.json'));
  assert.equal(child.status, 0, child.stdout || child.stderr);
  const report = JSON.parse(child.stdout);
  assert.equal(report.status, 'INSUFFICIENT'); assert.equal(report.reason, 'sample_below_minimum', JSON.stringify(report));
  assert.equal(report.holdoutFamilies, 1); assert.equal(report.assertsGain, false);
  assert.deepEqual(inventory(f.dir), before);
  const replayed = runReplayComparison(['--from-replay', '--dry-run', '--journal', f.file('source.db'),
    '--prediction-journal', f.file('prediction.json'), '--workspace', 'default', '--request', f.file('replay.json')]);
  for (const arm of ['A1', 'A2']) assert.ok(replayed.priority.signals.some(row => row.episodeId === slots[arm].runId),
    JSON.stringify(replayed.priority.skipped));
  assert.deepEqual(inventory(f.dir), before);
  f.request.records[0].A2.sourceHash = '0'.repeat(64); f.save();
  assert.equal(runM3FamilyExperiment(f.file('request.json')).reason, 'native_evidence_unavailable');
  fs.writeFileSync(f.file('oracle.json'), JSON.stringify({ schemaVersion,
    rows: [{ id: 'oracle', expected: 'change', files: [{ path: 'value.js', sha256: sha256Hex('incorrect oracle target') }] }] }));
  f.request.oracleHash = digest(f.file('oracle.json')); f.save();
  const rejected = runM3FamilyExperiment(f.file('request.json'));
  assert.equal(rejected.status, 'REJECT'); assert.equal(rejected.reason, 'trust_violation',
    'one arm wrong-write must reject even when the other arm has missing evidence and the sample is small');
});
