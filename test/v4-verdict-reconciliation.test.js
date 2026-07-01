'use strict';
/**
 * V4-PR2 — Unified Verdict Reconciliation + Schema.
 *
 * Proves that lib/verdict/action-verdict.js correctly and deterministically
 * projects every existing gate decision onto the single canonical verdict set,
 * without changing what either gate actually decides, and without introducing
 * a fourth vocabulary (`require_approval` stays a UI label, never a runtime
 * verdict value).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CANONICAL_VERDICTS,
  ADMISSION_TO_CANONICAL,
  MCP_TO_CANONICAL,
  UnknownVerdictSourceError,
  toCanonicalVerdict,
  fromAdmissionDecision,
  fromMcpDecision,
  classifyForUi,
  serializeVerdict,
  parseVerdict,
} = require('../lib/verdict/action-verdict');

const { evaluateMemoryAdmission } = require('../lib/memory-admission-gate');
const { evaluateMcpGate } = require('../lib/mcp-gate-adapter');

// ---------------------------------------------------------------------------
// 1 & 2. Every legacy decision value resolves deterministically (unit level).
// ---------------------------------------------------------------------------

describe('V4-PR2: canonical verdict set and no fourth vocabulary', () => {
  it('canonical verdict set matches the reconciled target vocabulary exactly', () => {
    assert.deepStrictEqual(
      [...CANONICAL_VERDICTS].sort(),
      ['allow', 'block', 'disabled', 'dry_run_only', 'quarantine', 'review'].sort()
    );
  });

  it('require_approval is NOT a canonical runtime verdict', () => {
    assert.ok(!CANONICAL_VERDICTS.includes('require_approval'),
      'require_approval must never be added to CANONICAL_VERDICTS (docs/v4/verdict-reconciliation.md Option A)');
  });

  it('every admission-gate decision value maps to its documented canonical verdict', () => {
    const expected = { allow: 'allow', review: 'review', reject: 'block', quarantine: 'quarantine' };
    assert.deepStrictEqual(ADMISSION_TO_CANONICAL, expected);
    for (const [source, canonical] of Object.entries(expected)) {
      assert.strictEqual(toCanonicalVerdict('admission', source), canonical);
    }
  });

  it('every MCP-gate decision value maps to its documented canonical verdict', () => {
    const expected = { allow: 'allow', review: 'review', block: 'block', dry_run_only: 'dry_run_only', disabled: 'disabled' };
    assert.deepStrictEqual(MCP_TO_CANONICAL, expected);
    for (const [source, canonical] of Object.entries(expected)) {
      assert.strictEqual(toCanonicalVerdict('mcp', source), canonical);
    }
  });

  it('an unrecognized decision value fails closed (throws), never silently resolves to allow', () => {
    assert.throws(() => toCanonicalVerdict('admission', 'totally-made-up-decision'), UnknownVerdictSourceError);
    assert.throws(() => toCanonicalVerdict('mcp', 'totally-made-up-decision'), UnknownVerdictSourceError);
    assert.throws(() => toCanonicalVerdict('unknown-layer', 'allow'), UnknownVerdictSourceError);
  });
});

// ---------------------------------------------------------------------------
// 3. Schema round-trip: serialize/parse without loss for every canonical value.
// ---------------------------------------------------------------------------

describe('V4-PR2: schema round-trip', () => {
  for (const verdict of CANONICAL_VERDICTS) {
    it(`round-trips a "${verdict}" envelope through serializeVerdict/parseVerdict without loss`, () => {
      const envelope = {
        verdict,
        sourceLayer: 'mcp',
        sourceDecision: 'fixture-source',
        reason: 'fixture reason',
        risk: { level: 'low', score: 0 },
        actor: 'fixture-actor',
        workspaceId: 'fixture-workspace',
        receiptId: 'fixture-receipt-id',
        metadata: { fixture: true },
      };
      const serialized = serializeVerdict(envelope);
      const parsed = parseVerdict(serialized);
      assert.strictEqual(parsed.verdict, verdict);
      assert.deepStrictEqual(JSON.parse(JSON.stringify(parsed)), serialized);
    });
  }

  it('parseVerdict rejects a payload with an unknown verdict value', () => {
    assert.throws(() => parseVerdict({ verdict: 'not-a-real-verdict', sourceLayer: 'mcp', sourceDecision: 'x' }),
      UnknownVerdictSourceError);
  });
});

// ---------------------------------------------------------------------------
// 4. End-to-end: real gate decisions, unmodified, projected onto canonical.
// ---------------------------------------------------------------------------

describe('V4-PR2: real admission-gate decisions project correctly (no gate behavior change)', () => {
  // buildMemoryAdmissionRequest requires memoryDraftId, trustPolicyVersion,
  // and reason (verified against lib/memory-admission-gate.js validation).
  const baseInput = {
    workspaceId: 'default',
    actor: 'tester',
    agentId: 'tester',
    memoryDraftId: 'draft-fixture',
    trustPolicyVersion: '1.0.0',
    reason: 'v4-pr2-fixture',
  };

  it('a low-risk, provenance-present request resolves to canonical "allow"', () => {
    const result = evaluateMemoryAdmission({
      ...baseInput,
      provenanceId: 'prov-1',
      proposedMemory: { content: 'fact', edges: [] },
    });
    assert.strictEqual(result.decision.decision, 'allow');
    const envelope = fromAdmissionDecision(result.decision);
    assert.strictEqual(envelope.verdict, 'allow');
    assert.strictEqual(envelope.sourceLayer, 'admission');
    assert.strictEqual(envelope.sourceDecision, 'allow');
  });

  it('an approval-required, unapproved request resolves to canonical "review"', () => {
    const result = evaluateMemoryAdmission({
      ...baseInput,
      provenanceId: 'prov-2',
      approvalRequired: true,
      proposedMemory: { content: 'fact', edges: [] },
    });
    assert.strictEqual(result.decision.decision, 'review');
    const envelope = fromAdmissionDecision(result.decision);
    assert.strictEqual(envelope.verdict, 'review');
  });

  it('a rejected-approval request resolves to canonical "block"', () => {
    const result = evaluateMemoryAdmission({
      ...baseInput,
      provenanceId: 'prov-3',
      approvalStatus: 'rejected',
      proposedMemory: { content: 'fact', edges: [] },
    });
    assert.strictEqual(result.decision.decision, 'reject');
    const envelope = fromAdmissionDecision(result.decision);
    assert.strictEqual(envelope.verdict, 'block',
      'a rejected admission decision must never surface as allow — it must project to block');
  });

  it('a tombstone/quarantine-signal request resolves to canonical "quarantine"', () => {
    const result = evaluateMemoryAdmission({
      ...baseInput,
      provenanceId: 'prov-4',
      proposedMemory: { content: 'fact', edges: [], tombstone: true },
    });
    assert.strictEqual(result.decision.decision, 'quarantine');
    const envelope = fromAdmissionDecision(result.decision);
    assert.strictEqual(envelope.verdict, 'quarantine');
  });
});

describe('V4-PR2: real MCP-gate decisions project correctly (no gate behavior change)', () => {
  it('axiom.ask (read-only) resolves to canonical "allow"', () => {
    const result = evaluateMcpGate({ tool: 'axiom.ask', args: { question: 'x' }, metadata: {} });
    assert.strictEqual(result.decision, 'allow');
    const envelope = fromMcpDecision(result);
    assert.strictEqual(envelope.verdict, 'allow');
    assert.strictEqual(envelope.sourceLayer, 'mcp');
  });

  it('axiom.learn (mutating write) resolves to canonical "review"', () => {
    const result = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'x' }, metadata: {} });
    assert.strictEqual(result.decision, 'review');
    const envelope = fromMcpDecision(result);
    assert.strictEqual(envelope.verdict, 'review');
  });

  it('axiom.agent (agent-loop) resolves to canonical "dry_run_only"', () => {
    const result = evaluateMcpGate({ tool: 'axiom.agent', args: { goal: 'x' }, metadata: {} });
    assert.strictEqual(result.decision, 'dry_run_only');
    const envelope = fromMcpDecision(result);
    assert.strictEqual(envelope.verdict, 'dry_run_only');
  });

  it('an unknown tool resolves to canonical "block"', () => {
    const result = evaluateMcpGate({ tool: 'axiom.definitely-not-a-real-tool', args: {}, metadata: {} });
    assert.strictEqual(result.decision, 'block');
    const envelope = fromMcpDecision(result);
    assert.strictEqual(envelope.verdict, 'block');
  });

  // The MCP gate's 'disabled' decision is a defined-but-not-yet-produced state
  // in evaluateMcpGate today (reserved for a future capability-availability
  // path). It is tested at the mapping level, not end-to-end, since no real
  // input currently triggers it.
  it('mcp "disabled" (not yet producible end-to-end) still maps correctly at the object level', () => {
    const fabricatedDisabledDecision = {
      ok: true,
      decision: 'disabled',
      reason: 'capability_unavailable',
      risk: { level: 'low', score: 0 },
      metadata: { adapterVersion: 'test-fixture' },
    };
    const envelope = fromMcpDecision(fabricatedDisabledDecision);
    assert.strictEqual(envelope.verdict, 'disabled');
  });
});

// ---------------------------------------------------------------------------
// 5. require_approval is UI classification only, never a runtime decision.
// ---------------------------------------------------------------------------

describe('V4-PR2: require_approval stays UI copy, not a runtime verdict', () => {
  it('classifyForUi labels a "review" verdict as require_approval for display purposes only', () => {
    const result = evaluateMcpGate({ tool: 'axiom.learn', args: { text: 'x' }, metadata: {} });
    const envelope = fromMcpDecision(result);
    assert.strictEqual(envelope.verdict, 'review', 'the runtime verdict itself must remain "review"');
    assert.strictEqual(classifyForUi(envelope), 'require_approval', 'only the UI classification becomes require_approval');
  });

  it('classifyForUi passes through every other canonical verdict unchanged', () => {
    for (const verdict of CANONICAL_VERDICTS) {
      if (verdict === 'review') continue;
      const envelope = { verdict, sourceLayer: 'mcp', sourceDecision: verdict };
      assert.strictEqual(classifyForUi(envelope), verdict);
    }
  });
});
