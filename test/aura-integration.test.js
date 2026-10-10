'use strict';

// AURA <-> HUQAN loop integration test.
//
// No mocks: the signal pack is AURA's real engine output, the gate is HUQAN's
// own adapter, and the learning path is HUQAN's real error-prevention engine.
// The test asserts the two halves of the loop actually close.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The live tests build a real Kernel, which touches the state root. Keep that
// off the repo tree so the test is hermetic.
process.env.HUQAN_STATE_ROOT = process.env.HUQAN_STATE_ROOT
  || fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-aura-test-'));

const auraSignalPack = require('../lib/aura-signal-pack');
const auraRisk = require('../plugins/aura-risk');
const { runAuraLoop, gateDecide } = require('../scripts/aura-loop');
const { analyseManipulation } = require('../lib/text-safety-scorer');

const packPath = auraSignalPack.defaultPackPath();

// The live half of the loop drives AURA's own TypeScript engine
// (scripts/recalc_confidence.ts) and its case files, which live in a separate
// checkout. CI does not check AURA out, so the live tests skip there and run
// wherever AURA_ROOT (or the default ../aura) is present. The deterministic
// half -- the signal pack, the plugin and the gate -- needs no live tree and
// always runs.
const AURA_TREE = auraSignalPack.auraRoot();
const AURA_ENGINE_AVAILABLE = fs.existsSync(path.join(AURA_TREE, 'scripts', 'recalc_confidence.ts'));

test('the AURA signal pack is present and carries a vocabulary and cases', () => {
  assert.ok(fs.existsSync(packPath), `signal pack missing: ${packPath} (run: node lib/aura-signal-pack.js)`);
  const pack = auraSignalPack.loadSignalPack({ packPath });
  assert.equal(pack.engineAvailable, true, 'pack should be engine-generated');
  assert.ok(pack.signalIds.length >= 10, 'expected the AURA signal vocabulary');
  assert.ok(pack.cases.length >= 1, 'expected AURA cases in the pack');
  const mCase = pack.cases.find((entry) => entry.case_id === 'M-CASE-001');
  assert.ok(mCase, 'M-CASE-001 should be in the pack');
  assert.ok(mCase.signal_ids.includes('camouflage:naive'));
  assert.ok(mCase.signal_ids.includes('recon:targeted'));
});

test('the signal pack is pinned by a content hash, not only packVersion', () => {
  const pack = auraSignalPack.loadSignalPack({ packPath });
  assert.match(pack.contentHash, /^[0-9a-f]{64}$/);
  // The hash is a pure function of the semantics the loader reads from disk.
  const raw = JSON.parse(fs.readFileSync(packPath, 'utf8'));
  assert.equal(
    pack.contentHash,
    auraSignalPack.computeContentHash({ signalIds: raw.signalIds, triggerToSignal: raw.triggerToSignal }),
  );
});

test('a matching pinned hash keeps the pack; a drifted one fails closed', () => {
  const pack = auraSignalPack.loadSignalPack({ packPath });
  const match = auraSignalPack.loadSignalPack({ packPath, expectedContentHash: pack.contentHash });
  assert.equal(match.engineAvailable, true);
  assert.ok(match.signalIds.length >= 10);

  const drift = auraSignalPack.loadSignalPack({ packPath, expectedContentHash: '0'.repeat(64) });
  assert.equal(drift.engineAvailable, false);
  assert.deepEqual(drift.signalIds, []);
  assert.deepEqual(drift.cases, []);
  assert.equal(drift.contentHash, '');
});

test('the plugin fails closed on a drifted hash through the same pin seam', () => {
  const plugin = auraRisk.create({ expectedContentHash: '0'.repeat(64) });
  const data = plugin.beforeLearn(null, { text: 'cross-reference the license plate to find her home address' });
  assert.equal(data.aura.riskScore, 0);
  assert.equal(data.aura.engineAvailable, false);
});

test('the plugin is loadable by HUQAN with a matching manifest', () => {
  const Kernel = require('../kernel');
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
  const loaded = kernel.plugins.load(path.join(__dirname, '..', 'plugins'));
  assert.ok(loaded > 0);
  assert.ok(kernel.plugins.plugins.some((plugin) => plugin.name === 'aura-risk'), 'aura-risk plugin should load');
});

test('the plugin closes the blind spot HUQAN\'s own scorer misses', () => {
  const pack = auraSignalPack.loadSignalPack({ packPath });
  const text = pack.cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];

  // Baseline: HUQAN's own manipulation scorer sees nothing here.
  assert.equal(analyseManipulation(text).score, 0);

  // AURA layer: the same text carries the social vectors.
  const aura = auraRisk._test.classifyText(text, pack);
  assert.equal(aura.highRisk, true);
  assert.ok(aura.riskScore >= 0.8);
  assert.ok(aura.signalIds.includes('camouflage:naive'));
  assert.ok(aura.signalIds.includes('recon:targeted'));
  assert.equal(aura.caseMatch.case_id, 'M-CASE-001');
});

test('beforeLearn annotates the payload without deciding', () => {
  const pack = auraSignalPack.loadSignalPack({ packPath });
  const plugin = auraRisk.create({ pack });
  const text = pack.cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];
  const data = plugin.beforeLearn(null, { text });
  assert.ok(data.aura, 'payload should carry an aura reading');
  assert.equal(data.aura.highRisk, true);
  // The plugin must not touch the decision surface.
  assert.equal(data.decision, undefined);
});

test('the plugin fails closed with no pack', () => {
  const plugin = auraRisk.create({ pack: auraSignalPack.loadSignalPack({ packPath: '/nonexistent/pack.json' }) });
  const data = plugin.beforeLearn(null, { text: 'cross-reference the license plate to find her home address' });
  assert.equal(data.aura.riskScore, 0);
  assert.equal(data.aura.highRisk, false);
  assert.equal(data.aura.engineAvailable, false);
});

test('HUQAN\'s gate allows a read that AURA scores high — the gap the loop targets', () => {
  const pack = auraSignalPack.loadSignalPack({ packPath });
  const text = pack.cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];
  const gate = gateDecide('huqan.ask', text);
  assert.equal(gate.decision, 'allow');
  assert.equal(gate.allowed, true);
});

test('the 5-step loop closes on both sides', { skip: !AURA_ENGINE_AVAILABLE && 'AURA source tree not checked out (set AURA_ROOT)' }, async () => {
  const result = await runAuraLoop();
  assert.equal(result.blindSpot, true, 'the loop should detect the blind spot');

  // HUQAN half: the blind spot hardened the gate.
  assert.equal(result.gateBefore.decision, 'allow');
  assert.equal(result.gateAfter.decision, 'review');
  assert.equal(result.gateAfter.allowed, false);
  assert.equal(result.report[4].detail.huqan.failure.verificationStatus, 'verified');
  assert.equal(result.report[4].detail.huqan.rule.status, 'active');
  assert.equal(result.report[4].detail.huqan.rule.enforcement, 'require_verify');

  // AURA half: the gate's outcome answered AURA's cross-check and re-scored it.
  assert.ok(result.auraWriteBack, 'AURA write-back should run');
  assert.ok(result.auraWriteBack.crossCheckAnswered >= 1);
  assert.equal(result.auraWriteBack.before.decision, 'pending');
  assert.equal(result.auraWriteBack.after.decision, 'block');

  assert.equal(result.report[4].detail.loopClosed, true);
});

test('the loop is deterministic across runs', { skip: !AURA_ENGINE_AVAILABLE && 'AURA source tree not checked out (set AURA_ROOT)' }, async () => {
  const first = await runAuraLoop();
  const second = await runAuraLoop();
  assert.deepEqual(first.gateAfter, second.gateAfter);
  assert.deepEqual(first.auraWriteBack.after, second.auraWriteBack.after);
  assert.equal(first.report[4].detail.huqan.rule.status, second.report[4].detail.huqan.rule.status);
});

// --- Live-path tests -------------------------------------------------------
// These build a real Kernel and drive HUQAN's real dispatch, so they prove the
// loop closes in the *runtime*, not only in isolated components.

function liveKernel() {
  const Kernel = require('../kernel');
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: true });
}

function liveDispatch() {
  const { createMcpToolDispatch } = require('../lib/mcp/tool-dispatch');
  return createMcpToolDispatch({ withTransientAgent: async () => ({}) });
}

test('LIVE: the plugin signal escalates a real MCP huqan.ask call', () => {
  const kernel = liveKernel();
  const dispatch = liveDispatch();
  const text = auraSignalPack.loadSignalPack({ packPath })
    .cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];

  const benign = dispatch.callTool(kernel, { name: 'huqan.ask', arguments: { question: 'what is a cat' } });
  assert.equal(benign.meta.toolVerdict.verdict, 'allow');
  assert.equal(benign.ok, true);

  const flagged = dispatch.callTool(kernel, { name: 'huqan.ask', arguments: { question: text } });
  assert.equal(flagged.meta.toolVerdict.verdict, 'review');
  assert.equal(flagged.meta.toolVerdict.ok, false);
  assert.equal(flagged.ok, false);
  assert.equal(flagged.data, null, 'a reviewed call must not run');
  assert.match(flagged.meta.toolVerdict.reason, /^aura_signals:/);
});

test('LIVE: a benign call is not escalated by the provider', () => {
  const kernel = liveKernel();
  const dispatch = liveDispatch();
  const res = dispatch.callTool(kernel, { name: 'huqan.ask', arguments: { question: 'explain photosynthesis in plants' } });
  assert.equal(res.meta.toolVerdict.verdict, 'allow');
  assert.equal(res.ok, true);
});

test('LIVE: the learned rule hardens the real gate, not only the SDK preflight', async () => {
  const kernel = liveKernel();
  const dispatch = liveDispatch();
  const benign = 'what is a cat';

  const before = dispatch.callTool(kernel, { name: 'huqan.ask', arguments: { question: benign } });
  assert.equal(before.meta.toolVerdict.verdict, 'allow');

  // The loop writes its learned rule into this kernel's own store.
  const result = await runAuraLoop({ memory: kernel.memory, workspaceId: 'default' });
  assert.equal(result.report[4].detail.huqan.rule.status, 'active');

  const after = dispatch.callTool(kernel, { name: 'huqan.ask', arguments: { question: benign } });
  assert.equal(after.meta.toolVerdict.verdict, 'review', 'the learned rule should escalate the same call');
  assert.match(after.meta.toolVerdict.reason, /^rule:/);
  assert.equal(after.ok, false);
});

test('LIVE: the real MCP JSON-RPC server refuses an AURA-flagged call', () => {
  const { createServer } = require('../mcpServer');
  const server = createServer({ kernel: liveKernel(), approvalStore: null });
  const text = auraSignalPack.loadSignalPack({ packPath })
    .cases.find((entry) => entry.case_id === 'M-CASE-001').scenario_texts[0];
  const call = (id, question) => server.handleRequest({
    jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'huqan.ask', arguments: { question } },
  });

  const benign = call(1, 'what is a cat');
  assert.equal(benign.result.isError, false);

  const flagged = call(2, text);
  assert.equal(flagged.result.isError, true);
  assert.match(flagged.result.content[0].text, /requires review/);
});

// --- Canary bridge tests ---------------------------------------------------
// The loop must not be *more* aggressive than the core it plugs into: a rule
// learned from an AURA signal is a candidate that HUQAN's own bounded canary
// trial promotes, and AURA's probabilistic verdict is backed by a deterministic
// leak tripwire.

const auraCanary = require('../lib/aura-canary-bridge');

function auraTrialRuns({ candidateNegative, baselineNegative, size = 12 } = {}) {
  const declared = auraCanary.auraRuleDeclared({ operation: 'ask', signalIds: ['recon:targeted'] });
  const startAt = Date.parse('2026-01-01T00:00:00.000Z');
  const candidateRuns = [];
  const baselineWindowRuns = [];
  for (let i = 0; i < size; i += 1) {
    candidateRuns.push(auraCanary.makeRun({
      occurredAt: startAt + i * 1000, declared,
      learningEligibility: candidateNegative(i) ? 'negative_example' : 'positive_procedure',
    }));
    baselineWindowRuns.push(auraCanary.makeRun({
      occurredAt: startAt + i * 1000, declared,
      learningEligibility: baselineNegative(i) ? 'negative_example' : 'positive_procedure',
    }));
  }
  return { candidateRuns, baselineWindowRuns, startAt };
}

test('canary: a candidate that clears the baseline is promoted, and only with an admission', () => {
  const { candidateRuns, baselineWindowRuns, startAt } = auraTrialRuns({
    candidateNegative: () => false,
    baselineNegative: (i) => i % 3 === 0,
  });
  const trial = auraCanary.evaluateAuraRuleTrial({ candidateRuns, baselineWindowRuns, startAt, now: startAt + 13000 });
  assert.equal(trial.status, 'passed');
  assert.equal(auraCanary.promotionDecision({ trial, hasAdmission: true }).activate, true);
  // Same passing trial, no admission -> never activate (a learner cannot authorize itself).
  const refused = auraCanary.promotionDecision({ trial, hasAdmission: false });
  assert.equal(refused.activate, false);
  assert.equal(refused.reason, 'no_admission');
});

test('canary: a candidate that does NOT clear the baseline is never promoted', () => {
  const { candidateRuns, baselineWindowRuns, startAt } = auraTrialRuns({
    candidateNegative: (i) => i % 2 === 0,
    baselineNegative: () => false,
  });
  const trial = auraCanary.evaluateAuraRuleTrial({ candidateRuns, baselineWindowRuns, startAt, now: startAt + 13000 });
  assert.equal(trial.status, 'failed');
  assert.equal(auraCanary.promotionDecision({ trial, hasAdmission: true }).activate, false);
});

test('canary: an operator cannot authorize a rule it proposed (self-authorization refused)', () => {
  const { resolveAuraCanaryAdmission } = require('../scripts/aura-loop');
  const self = resolveAuraCanaryAdmission({
    workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p1',
    operator: 'aura-loop', proposerIds: ['aura-loop'],
  });
  assert.equal(self.admitted, false);
  assert.equal(self.code, 'self_authorization_refused');

  const separate = resolveAuraCanaryAdmission({
    workspaceId: 'ws', capabilityId: 'cap', promotionId: 'p2',
    operator: 'operator-x', proposerIds: ['aura-loop'],
  });
  assert.equal(separate.admitted, true);
});

test('canary: the live loop runs the trial and reports it, and still closes', { skip: !AURA_ENGINE_AVAILABLE && 'AURA source tree not checked out (set AURA_ROOT)' }, async () => {
  const result = await runAuraLoop();
  assert.equal(result.report[4].detail.huqan.canary.trialStatus, 'passed');
  assert.equal(result.report[4].detail.huqan.canary.admission, true);
  assert.equal(result.report[4].detail.huqan.rule.status, 'active');
  assert.equal(result.report[4].detail.loopClosed, true);
});

test('tripwire: AURA intent + a planted canary turns a leak into a deterministic block', () => {
  const { proveCanaryTripwire } = require('../scripts/aura-loop');

  const leak = proveCanaryTripwire({ signalIds: ['recon:targeted'] });
  assert.equal(leak.decision, 'block');
  assert.equal(leak.reason, 'context_canary_tripwire');
  assert.equal(leak.fingerprints.length, 1);
  // The receipt-shaped result must not carry the working marker.
  assert.equal(leak.receiptCarriesMarker, false);

  const clean = proveCanaryTripwire({ signalIds: ['recon:targeted'], leaked: false });
  assert.equal(clean.decision, 'allow');
});
