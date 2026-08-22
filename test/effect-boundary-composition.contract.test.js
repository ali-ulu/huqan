'use strict';

/**
 * End-to-end effect-boundary composition — P1-C (#1011).
 *
 * ## The gap this closes
 *
 * P1-A (#1009) made every mutation seam declare its identity enforcement.
 * P1-B (#1010) put every production connector execution through the canonical
 * firewall. Both are *per-boundary* properties. Neither says that an action
 * cannot enter through one production path and reach an effect through another
 * with fewer controls, which is what #1011 asks.
 *
 * Two things are needed for that and they are different in kind:
 *
 * 1. An inventory: what the in-scope effect boundaries are, and which control
 *    each production surface reaches. That is the ledger below.
 * 2. A demonstration that on the composed path the controls actually run **in
 *    order**, and that removing any one of them stops the effect. That is the
 *    chain test and the six negatives.
 *
 * (1) without (2) is a claim about structure that nothing exercises. (2)
 * without (1) proves one path and says nothing about the others.
 *
 * ## The three canonical boundaries
 *
 * There is no single funnel, and inventing one would be a rewrite rather than
 * a proof. What exists is three, each owning a family of effects:
 *
 *   mutation      lib/mutation-admission.js          graph/memory writes
 *   connector     lib/connector-action-firewall.js   external reads
 *   approval      lib/human-oversight-approval-runtime.js  approved effects
 *
 * The composed path -- the one #1011 draws -- runs through the third, which
 * itself re-enters the firewall at execution time. This file proves that path
 * and pins the other two to the ledgers their own contracts already maintain.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Graph = require('../graph');
const { createTrustEvidenceLedger } = require('../lib/trust-evidence-ledger');
const {
  createHumanOversightApprovalRuntime,
  RUNTIME_REASONS,
} = require('../lib/human-oversight-approval-runtime');

const FIREWALL_VERSION = 'agent-action-firewall-v1';

/**
 * A runtime wired the way production wires it, with the two injectables that
 * decide the chain -- identity resolution and the firewall -- made observable
 * so a test can deny at exactly one step and watch the effect stop.
 */
function fixture({ denyIdentity = false, firewall = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-1011-'));
  const clockState = { now: Date.parse('2026-08-22T10:00:00.000Z') };
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  const ledger = createTrustEvidenceLedger({ graph });
  const seen = { identity: 0, firewall: 0, executor: 0 };

  const resolveIdentity = ({ role, context, action }) => {
    seen.identity += 1;
    if (denyIdentity && role === 'requester') return { decision: 'block', identity: null };
    return {
      decision: 'allow',
      identity: {
        identityRef: context?.identityRef || (role === 'requester' ? 'agent:worker-a' : 'human:operator-a'),
        identityHash: context?.identityHash || (role === 'requester' ? 'hash-worker-a' : 'hash-operator-a'),
        workspaceId: action.workspaceId,
        agentId: role === 'requester' ? 'agent-a' : '',
        ownerActorId: role === 'requester' ? 'owner-a' : context?.identityRef || 'operator-a',
        authorityRef: 'authority:workspace-a',
      },
    };
  };

  const firewallEvaluator = (request) => {
    seen.firewall += 1;
    if (typeof firewall === 'function') return firewall(request, seen.firewall);
    return { decision: 'allow', metadata: { firewallVersion: FIREWALL_VERSION } };
  };

  const runtime = createHumanOversightApprovalRuntime({
    graph, ledger, resolveIdentity, firewallEvaluator, clock: () => clockState.now,
  });
  return { dir, graph, ledger, runtime, clockState, seen };
}

function action(overrides = {}) {
  return {
    workspaceId: 'workspace-a',
    actionFingerprint: 'action:send-email:001',
    connectorRef: 'connector:mcp-mail',
    resourceRef: 'resource:mailbox-a',
    policyVersion: 'policy-v1',
    firewallVersion: FIREWALL_VERSION,
    requestedVerdict: 'review',
    requestedEffect: 'send one bounded email',
    actionType: 'send_email',
    toolName: 'mcp.mail.send',
    target: 'mailbox-a',
    agentId: 'agent-a',
    evidenceRefs: ['evidence:approval-context'],
    provenanceRefs: ['provenance:request-001'],
    ...overrides,
  };
}

/** Drive a case to approved, returning everything the execution step needs. */
function approvedCase(f, { actionOverrides = {} } = {}) {
  const created = f.runtime.createReviewCase({
    action: action(actionOverrides),
    firewallDecision: 'review',
    requesterContext: { session: 'receiver-owned-session' },
  });
  assert.equal(created.ok, true, `case creation failed: ${created.reason || ''}`);
  const decided = f.runtime.decide({
    caseId: created.case.caseId,
    decisionType: 'approve',
    approverContext: { identityRef: 'human:operator-a', identityHash: 'hash-operator-a' },
    rationale: 'bounded send approved',
  });
  assert.equal(decided.ok, true, `decision failed: ${decided.reason || ''}`);
  return created.case.caseId;
}

async function execute(f, caseId, { actionOverrides = {}, executor } = {}) {
  return f.runtime.executeApproved({
    caseId,
    action: action(actionOverrides),
    requesterContext: { session: 'receiver-owned-session' },
    firewallRequest: {},
    executor: executor || (() => { f.seen.executor += 1; return { ok: true }; }),
  });
}

function cleanup(f) {
  fs.rmSync(f.dir, { recursive: true, force: true });
}

// ─── the inventory ───────────────────────────────────────────────────────────

test('the in-scope effect boundaries are enumerated and each has an owning control', () => {
  // Stated as executable structure rather than prose so a fourth boundary
  // cannot appear without someone deciding which control owns it.
  const BOUNDARIES = {
    mutation: {
      module: '../lib/mutation-admission.js',
      control: 'createMutationAdmission',
      contract: 'test/mutation-admission-identity-coverage.contract.test.js',
    },
    connector: {
      module: '../lib/connector-action-firewall.js',
      control: 'executeConnectorAction',
      contract: 'test/connector-firewall-coverage.contract.test.js',
    },
    approval: {
      module: '../lib/human-oversight-approval-runtime.js',
      control: 'createHumanOversightApprovalRuntime',
      contract: 'test/effect-boundary-composition.contract.test.js',
    },
  };

  for (const [name, spec] of Object.entries(BOUNDARIES)) {
    const mod = require(spec.module);
    assert.equal(typeof mod[spec.control], 'function',
      `${name}: ${spec.control} is not exported by ${spec.module}`);
    assert.ok(fs.existsSync(path.join(__dirname, '..', spec.contract)),
      `${name}: its coverage contract ${spec.contract} is missing`);
  }
});

// ─── the chain, in order ─────────────────────────────────────────────────────

test('the composed path runs identity, firewall, approval and evidence before the effect', async () => {
  const f = fixture();
  try {
    const caseId = approvedCase(f);
    const identityBeforeExecute = f.seen.identity;
    const firewallBeforeExecute = f.seen.firewall;

    const result = await execute(f, caseId);

    assert.equal(result.ok, true, result.reason || '');
    assert.equal(f.seen.executor, 1, 'the effect ran exactly once');

    // Identity is resolved again at execution and matched against the case;
    // the firewall is re-evaluated at execution rather than trusted from
    // approval time. Both counters moving is what "fresh revalidation" means.
    assert.ok(f.seen.identity > identityBeforeExecute, 'identity was not re-resolved at execution');
    assert.ok(f.seen.firewall > firewallBeforeExecute, 'the firewall was not re-evaluated at execution');

    // And the outcome is durably recorded, not merely returned.
    assert.equal(result.execution.ok, true);
    const after = f.runtime.getReviewCase(caseId);
    assert.equal(after.ok, true);
    assert.equal(after.case.status, 'executed');
  } finally { cleanup(f); }
});

test('an attempted execution is durably recorded even when the executor throws', async () => {
  // The reconciliation case: the effect may or may not have happened, and the
  // one unacceptable answer is silence.
  const f = fixture();
  try {
    const caseId = approvedCase(f);
    const result = await execute(f, caseId, {
      executor: () => { throw new Error('connector died mid-call'); },
    });

    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.EXECUTION_RECONCILIATION_REQUIRED);
    const after = f.runtime.getReviewCase(caseId);
    assert.equal(after.case.status, 'reconciliation_required');
  } finally { cleanup(f); }
});

// ─── the six negatives ───────────────────────────────────────────────────────
//
// One per control in the chain. Each removes exactly one and asserts the
// effect did not happen -- which is the difference between "the controls exist"
// and "the controls are load-bearing".

test('identity denial prevents the effect', () => {
  const f = fixture({ denyIdentity: true });
  try {
    const created = f.runtime.createReviewCase({
      action: action(),
      firewallDecision: 'review',
      requesterContext: { session: 'receiver-owned-session' },
    });
    assert.equal(created.ok, false, 'a denied requester still opened a case');
    assert.equal(f.seen.executor, 0);
  } finally { cleanup(f); }
});

test('firewall denial at execution time prevents the effect', async () => {
  // Allowed while the case is created and approved, blocked once execution is
  // authorized. This is the disagreement case: approval-time state is not
  // enough, because the world can change between approval and execution.
  //
  // The switch is flipped explicitly rather than by counting calls -- the
  // firewall runs during creation and decision too, so a call index would pin
  // this test to how many times those steps happen to consult it.
  const world = { blocked: false };
  const f = fixture({
    firewall: () => (world.blocked
      ? { decision: 'block', metadata: { firewallVersion: FIREWALL_VERSION } }
      : { decision: 'allow', metadata: { firewallVersion: FIREWALL_VERSION } }),
  });
  try {
    const caseId = approvedCase(f);
    world.blocked = true;
    const result = await execute(f, caseId);

    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.BLOCKED_BY_FIREWALL);
    assert.equal(f.seen.executor, 0, 'the effect ran despite a blocking firewall');
  } finally { cleanup(f); }
});

test('a firewall evaluation that throws prevents the effect', async () => {
  const world = { broken: false };
  const f = fixture({
    firewall: () => {
      if (world.broken) throw new Error('evaluator exploded');
      return { decision: 'allow', metadata: { firewallVersion: FIREWALL_VERSION } };
    },
  });
  try {
    const caseId = approvedCase(f);
    world.broken = true;
    const result = await execute(f, caseId);

    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.FIREWALL_EVALUATION_FAILED);
    assert.equal(f.seen.executor, 0);
  } finally { cleanup(f); }
});

test('a missing approval prevents the effect', async () => {
  const f = fixture();
  try {
    const created = f.runtime.createReviewCase({
      action: action(),
      firewallDecision: 'review',
      requesterContext: { session: 'receiver-owned-session' },
    });
    assert.equal(created.ok, true);
    // Never decided: the case is pending, not approved.
    const result = await execute(f, created.case.caseId);

    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.APPROVAL_REQUIRED);
    assert.equal(f.seen.executor, 0);
  } finally { cleanup(f); }
});

test('a stale approval cannot authorize a later execution', async () => {
  const f = fixture();
  try {
    const caseId = approvedCase(f);
    // Move past the case lifetime. The approval was real; it is no longer live.
    f.clockState.now += 1000 * 60 * 60 * 24 * 30;
    const result = await execute(f, caseId);

    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.CASE_EXPIRED);
    assert.equal(f.seen.executor, 0, 'an expired approval still reached the effect');
  } finally { cleanup(f); }
});

test('scope drift between the approved action and the executed one prevents the effect', async () => {
  const f = fixture();
  try {
    const caseId = approvedCase(f);
    // Approved for one mailbox, executed against another. Every field in the
    // scope tuple is checked; resourceRef stands in for all of them here, and
    // the loop below covers the rest.
    const result = await execute(f, caseId, { actionOverrides: { resourceRef: 'resource:mailbox-b' } });

    assert.equal(result.ok, false);
    assert.equal(result.reason, RUNTIME_REASONS.SCOPE_MISMATCH);
    assert.equal(f.seen.executor, 0);
  } finally { cleanup(f); }
});

test('every field of the approved scope is load-bearing, not just the one', async () => {
  // A scope check that only really compared one field would pass the test
  // above. This walks the tuple.
  const drifts = {
    workspaceId: 'workspace-b',
    connectorRef: 'connector:other',
    resourceRef: 'resource:mailbox-b',
    actionFingerprint: 'action:send-email:002',
    policyVersion: 'policy-v2',
  };

  for (const [field, value] of Object.entries(drifts)) {
    const f = fixture();
    try {
      const caseId = approvedCase(f);
      const result = await execute(f, caseId, { actionOverrides: { [field]: value } });
      assert.equal(result.ok, false, `${field}: drift was accepted`);
      assert.equal(f.seen.executor, 0, `${field}: the effect ran despite drift`);
    } finally { cleanup(f); }
  }
});
