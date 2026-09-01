'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  AGENT_IDENTITY_CARD_SCHEMA_VERSION,
  IDENTITY_REASONS,
  UNATTESTED_OWNER,
  computeIdentityCardHash,
  normalizeAgentIdentityCard,
} = require('../lib/external-action-identity');
const {
  evaluateExternalAction,
  recordExternalActionOutcome,
} = require('../lib/external-action-guard');
const { queryExternalActionsByIdentity } = require('../lib/external-action-identity-log');

const ISSUED_AT = '2026-01-01T00:00:00.000Z';
// AB1 reviews any path outside the workspace allowlist, so the fixtures use an
// absolute in-workspace target: these tests are about identity, not path risk.
const WORKSPACE_ROOT = process.cwd();
const IN_WORKSPACE_FILE = path.join(WORKSPACE_ROOT, 'README.md');

function card(overrides = {}) {
  return {
    schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION,
    agentId: 'future-agent-2035',
    agentName: 'future-agent-2035',
    agentVersion: '1.4.0',
    ownerActorId: 'actor:ali',
    workspaceId: 'default',
    capabilities: ['file_read', 'shell'],
    issuedAt: ISSUED_AT,
    ...overrides,
  };
}

function invocation(overrides = {}) {
  return {
    invocationId: 'inv-1',
    agentName: 'future-agent-2035',
    sessionId: 'session-1',
    turnId: 'turn-1',
    toolName: 'Read',
    args: { file_path: IN_WORKSPACE_FILE },
    cwd: WORKSPACE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    workspaceId: 'default',
    ...overrides,
  };
}

function identityFinding(result) {
  return result.findings.find(finding => finding.gate === 'identity');
}

// --- criterion 1: the capability card schema -------------------------------

test('a well-formed capability card normalizes with a self-terminating delegation chain', () => {
  const { card: normalized, errors } = normalizeAgentIdentityCard(card());
  assert.deepEqual(errors, []);
  assert.equal(normalized.ownerActorId, 'actor:ali');
  assert.equal(normalized.onBehalfOf, 'actor:ali', 'onBehalfOf defaults to the owning principal');
  assert.deepEqual(normalized.delegationChain, ['future-agent-2035']);
  assert.equal(normalized.expiresAt, null);
});

test('card rejection is explicit and never yields a partially trusted card', () => {
  const cases = [
    [card({ schemaVersion: 'huqan.agent-identity-card.v99' }), 'identity_card_schema_version_invalid'],
    [card({ ownerActorId: '   ' }), 'identity_card_owner_actor_id_missing'],
    [card({ capabilities: [] }), 'identity_card_capabilities_invalid'],
    [card({ capabilities: ['telepathy'] }), 'identity_card_capability_unknown'],
    [card({ delegationChain: ['orchestrator'] }), 'identity_card_delegation_chain_not_terminal'],
    [card({ issuedAt: 'yesterday' }), 'identity_card_issued_at_invalid'],
    [card({ expiresAt: ISSUED_AT }), 'identity_card_expires_before_issued'],
  ];
  for (const [input, expected] of cases) {
    const { card: normalized, errors } = normalizeAgentIdentityCard(input);
    assert.equal(normalized, null, `${expected} must not produce a card`);
    assert.ok(errors.includes(expected), `expected ${expected} in ${JSON.stringify(errors)}`);
  }
});

test('the identity hash covers authority, not invocation context', () => {
  const { card: a } = normalizeAgentIdentityCard(card());
  const { card: b } = normalizeAgentIdentityCard(card());
  const { card: escalated } = normalizeAgentIdentityCard(card({ capabilities: ['file_read', 'shell', 'deployment'] }));
  assert.equal(computeIdentityCardHash(a), computeIdentityCardHash(b));
  assert.notEqual(computeIdentityCardHash(a), computeIdentityCardHash(escalated));
});

// --- criterion 2: identity reaches the gate decision and the receipt --------

test('an attested card is written to the gate decision and to the receipt', () => {
  const result = evaluateExternalAction({ ...invocation(), identity: card() });
  assert.equal(result.decision, 'allow');

  const finding = identityFinding(result);
  assert.equal(finding.decision, 'allow');
  assert.equal(finding.reason, IDENTITY_REASONS.ATTESTED);
  assert.equal(finding.attested, true);

  const identity = result.receipt.metadata.identity;
  assert.equal(identity.attested, true);
  assert.equal(identity.identityRef, 'agent:default:future-agent-2035');
  assert.equal(identity.ownerActorId, 'actor:ali');
  assert.equal(identity.onBehalfOf, 'actor:ali');
  assert.equal(identity.sessionId, 'session-1');
  assert.equal(identity.turnId, 'turn-1');
  assert.match(identity.identityHash, /^[a-f0-9]{64}$/);
  assert.equal(result.receipt.agentId, 'future-agent-2035');
  assert.match(result.receipt.receiptHash, /^[a-f0-9]{64}$/, 'identity is inside the hashed payload');
});

test('an action with no card is still attributed, marked unattested', () => {
  const result = evaluateExternalAction(invocation());
  assert.equal(result.decision, 'allow', 'absent card stays allow until a deployment opts in');
  const identity = result.receipt.metadata.identity;
  assert.equal(identity.attested, false);
  assert.equal(identity.ownerActorId, UNATTESTED_OWNER);
  assert.equal(identityFinding(result).reason, IDENTITY_REASONS.UNATTESTED);
});

test('requireIdentityCard escalates an unattested action', () => {
  const blocked = evaluateExternalAction(invocation(), { requireIdentityCard: true });
  assert.equal(blocked.decision, 'block');
  assert.equal(identityFinding(blocked).reason, IDENTITY_REASONS.CARD_REQUIRED);

  const review = evaluateExternalAction(invocation(), { requireIdentityCard: 'review' });
  assert.equal(review.decision, 'review');

  const viaEnv = evaluateExternalAction(invocation(), {
    environment: { HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: '1' },
  });
  assert.equal(viaEnv.decision, 'block');
});

test('card enforcement is fail-closed on every mismatch', () => {
  const cases = [
    [{ identity: { schemaVersion: AGENT_IDENTITY_CARD_SCHEMA_VERSION } }, IDENTITY_REASONS.CARD_INVALID],
    [{ identity: card({ workspaceId: 'other' }) }, IDENTITY_REASONS.WORKSPACE_MISMATCH],
    [{ identity: card({ agentName: 'someone-else' }) }, IDENTITY_REASONS.AGENT_MISMATCH],
    [{ identity: card({ issuedAt: '2099-01-01T00:00:00.000Z' }) }, IDENTITY_REASONS.NOT_YET_VALID],
    [
      { identity: card({ expiresAt: '2026-01-02T00:00:00.000Z' }) },
      IDENTITY_REASONS.EXPIRED,
    ],
  ];
  for (const [overrides, expected] of cases) {
    const result = evaluateExternalAction({ ...invocation(), ...overrides });
    assert.equal(result.decision, 'block', expected);
    assert.equal(identityFinding(result).reason, expected);
    assert.equal(result.receipt.metadata.identity.attested, expected !== IDENTITY_REASONS.CARD_INVALID
      ? true
      : false);
  }
});

test('a capability the card does not grant is blocked even when the action itself is benign', () => {
  const result = evaluateExternalAction({
    ...invocation({ toolName: 'Write', args: { file_path: path.join(WORKSPACE_ROOT, 'notes.md'), content: 'x' } }),
    identity: card({ capabilities: ['file_read'] }),
  });
  assert.equal(result.decision, 'block');
  const finding = identityFinding(result);
  assert.equal(finding.reason, IDENTITY_REASONS.CAPABILITY_NOT_GRANTED);
  assert.equal(finding.capability, 'file_write');
});

test('the wildcard capability grants every action kind', () => {
  const result = evaluateExternalAction({
    ...invocation(),
    identity: card({ capabilities: ['*'] }),
  });
  assert.equal(identityFinding(result).decision, 'allow');
});

test('an outcome receipt inherits the admission identity and cannot re-attribute it', () => {
  const admission = evaluateExternalAction({ ...invocation(), identity: card() });
  const outcome = recordExternalActionOutcome(
    { ...invocation({ agentName: 'future-agent-2035' }) },
    admission.receipt,
    { status: 'success', output: 'ok' },
  );
  assert.equal(outcome.receipt.metadata.identity.identityRef, 'agent:default:future-agent-2035');
  assert.equal(outcome.receipt.metadata.identity.attested, true);
  assert.equal(outcome.receipt.agentId, 'future-agent-2035');
});

test('a malformed envelope still records who submitted it', () => {
  const result = evaluateExternalAction({ toolName: 'Bash', agentName: 'drifting-agent' });
  assert.equal(result.decision, 'block');
  assert.equal(result.reason, 'malformed_external_action_blocked');
  assert.equal(result.receipt.metadata.identity.agentName, 'drifting-agent');
  assert.ok(identityFinding(result), 'the identity gate runs before the envelope check');
});

// --- criterion 3: query every action of one identity -----------------------

test('the receipt trail answers "what has this identity done?"', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-identity-log-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const receiptLog = path.join(dir, 'receipts.jsonl');
  const writer = { append: receipt => fs.appendFileSync(receiptLog, `${JSON.stringify(receipt)}\n`) };

  evaluateExternalAction({ ...invocation({ invocationId: 'a' }), identity: card() }, { receiptWriter: writer });
  evaluateExternalAction(
    { ...invocation({ invocationId: 'b', toolName: 'Write', args: { file_path: path.join(WORKSPACE_ROOT, 'x.md') } }), identity: card({ capabilities: ['file_read'] }) },
    { receiptWriter: writer },
  );
  evaluateExternalAction(
    { ...invocation({ invocationId: 'c', agentName: 'other-agent' }), identity: card({ agentId: 'other-agent', agentName: 'other-agent' }) },
    { receiptWriter: writer },
  );
  fs.appendFileSync(receiptLog, 'not json\n');

  const mine = queryExternalActionsByIdentity({ path: receiptLog, identityRef: 'agent:default:future-agent-2035' });
  assert.equal(mine.matched, 2);
  assert.equal(mine.skippedLines, 1, 'a corrupt line is skipped, not fatal');
  assert.deepEqual(mine.actions.map(action => action.invocationId), ['a', 'b']);
  assert.deepEqual(mine.summary.byDecision, { allow: 1, block: 1 });
  assert.deepEqual(mine.summary.identityRefs, ['agent:default:future-agent-2035']);
  assert.equal(mine.summary.attested, 2);

  const byOwner = queryExternalActionsByIdentity({ path: receiptLog, ownerActorId: 'actor:ali' });
  assert.equal(byOwner.matched, 3, 'one principal, three delegated actions across two agents');

  const blocked = queryExternalActionsByIdentity({ path: receiptLog, agentId: 'future-agent-2035', decision: 'block' });
  assert.deepEqual(blocked.actions.map(action => action.invocationId), ['b']);

  const bounded = queryExternalActionsByIdentity({ path: receiptLog, ownerActorId: 'actor:ali', limit: 1 });
  assert.equal(bounded.actions.length, 1);
  assert.equal(bounded.truncated, true);
  assert.equal(bounded.summary.total, 3, 'the summary counts every match, not just the page');
});

test('a receipt written before identity persistence is reported as unattested legacy history', () => {
  const legacy = JSON.stringify({
    receiptId: 'xact_adm_legacy',
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    status: 'admitted',
    admissionId: 'legacy-1',
    workspaceId: 'default',
    actor: 'legacy-agent',
    agentId: 'legacy-agent',
    createdAt: '2025-12-31T00:00:00.000Z',
    metadata: { sessionId: 'old-session', toolName: 'Bash' },
  });
  const result = queryExternalActionsByIdentity({ lines: `${legacy}\n`, agentId: 'legacy-agent' });
  assert.equal(result.matched, 1);
  assert.equal(result.actions[0].identity.attested, false);
  assert.equal(result.actions[0].identity.legacy, true);
  assert.equal(result.actions[0].identity.identityRef, 'agent:default:legacy-agent');
});

test('a missing receipt log answers empty instead of throwing', () => {
  const result = queryExternalActionsByIdentity({
    path: path.join(os.tmpdir(), 'huqan-no-such-receipt-log.jsonl'),
    agentId: 'anyone',
  });
  assert.equal(result.matched, 0);
  assert.equal(result.summary.total, 0);
});
