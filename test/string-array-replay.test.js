'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { createExperienceJournal } = require('../lib/experience/journal');
const { readSealedStringArrayEvidence } = require('../lib/experience/string-array-evidence');
const sha = data => createHash('sha256').update(data).digest('hex');
const cli = path.resolve(__dirname, '../cli.js');
function run(args, cwd) {
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(path.dirname(args[args.indexOf('--journal') + 1]), '.state') }; delete env.NODE_TEST_CONTEXT;
  const p = spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  assert.equal(p.status, 0, p.stderr + p.stdout); return JSON.parse(p.stdout).data;
}
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-replay-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = path.join(dir, 'journal.db');
  const runIds = []; let nativeOperation;
  for (const [i, binding] of ['options', 'methods', 'verbs'].entries()) {
    const root = path.join(dir, `repo-${i}`); fs.mkdirSync(root);
    const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
    git(['init', '-q', '-b', 'feature/replay']);
    fs.mkdirSync(path.join(root, 'src')); fs.mkdirSync(path.join(root, 'test'));
    const target = `src/item${i}.js`;
    fs.writeFileSync(path.join(root, target), `module.exports = function (${binding}) { return ${binding}.join(','); };\n`);
    fs.writeFileSync(path.join(root, 'test/check.js'), `const a=require('node:assert/strict'), f=require('../${target}'); a.equal(f(['POST','GET','POST']),'POST,GET'); a.equal(f([]),'');`);
    git(['add', 'src', 'test']); git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','source']);
    const task = { id: `native-${i}`, level: 'l0', allowedPaths: [target], operation: { type: 'replace_text', path: target }, test: { command: 'node test/check.js' }, synthesis: { family: 'string-array-join', target: { binding, separator: ',' }, examples: [{ input: [], output: '' }, { input: ['GET','GET','POST'], output: 'GET,POST' }, { input: ['POST','GET','POST'], output: 'POST,GET' }] } };
    const taskPath = path.join(dir, `task-${i}.json`); fs.writeFileSync(taskPath, JSON.stringify(task));
    const result = run(['coder', taskPath, '--synthesize', '--authorize', '--root', root, '--journal', db, '--run-id', task.id, '--json'], root);
    assert.equal(result.outcome, 'applied_tested'); runIds.push(result.synthesis.sourceRunId); if (i === 0) nativeOperation = result.synthesis.operation;
  }
  const store = openJournalConnection({ dbPath: db });
  let evidence;
  try {
    const journal = createExperienceJournal({ store });
    const sealed = runIds.map(id => readSealedStringArrayEvidence(journal, id, 'default')).filter(Boolean);
    assert.equal(sealed.length, 3); evidence = sealed[0];
    assert.ok(sealed.every(row => row.methodHash === evidence.methodHash));
    const events = journal.read(runIds[0]);
    for (const mutate of [
      e => { if (e.type === 'action_proposed') delete e.payload.semanticEvidence.sourcePin; },
      e => { if (e.type === 'action_proposed') e.payload.semanticEvidence.sourcePin.sha256 = '0'.repeat(64); },
      e => { if (e.type === 'execution_finished') e.payload.changes[0].beforeSha256 = '0'.repeat(64); },
      e => { if (e.type === 'execution_finished') e.payload.changes[0].afterSha256 = '0'.repeat(64); },
      e => { if (e.type === 'action_proposed') e.payload.semanticEvidence.after.type = 'unknown'; },
      e => { if (e.type === 'verification') e.payload.checks = []; },
    ]) {
      const copy = createExperienceJournal();
      for (const original of events) {
        const event = structuredClone(original); delete event.sequence; delete event.hash;
        mutate(event); assert.equal(copy.append(event).ok, true);
      }
      assert.equal(readSealedStringArrayEvidence(copy, runIds[0], 'default'), null);
    }
  } finally { store.close(); }
  return { dir, db, evidence, nativeOperation };
}
test('fresh CLI groups independently sealed semantic runs and preserves the journal', t => {
  const f = fixture(t);
  const request = { capabilityId: 'semantic-candidate', parentVersion: 0, params: { family: 'string-array-join', methodHash: f.evidence.methodHash }, qualificationInputs: [
    ...[[['B','A','B'], 'B,A'], [[], ''], [['a,b','a','a,b'], 'a,b,a'], [['','x',''], ',x']].map(([input, expected], i) => ({ id: `u${i}`, binding: 'items', before: `module.exports = function(items) { /* unseen ${i} */ return items.join(','); };`, expectedAfter: `module.exports = function(items) { /* unseen ${i} */ return (function(a){var out="",seen=[],i,j,n=a.length,v,found;for(i=0;i<n;i++){v=a[i];found=false;for(j=0;j<seen.length;j++){if(seen[j]===v){found=true;break;}}if(!found){if(seen.length)out+=",";out+=v==null?"":v;seen[seen.length]=v;}}return out;})(items); };`, input, expected })),
  ] };
  const requestPath = path.join(f.dir, 'replay.json'); fs.writeFileSync(requestPath, JSON.stringify(request));
  const before = sha(fs.readFileSync(f.db));
  const args = ['terfi','--from-replay','--dry-run','--journal',f.db,'--workspace','default','--request',requestPath,'--as-of',new Date().toISOString(),'--json'];
  const oldArgs = [...args]; oldArgs[oldArgs.indexOf('--as-of') + 1] = '2000-01-01T00:00:00.000Z';
  const old = run(oldArgs, f.dir); assert.deepEqual(old.selected, []); assert.deepEqual(old.candidates, []);
  const result = run(args, f.dir);
  assert.equal(result.authority, 'CANDIDATE_ONLY'); assert.equal(result.registered, false);
  assert.equal(result.candidates.length, 1, JSON.stringify(result.rejectedCandidates));
  assert.equal(result.candidates[0].nIndependent, 3); assert.equal(result.candidates[0].promotionInput, null);
  assert.equal(result.candidates[0].methodHash, f.evidence.methodHash);
  assert.deepEqual(run(args, f.dir), result, 'fresh processes share a deterministic cutoff');
  assert.equal(sha(fs.readFileSync(f.db)), before);
  const badOracle = structuredClone(request);
  badOracle.qualificationInputs[0].expected = 'A,B';
  fs.writeFileSync(requestPath, JSON.stringify(badOracle));
  const refused = run(args, f.dir);
  assert.deepEqual(refused.candidates, []);
  assert.equal(refused.status, 'INSUFFICIENT'); assert.equal(refused.reason, 'qualification_oracle_mismatch');
  assert.ok(refused.rejectedCandidates.some(row => row.reason === 'qualification_oracle_mismatch'));
  assert.equal(sha(fs.readFileSync(f.db)), before);
  const wrongType = structuredClone(request);
  wrongType.qualificationInputs[0].input = ['B', 42, 'B'];
  fs.writeFileSync(requestPath, JSON.stringify(wrongType));
  const child = spawnSync(process.execPath, [cli, ...args], { cwd: f.dir, env: { ...process.env, HUQAN_STATE_ROOT: path.join(f.dir, '.state') }, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const output = JSON.parse(child.stdout);
  assert.ok(child.status !== 0 || output.data.candidates.length === 0, 'wrong-typed input cannot qualify');
  assert.equal(sha(fs.readFileSync(f.db)), before);
  const bridgeDb = path.join(f.dir, 'bridge.db'); fs.copyFileSync(f.db, bridgeDb);
  // A genuine native readback failure with the exact same pinned source and patch.
  const root = path.join(f.dir, 'failed-native'); fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
  git(['init', '-q', '-b', 'feature/failure']); fs.mkdirSync(path.join(root, 'src'));
  const file = path.join(root, f.nativeOperation.path);
  const source = "module.exports = function (options) { return options.join(','); };\n";
  fs.writeFileSync(file, source); git(['add', 'src']);
  git(['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','source']);
  const store = openJournalConnection({ dbPath: f.db });
  try {
    const journal = createExperienceJournal({ store });
    const task = { id: 'failed-native', level: 'l0', allowedPaths: [f.nativeOperation.path], operation: f.nativeOperation,
      synthesisEvidenceTarget: { binding: 'options', separator: ',' }, synthesisSourcePin: { path: f.nativeOperation.path, sha256: sha(source) } };
    const failure = require('../lib/coder/apply-derivation').applyDerivation({ task, root,
      repoState: { known: true, branch: 'feature/failure', dirty: false, hasUntracked: false }, authorized: true, journal, runId: 'native-failed',
      verify: () => { fs.writeFileSync(file, 'corrupt readback'); return { ok: false }; }, verifyCommand: 'controlled-disk-fault' });
    assert.equal(failure.experience.failed, null);
    assert.equal(journal.manifest('native-failed').learningEligibility, 'negative_example', JSON.stringify(journal.read('native-failed')));
    const negativeEvents = journal.read('native-failed').map(event => structuredClone(event));
    const proposed = negativeEvents.find(event => event.type === 'action_proposed');
    delete proposed.payload.semanticEvidence;
    const policy = negativeEvents.find(event => event.type === 'policy_decided');
    const execution = negativeEvents.find(event => event.type === 'execution_started');
    const route = { ...structuredClone(policy), eventId: 'native-failed:route', type: 'routing_decided',
      causedByEventId: policy.eventId, payload: { execution: { operationType: proposed.payload.operationType,
        path: proposed.payload.path, findSha256: proposed.payload.findSha256, replaceSha256: '0'.repeat(64) } } };
    execution.causedByEventId = route.eventId;
    negativeEvents.splice(3, 0, route);
    const operationKey = JSON.stringify([proposed.payload.path, proposed.payload.findSha256, proposed.payload.replaceSha256]);
    const verdict = require('../lib/experience/string-array-replay').matchReplayNegative(
      { manifest: journal.manifest('native-failed'), events: negativeEvents }, new Map([[operationKey, [f.evidence]]]), f.evidence.methodHash);
    assert.deepEqual(verdict, { reason: 'semantic_negative_binding_unverified' });

  } finally { store.close(); }
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const negativeArgs = [...args]; negativeArgs[negativeArgs.indexOf('--as-of') + 1] = new Date().toISOString();
  const withNegative = run(negativeArgs, f.dir);
  assert.ok(withNegative.selected.some(row => row.episodeId === 'native-failed'));
  assert.ok(withNegative.signals.some(row => row.episodeId === 'native-failed' && row.reward.reward === -1));
  assert.equal(withNegative.status, 'INSUFFICIENT');
  assert.deepEqual(withNegative.candidates, []);
  // The unselected bridge connects two selected sources; it is not new evidence.
  const bridgeStore = openJournalConnection({ dbPath: bridgeDb });
  try {
    const journal = createExperienceJournal({ store: bridgeStore });
    for (const original of journal.read('native-0:c1')) {
      const event = structuredClone(original); delete event.sequence; delete event.hash;
      for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
        if (typeof event[key] === 'string') event[key] = event[key].replace('native-0:c1', 'old-bridge');
      }
      if (event.type === 'run_started') { event.payload.createdAt = '2000-01-01T00:00:00.000Z'; event.parentRunId = 'native-0:c1'; }
      if (event.type === 'action_proposed') event.parentRunId = 'native-1:c1';
      assert.equal(journal.append(event).ok, true);
    }
    for (const original of journal.read('native-2:c1')) {
      const event = structuredClone(original); delete event.sequence; delete event.hash;
      for (const key of ['runId', 'eventId', 'attemptId', 'invocationId', 'causedByEventId']) {
        if (typeof event[key] === 'string') event[key] = event[key].replace('native-2:c1', 'invalid-time');
      }
      if (event.type === 'run_started') event.payload.createdAt = 'not-a-date';
      assert.equal(journal.append(event).ok, true);
    }
  } finally { bridgeStore.close(); }
  fs.writeFileSync(requestPath, JSON.stringify(request));
  const bridgeArgs = [...args, '--budget', '3']; bridgeArgs[bridgeArgs.indexOf('--journal') + 1] = bridgeDb;
  bridgeArgs[bridgeArgs.indexOf('--as-of') + 1] = new Date().toISOString();
  const bridged = run(bridgeArgs, f.dir);
  assert.ok(bridged.skipped.some(row => row.episodeId === 'invalid-time' && row.reason === 'native_observation_missing'));
  assert.equal(bridged.selected.length, 3);
  assert.ok(bridged.selected.every(row => row.episodeId !== 'old-bridge'));
  assert.deepEqual(bridged.candidates, []);
  assert.equal(bridged.status, 'INSUFFICIENT');
  assert.equal(bridged.reason, 'insufficient_independent_consistency');

});
