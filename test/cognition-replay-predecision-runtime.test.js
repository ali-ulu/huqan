'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const KernelV2 = require('../kernel.v2');
const AgentV3 = require('../agent.v3');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../lib/human-oversight-approval-runtime');
const { AGENT_ACTION_FIREWALL_VERSION } = require('../lib/agent-action-firewall');
const { buildAgentCoderAction, createAgentCoderExecution } = require('../lib/agent-coder-execution');
const { createExperienceJournal } = require('../lib/experience/journal');
const { openJournalConnection } = require('../lib/experience/journal-connection');
const { readSealedRun } = require('../lib/experience/learning-intake');
const { readPredictionPairs } = require('../lib/prediction-outcome-pairs');

const sha = value => createHash('sha256').update(value).digest('hex');
function sourceBytes(files) {
  return Object.fromEntries(files.flatMap(file => ['', '-wal', '-shm', '-journal', '.redo.json']
    .map(suffix => `${file}${suffix}`)).filter(file => fs.existsSync(file))
    .map(file => [file, sha(fs.readFileSync(file))]));
}
function fixture(t) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'replay-predecision-')));
  const root = path.join(dir, 'repo'); fs.mkdirSync(root);
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git('init', '-q', '-b', 'feature/predecision'); git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(root, 'value.js'), 'module.exports = () => 1;\n');
  fs.writeFileSync(path.join(root, 'check.js'), "require('node:assert/strict').equal(require('./value')(),2);\n");
  git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture');
  const candidates = ['3', '2'].map(replace => ({ type: 'replace_text', path: 'value.js', find: '1', replace }));
  const task = { id: 'predecision', level: 'l0', allowedPaths: ['value.js'], operation: candidates[0],
    candidates, test: { command: 'node check.js' } };
  const goal = 'return two', workspaceId = 'default', memoryPath = path.join(dir, 'graph.json');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath });
  const db = path.join(dir, 'experience.db'), store = openJournalConnection({ dbPath: db });
  assert.ok(store);
  const journal = createExperienceJournal({ store });
  const approvalRuntime = createHumanOversightApprovalRuntime({ graph: kernel.graph,
    ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ role, action: scoped }) => ({ decision: 'allow', identity: {
      identityRef: role === 'requester' ? 'agent:coder' : 'human:operator',
      identityHash: role === 'requester' ? 'coder-hash' : 'operator-hash', workspaceId: scoped.workspaceId,
      authorityRef: 'fixture-owner', agentId: role === 'requester' ? 'coder' : '', ownerActorId: role } }) });
  const action = buildAgentCoderAction({ root, task, goal, workspaceId,
    policyVersion: 'fixture-v1', firewallVersion: AGENT_ACTION_FIREWALL_VERSION });
  const created = approvalRuntime.createReviewCase({ action, firewallDecision: 'review', requesterContext: {} });
  assert.equal(created.ok, true);
  assert.equal(approvalRuntime.decide({ caseId: created.case.caseId, decisionType: 'approve', approverContext: {},
    reason: 'approve exact predecision task', evidenceDigest: created.case.evidenceDigest }).ok, true);
  const config = { root, task, goal, action, approvalRuntime, requesterContext: {}, caseId: created.case.caseId, journal };
  const step = createAgentCoderExecution(config).plan(goal, workspaceId)[0];
  const opts = { resume: false, maxSteps: 1, maxIterations: 1,
    cognition: { percept: true, predictionError: true, reward: true, value: true, salience: true },
    cognitiveScheduler: { budget: 100, starvationWindow: 8 },
    cognitionFrame: { repo: root, branch: action.args.branch, commit: action.args.head,
      environment: 'test', actor: 'operator', time: '2026-10-25T00:00:00Z', goal, task: task.id },
    cognitionCoderExpectations: { [step.id]: { workspaceId, expected: 'passed', sourceGroup: 'predecision-source', riskScore: 20 } } };
  const agent = new AgentV3({ kernel, dbPath: path.join(dir, 'agent.db'), dreamExperimentLoop: false, coderExecution: config });
  t.after(() => { agent.storage.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const run = agent.run(goal, opts);
  assert.equal(run.data.steps[0].result.data.attempts.length, 2);
  assert.equal(run.data.steps[0].result.data.attempts[0].rolledBack, true);
  const pair = Object.values(readPredictionPairs(kernel.graph)).find(row => row.acceptance);
  assert.ok(pair); assert.equal(pair.acceptance.runId.endsWith(':c2'), true);
  const firstId = pair.acceptance.runId.replace(/:c2$/, ':c1');
  const first = readSealedRun(journal, firstId, workspaceId), final = readSealedRun(journal, pair.acceptance.runId, workspaceId);
  const headers = [first, final].map(source => source.events.find(event => event.type === 'run_started').payload.predecision);
  assert.equal(headers[0].predictionHash, pair.predictionHash); assert.deepEqual(headers[0], headers[1]);
  assert.equal(pair.acceptance.sourceHash, final.sourceHash);
  const predictionFile = kernel.graph._paths.journalPath;
  assert.ok(fs.existsSync(predictionFile));
  agent.storage.close(); store.close();
  const request = path.join(dir, 'request.json');
  fs.writeFileSync(request, JSON.stringify({ capabilityId: 'predecision-replacement', parentVersion: 0,
    params: { path: 'value.js', oldText: '1', newText: '2' },
    qualificationInputs: [{ id: 'unseen', before: 'unseen 1', expectedAfter: 'unseen 2' }] }));
  return { dir, db, predictionFile, request, pair, firstId };
}
function invoke(f, predictionFile = f.predictionFile) {
  const args = [path.resolve(__dirname, '../cli.js'), 'terfi', '--from-replay', '--dry-run', '--journal', f.db,
    '--workspace', 'default', '--request', f.request, '--json',
    ...(predictionFile === null ? [] : ['--prediction-journal', predictionFile])];
  return spawnSync(process.execPath, args, { cwd: f.dir, encoding: 'utf8', windowsHide: true, timeout: 20000 });
}

test('a fresh CLI binds one real two-candidate decision to its frozen prediction without source writes', t => {
  const f = fixture(t), before = sourceBytes([f.db, f.predictionFile]);
  const child = invoke(f);
  assert.equal(child.status, 0, child.stderr || child.stdout);
  const result = JSON.parse(child.stdout).data;
  assert.equal(result.signals.length, 1, JSON.stringify(result));
  const signal = result.signals[0];
  assert.equal(signal.episodeId, f.pair.acceptance.runId);
  assert.equal(signal.expectationSource, 'bound_prediction');
  assert.equal(signal.predictionHash, f.pair.predictionHash);
  assert.equal(signal.predictionDecisionId, f.pair.decisionId);
  assert.equal(signal.sourceRef, f.pair.acceptance.sourceRef);
  assert.equal(signal.sourceHash, f.pair.acceptance.sourceHash);
  assert.equal(signal.reward.expected, f.pair.rewardContext.expected ?? 0);
  assert.equal(signal.reward.reward, 1);
  assert.ok(result.skipped.some(row => row.episodeId === f.firstId && row.reason === 'internal_candidate_attempt'));
  assert.equal(result.candidates.length, 0, 'the two internal attempts are only one decision');
  assert.equal(result.registered, false); assert.equal(result.assertsGain, false);
  assert.deepEqual(sourceBytes([f.db, f.predictionFile]), before);

  const missing = invoke(f, null);
  assert.equal(missing.status, 0, missing.stderr || missing.stdout);
  const abstained = JSON.parse(missing.stdout).data;
  assert.deepEqual(abstained.signals, []);
  assert.ok(abstained.skipped.every(row => row.reason === 'prediction_source_required'));
  assert.deepEqual(sourceBytes([f.db, f.predictionFile]), before);

  const original = JSON.parse(fs.readFileSync(f.predictionFile, 'utf8'));
  const changes = [
    ['expectation', prediction => { prediction.rewardContext.expected = 1; }],
    ['frame', prediction => { prediction.frameHash = 'e'.repeat(64); prediction.rewardContext.history.frameHash = prediction.frameHash; }],
    ['workspace', prediction => { prediction.workspaceId = 'foreign'; prediction.rewardContext.history.workspaceId = 'foreign'; }],
    ['time', prediction => { prediction.prediction.at = '2000-01-01T00:00:00.000Z'; }],
    ['acceptance', (prediction, outcome) => { outcome.acceptance.sourceHash = 'd'.repeat(64); }],
  ];
  for (const [name, change] of changes) {
    const copy = structuredClone(original), rows = Object.values(copy.operations).map(row => row.result);
    const prediction = rows.find(row => row?.predictionPair && row.decisionId === f.pair.decisionId && row.prediction);
    const outcome = rows.find(row => row?.predictionPair && row.decisionId === f.pair.decisionId && row.outcome);
    change(prediction, outcome);
    const file = path.join(f.dir, `${name}.json`); fs.writeFileSync(file, JSON.stringify(copy));
    const snapshot = sourceBytes([f.db, f.predictionFile, file]), rejected = invoke(f, file);
    if (rejected.status === 0) {
      const result = JSON.parse(rejected.stdout).data;
      assert.deepEqual(result.signals, [], `${name}: ${JSON.stringify(result)}`);
      assert.equal(result.candidates.length, 0);
      assert.ok(result.skipped.length > 0);
    } else {
      assert.equal(rejected.status, 2, `${name}: ${rejected.stderr || rejected.stdout}`);
      assert.match(rejected.stderr + rejected.stdout, /prediction|INVALID_PREDICTION_SOURCE/i);
    }
    assert.deepEqual(sourceBytes([f.db, f.predictionFile, file]), snapshot, name);
  }
});
