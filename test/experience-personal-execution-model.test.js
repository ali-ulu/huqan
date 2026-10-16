'use strict';

/**
 * Personal Execution Model tests (#2396, R3 Phase 8, design comment on #2396).
 *
 * Implements the acceptance tests listed at the end of the #2396 design
 * comment, in order. The pilot (acceptance test 3) runs the real
 * `replace_text` lineage end to end — real compiler compile/qualify, a real
 * capability-trust registry replayed to `trusted`, the real deterministic
 * router, and a real (in-memory) Experience journal — per the issue's own
 * "mock/unit success is not reported as live usage" clause. No network, no
 * disk, no timers: still hermetic, just not mocked at the module boundary.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  composePersonalExecutionModel, evaluatePersonalExecutionModel,
} = require('../lib/experience/personal-execution-model');
const { compile, qualify } = require('../lib/experience/compiler');
const { createCapabilityTrustRegistry, MIN_TRUSTED_EXECUTIONS, TRUST_STATES } = require('../lib/experience/capability-trust');
const { decideRoute } = require('../lib/experience/router');
const { assessOutcome } = require('../lib/experience/verifier');
const { createExperienceJournal } = require('../lib/experience/journal');
const { ToolRegistry } = require('../lib/workflow-tool-registry');
const { checkDeterministicPath } = require('../scripts/check-deterministic-path');

const T0 = Date.parse('2026-01-01T00:00:00.000Z');
const MIN = 60 * 1000;

function makeToolRegistry(names) {
  const registry = new ToolRegistry();
  for (const name of names) {
    registry.registerTool({ name, kind: 'external', run: async () => ({ ok: true }) });
  }
  return registry;
}

/** Build+trust the replace_text pilot capability via replayed fixture runs (no live traffic). */
function buildTrustedReplaceTextCapability(workspaceId) {
  const candidate = {
    status: 'candidate',
    runId: 'run-pilot-source',
    trace: { sources: ['hash-pilot-source'], scope: { workspaceId }, revision: 'e1' },
  };
  const params = { path: 'pilot-source.txt', oldText: 'foo', newText: 'bar' };
  const { procedure } = compile({ candidate, kind: 'replace_text', params });

  const registry = createCapabilityTrustRegistry();
  for (let i = 0; i < MIN_TRUSTED_EXECUTIONS; i += 1) {
    registry.recordRun({
      workspaceId,
      capabilityId: 'replace_text',
      procedureVersion: procedure.hash,
      eventId: `replace_text-pos-${i}`,
      runId: `run-replace_text-pos-${i}`,
      learningEligibility: 'positive_procedure',
      occurredAt: T0 + i * MIN,
    });
  }
  const entry = registry.get(workspaceId, 'replace_text');
  assert.equal(entry.trustState, TRUST_STATES.TRUSTED);
  return { registry, procedure, entry };
}

function withPreconditions(entry, preconditions) {
  return { ...entry, preconditions };
}

describe('Personal Execution Model: acceptance tests (#2396)', () => {
  it('1. two composition calls, identical inputs -> identical modelId', () => {
    const toolRegistry = makeToolRegistry(['replace_text']);
    const { entry } = buildTrustedReplaceTextCapability('ws-1');
    const args = {
      workspaceId: 'ws-1',
      policy: null,
      preferences: {},
      environment: { toolRegistry, env: {} },
      capabilityTrust: [withPreconditions(entry, { fileType: 'txt' })],
    };
    const a = composePersonalExecutionModel(args);
    const b = composePersonalExecutionModel(args);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(a.pem.modelId, b.pem.modelId);
    assert.equal(JSON.stringify(a.pem), JSON.stringify(b.pem));
  });

  it('2. workspaceId is embedded in modelId; a cross-workspace capability-trust reference throws', () => {
    const toolRegistry = makeToolRegistry(['replace_text']);
    const { entry } = buildTrustedReplaceTextCapability('ws-a');

    const pemA = composePersonalExecutionModel({
      workspaceId: 'ws-a',
      environment: { toolRegistry, env: {} },
      capabilityTrust: [withPreconditions(entry, { fileType: 'txt' })],
    });
    const pemB = composePersonalExecutionModel({
      workspaceId: 'ws-b',
      environment: { toolRegistry, env: {} },
      capabilityTrust: [],
    });
    assert.equal(pemA.ok, true);
    assert.equal(pemB.ok, true);
    assert.notEqual(pemA.pem.modelId, pemB.pem.modelId);

    // The entry above belongs to ws-a; composing it while tagged ws-b must
    // throw, not silently narrow to ws-b.
    assert.throws(() => composePersonalExecutionModel({
      workspaceId: 'ws-b',
      environment: { toolRegistry, env: {} },
      capabilityTrust: [withPreconditions(entry, { fileType: 'txt' })],
    }), (err) => err && err.code === 'PEM_CROSS_WORKSPACE_REFERENCE');
  });

  it('3-4. full replace_text pilot passes end-to-end against real fixture data, including under paranoidMode', () => {
    const workspaceId = 'ws-pilot';
    const { procedure, entry } = buildTrustedReplaceTextCapability(workspaceId);
    const toolRegistry = makeToolRegistry(['replace_text']);
    const candidateEntry = withPreconditions(entry, { fileType: 'txt', action: 'replace_text' });
    const request = { requestId: 'req-pem-pilot-1', declared: { fileType: 'txt', action: 'replace_text' }, riskTier: 'low' };

    // Compose without paranoid mode.
    const composed = composePersonalExecutionModel({
      workspaceId,
      policy: null,
      preferences: {},
      environment: { toolRegistry, env: {} },
      capabilityTrust: [candidateEntry],
    });
    assert.equal(composed.ok, true);
    const pem = composed.pem;

    // Route the request through the PEM.
    const routed = evaluatePersonalExecutionModel(pem, request, {
      capabilityTrust: [candidateEntry], toolRegistry, env: {},
    });
    assert.equal(routed.ok, true);
    assert.equal(routed.decision.chosenCapabilityId, 'replace_text');
    assert.equal(routed.decision.boundProcedureVersion, procedure.hash);
    assert.equal(routed.modelId, pem.modelId);

    // Execute the bound procedure deterministically against a held-out
    // input distinct from any input used to build trust above (which used
    // no real file content at all — recordRun only replays evidence).
    const files = { 'pilot-target.txt': 'a foo b' };
    const world = {
      observe: (input) => files[input],
      apply: (proc, input) => {
        const content = files[input];
        const sites = content.split(proc.params.oldText).length - 1;
        return { sites, after: content.split(proc.params.oldText).join(proc.params.newText) };
      },
    };
    const qualified = qualify({ procedure, inputs: ['pilot-target.txt'], ...world });
    assert.equal(qualified.ok, true);
    assert.equal(qualified.qualified, true);

    // Independent verification: a channel differing from the executor on
    // adapter, so it counts as independent per verifier.js's rule.
    const assessment = {
      verifier: { name: 'pem-pilot-verifier', version: '1' },
      kind: 'observational',
      verdict: 'verified',
      executor: { tool: 'experience.compiler.apply', adapter: 'fake-file-world', credentials: 'none' },
      channel: { tool: 'experience.compiler.apply', adapter: 'pem-pilot-verify-adapter', credentials: 'none' },
      proofs: {
        integrity: true, coverage: true, verification: true, provenance: true, permission: true,
      },
    };
    const outcome = assessOutcome({ executionStatus: 'completed', assessments: [assessment] });
    assert.equal(outcome.ok, true);
    assert.equal(outcome.outcomeStatus, 'verified');
    assert.equal(outcome.learningEligibility, 'positive_procedure');

    // New Experience chain closes, referencing this PEM's modelId.
    const journal = createExperienceJournal();
    const runId = 'run-pem-pilot-1';
    const events = [
      { eventId: 'e1', type: 'run_started' },
      { eventId: 'e2', type: 'action_proposed', causedByEventId: 'e1' },
      { eventId: 'e3', type: 'policy_decided', causedByEventId: 'e2' },
      {
        eventId: 'e4', type: 'routing_decided', causedByEventId: 'e3', payload: routed.decision,
      },
      { eventId: 'e5', type: 'execution_started', causedByEventId: 'e4' },
      {
        eventId: 'e6', type: 'execution_finished', causedByEventId: 'e5', executionStatus: 'completed',
      },
      {
        eventId: 'e7', type: 'verification', causedByEventId: 'e6', verdict: 'verified', proofs: assessment.proofs,
      },
      {
        eventId: 'e8', type: 'run_closed', causedByEventId: 'e7', payload: { modelId: pem.modelId },
      },
    ];
    for (const evt of events) {
      const res = journal.append({ runId, workspaceId, ...evt });
      assert.equal(res.ok, true, JSON.stringify(res));
    }
    const manifest = journal.manifest(runId);
    assert.equal(manifest.closed, true);
    assert.equal(manifest.learningEligibility, 'positive_procedure');
    const closingEvent = journal.read(runId, { workspaceId }).find((e) => e.type === 'run_closed');
    assert.equal(closingEvent.payload.modelId, pem.modelId);

    // 4. Re-run the same request under paranoidMode: true -- must still
    // pass; nothing in the compose/evaluate path ever touches llmAdapter.js
    // (see the deterministic-path assertion in acceptance test 7 below).
    const paranoidEnv = { HUQAN_PARANOID: '1' };
    const paranoidComposed = composePersonalExecutionModel({
      workspaceId,
      policy: null,
      preferences: {},
      environment: { toolRegistry, env: paranoidEnv },
      capabilityTrust: [candidateEntry],
    });
    assert.equal(paranoidComposed.ok, true);
    assert.equal(paranoidComposed.pem.environmentRef.paranoidMode, true);
    assert.notEqual(paranoidComposed.pem.modelId, pem.modelId);
    const paranoidRouted = evaluatePersonalExecutionModel(paranoidComposed.pem, request, {
      capabilityTrust: [candidateEntry], toolRegistry, env: paranoidEnv,
    });
    assert.equal(paranoidRouted.ok, true);
    assert.equal(paranoidRouted.decision.chosenCapabilityId, 'replace_text');
  });

  it('5. environment fingerprint mismatch (deregistered capability, or tool registry bump) -> refusal, never stale execution', () => {
    const workspaceId = 'ws-mismatch';
    const { entry } = buildTrustedReplaceTextCapability(workspaceId);
    const toolRegistry = makeToolRegistry(['replace_text']);
    const candidateEntry = withPreconditions(entry, { fileType: 'txt', action: 'replace_text' });
    const request = { requestId: 'req-pem-mismatch-1', declared: { fileType: 'txt', action: 'replace_text' }, riskTier: 'low' };

    const composed = composePersonalExecutionModel({
      workspaceId,
      environment: { toolRegistry, env: {} },
      capabilityTrust: [candidateEntry],
    });
    assert.equal(composed.ok, true);
    const pem = composed.pem;

    // Sanity: unmutated state still evaluates cleanly.
    const clean = evaluatePersonalExecutionModel(pem, request, {
      capabilityTrust: [candidateEntry], toolRegistry, env: {},
    });
    assert.equal(clean.ok, true);

    // (a) capability deregistered: no longer declared for this workspace.
    const afterDeregistration = evaluatePersonalExecutionModel(pem, request, {
      capabilityTrust: [], toolRegistry, env: {},
    });
    assert.equal(afterDeregistration.ok, false);
    assert.equal(afterDeregistration.code, 'environment_fingerprint_mismatch');
    assert.equal(afterDeregistration.decision, undefined);

    // (b) tool registry version bumped: a new tool registered.
    const bumpedToolRegistry = makeToolRegistry(['replace_text', 'a_new_tool']);
    const afterToolBump = evaluatePersonalExecutionModel(pem, request, {
      capabilityTrust: [candidateEntry], toolRegistry: bumpedToolRegistry, env: {},
    });
    assert.equal(afterToolBump.ok, false);
    assert.equal(afterToolBump.code, 'environment_fingerprint_mismatch');
  });

  it('6. preference override changes which of two tied capabilities wins; unset preference falls through unchanged', () => {
    // Router-level: proves the #2396 tiebreak hook (step 2.5) without
    // touching test/experience-router.test.js, whose existing cases must
    // keep passing unmodified.
    function tiedCandidate(capabilityId) {
      return {
        capabilityId, preconditions: { fileType: 'js' }, trustState: 'trusted', boundProcedureVersion: 'v1', trustSnapshotVersion: 'snap-1',
      };
    }
    const base = {
      requestId: 'req-pem-tiebreak-1',
      request: { declared: { fileType: 'js' } },
      candidates: [tiedCandidate('cap-b'), tiedCandidate('cap-a')],
    };
    const unset = decideRoute(base);
    assert.equal(unset.decision.chosenCapabilityId, 'cap-a'); // lexicographic, unchanged

    const preferred = decideRoute({ ...base, preferredCapabilityId: 'cap-b' });
    assert.equal(preferred.decision.chosenCapabilityId, 'cap-b'); // preference wins the tie

    // Through the PEM itself: preferenceRef.capabilityPreference drives the
    // same hook when evaluating a request.
    const toolRegistry = makeToolRegistry(['cap-a', 'cap-b']);
    const entries = [
      { capabilityId: 'cap-a', workspaceId: 'ws-tie', preconditions: { fileType: 'js' }, trustState: 'trusted', boundProcedureVersion: 'v1' },
      { capabilityId: 'cap-b', workspaceId: 'ws-tie', preconditions: { fileType: 'js' }, trustState: 'trusted', boundProcedureVersion: 'v1' },
    ];
    const composedWithPreference = composePersonalExecutionModel({
      workspaceId: 'ws-tie',
      preferences: { capabilityPreference: 'cap-b' },
      environment: { toolRegistry, env: {} },
      capabilityTrust: entries,
    });
    assert.equal(composedWithPreference.ok, true);
    assert.equal(composedWithPreference.pem.preferenceRef.capabilityPreference, 'cap-b');
    const routedWithPreference = evaluatePersonalExecutionModel(
      composedWithPreference.pem,
      { requestId: 'req-pem-tiebreak-2', declared: { fileType: 'js' } },
      { capabilityTrust: entries, toolRegistry, env: {} },
    );
    assert.equal(routedWithPreference.ok, true);
    assert.equal(routedWithPreference.decision.chosenCapabilityId, 'cap-b');

    const composedNoPreference = composePersonalExecutionModel({
      workspaceId: 'ws-tie',
      preferences: {},
      environment: { toolRegistry, env: {} },
      capabilityTrust: entries,
    });
    const routedNoPreference = evaluatePersonalExecutionModel(
      composedNoPreference.pem,
      { requestId: 'req-pem-tiebreak-3', declared: { fileType: 'js' } },
      { capabilityTrust: entries, toolRegistry, env: {} },
    );
    assert.equal(routedNoPreference.decision.chosenCapabilityId, 'cap-a'); // falls through to lexicographic
  });

  it('7. composePersonalExecutionModel writes to no storage and transitively calls no llmAdapter.js', () => {
    const result = checkDeterministicPath({ entryPoints: ['lib/experience/personal-execution-model.js'] });
    assert.equal(result.ok, true, JSON.stringify(result.violations));
    assert.deepEqual(result.violations, []);

    // Also covered by the repo-wide declared entry points (workflow-agent.js
    // + this file), which the standalone check:deterministic-path run uses.
    const full = checkDeterministicPath();
    assert.equal(full.ok, true, JSON.stringify(full.violations));
  });
});
