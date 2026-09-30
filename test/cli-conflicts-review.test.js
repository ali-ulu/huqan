'use strict';

/**
 * The CLI conflict-candidate review flow (#3187).
 *
 * `lib/conflict-candidate-review.js` shipped with no production caller: a
 * person had no product path for accepting or rejecting a conflict candidate,
 * so a HIGH/CRITICAL-risk `block` (lib/claim-read.js) never cleared. This test
 * drives the whole loop end to end against a real Kernel/graph:
 *
 *   create candidate -> contested read -> review via the CLI -> the same
 *   target is re-read and is no longer served as contested.
 *
 * It also pins the refusals the issue names: wrong workspace, unknown candidate
 * id, invalid decision, and a missing reviewer (which this command requires, so
 * "who may decide" is never an open question).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const Kernel = require('../kernel');
const CLI = require('../cli');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { routeCandidateClaim } = require('../lib/conflict-detector');
const { readClaim } = require('../lib/claim-read');
const { READ_BEHAVIORS } = require('../lib/contested-read-policy');
const { parseCommand } = require('../lib/command-parser');

const WORKSPACE = 'workspace-a';

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-edge-001',
    sourceRef: 'docs/claims.md#1',
    sourceTitle: 'Claims',
    sourceType: 'document',
    actor: 'builder',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.91,
    workspaceId: WORKSPACE,
    trustPolicyVersion: '0.8.0',
    ...overrides,
  };
}

/** A real contested state via a real Kernel, mirroring lib/claim-read.test.js. */
function buildContestedKernel(label) {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const edgeProvenance = makeProvenance();
  kernel.graph.addNode('fire', 'fire', edgeProvenance, { workspaceId: WORKSPACE });
  kernel.graph.addNode('smoke', 'smoke', edgeProvenance, { workspaceId: WORKSPACE });
  kernel.graph.addEdge('fire', 'smoke', 'CAUSES', {
    workspaceId: WORKSPACE,
    provenance: edgeProvenance,
    strength: 0.9,
    confidence: 0.88,
    source: 'manual',
    sourceRef: edgeProvenance.sourceRef,
    evidence: ['fire causes smoke'],
  });

  const admissionOwner = kernel.kernel || kernel;
  const routed = routeCandidateClaim(kernel, {
    claim: 'fire prevents smoke',
    subject: 'fire',
    relation: 'PREVENTS',
    object: 'smoke',
    provenance: makeProvenance({ provenanceId: 'prov-challenge-001', sourceRef: 'docs/claims.md#2' }),
  }, { workspaceId: WORKSPACE }, {
    evaluateLearnAdmission: (text, admissionOpts, provenance, workspaceId) =>
      admissionOwner._evaluateLearnAdmission(text, admissionOpts, provenance, workspaceId),
  });

  assert.strictEqual(routed.conflict.conflict, true, 'setup: candidate must actually conflict');
  assert.strictEqual(routed.candidate.status, 'pending', 'setup: candidate must be unreviewed');
  return { kernel, candidateId: routed.candidate.candidateId };
}

const HIGH_RISK_INTENT = { category: 'CANONICAL_GRAPH_WRITE' };

function runCli(cli, command) {
  const parsed = cli.parse(command);
  return cli.execute(parsed.command, parsed.args, { gateResult: null });
}

test('conflicts review records a verdict through the CLI and clears the contested read', () => {
  const { kernel, candidateId } = buildContestedKernel('conflicts-e2e');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    const before = readClaim(kernel, { workspaceId: WORKSPACE, targetId: 'fire', intent: HIGH_RISK_INTENT });
    assert.strictEqual(before.kind, 'unsettled');
    assert.strictEqual(before.behavior, READ_BEHAVIORS.BLOCK);

    const output = runCli(cli, `conflicts review ${candidateId} --accept --reviewer ali --workspace ${WORKSPACE}`);
    assert.match(output, new RegExp(`Conflict review — ${candidateId}`));
    assert.match(output, /status: pending -> accepted/);
    assert.match(output, /reviewed by: ali/);
    assert.match(output, /Canonical graph unchanged/);

    const stored = kernel.getCandidateClaims({ workspaceId: WORKSPACE }).find(c => c.candidateId === candidateId);
    assert.strictEqual(stored.status, 'accepted');
    assert.strictEqual(stored.reviewedBy, 'ali');

    const after = readClaim(kernel, { workspaceId: WORKSPACE, targetId: 'fire', intent: HIGH_RISK_INTENT });
    assert.strictEqual(after.kind, 'settled');
    assert.strictEqual(after.value.targetId, 'fire');
  } finally {
    cli?.agent?.storage?.close?.();
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
  }
});

test('conflicts review rejects a candidate and the target is no longer contested', () => {
  const { kernel, candidateId } = buildContestedKernel('conflicts-reject');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    const output = runCli(cli, `conflicts review ${candidateId} --reject --reviewer ali --workspace ${WORKSPACE}`);
    assert.match(output, /status: pending -> rejected/);

    const after = readClaim(kernel, { workspaceId: WORKSPACE, targetId: 'fire', intent: HIGH_RISK_INTENT });
    assert.strictEqual(after.kind, 'settled');
  } finally {
    cli?.agent?.storage?.close?.();
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
  }
});

test('a wrong workspace is an explicit unknown-candidate error', () => {
  const { kernel, candidateId } = buildContestedKernel('conflicts-wrong-ws');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    assert.throws(
      () => runCli(cli, `conflicts review ${candidateId} --accept --reviewer ali --workspace other`),
      (error) => error.code === 'CONFLICT_REVIEW_UNKNOWN_CANDIDATE',
    );
  } finally {
    cli?.agent?.storage?.close?.();
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
  }
});

test('an unknown candidate id and an invalid decision fail with explicit errors', () => {
  const { kernel } = buildContestedKernel('conflicts-bad-input');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    assert.throws(
      () => runCli(cli, `conflicts review does-not-exist --accept --reviewer ali --workspace ${WORKSPACE}`),
      (error) => error.code === 'CONFLICT_REVIEW_UNKNOWN_CANDIDATE',
    );
    assert.throws(
      () => runCli(cli, `conflicts review some-id --maybe --reviewer ali --workspace ${WORKSPACE}`),
      (error) => error.code === 'CONFLICT_REVIEW_INVALID_DECISION',
    );
  } finally {
    cli?.agent?.storage?.close?.();
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
  }
});

test('a missing reviewer is refused before any verdict is written', () => {
  const { kernel, candidateId } = buildContestedKernel('conflicts-no-reviewer');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    assert.throws(
      () => runCli(cli, `conflicts review ${candidateId} --accept --workspace ${WORKSPACE}`),
      (error) => error.code === 'CONFLICT_REVIEW_REVIEWER_REQUIRED',
    );
    const stored = kernel.getCandidateClaims({ workspaceId: WORKSPACE }).find(c => c.candidateId === candidateId);
    assert.strictEqual(stored.status, 'pending', 'a refused review must not have written a verdict');
  } finally {
    cli?.agent?.storage?.close?.();
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
  }
});

test('the parser routes `conflicts review` to the conflicts command, and the bare word is not a command', () => {
  const parsed = parseCommand('conflicts review cand-1 --accept --reviewer ali --workspace ws-1');
  assert.strictEqual(parsed.command, 'conflicts');
  assert.strictEqual(parsed.args.candidateId, 'cand-1');
  assert.strictEqual(parsed.args.decision, 'accept');
  assert.strictEqual(parsed.args.reviewer, 'ali');
  assert.strictEqual(parsed.args.workspaceId, 'ws-1');

  // The Turkish spelling is accepted permanently (RFC-001 decision 7).
  assert.strictEqual(parseCommand('catismalar review cand-2 --reject --reviewer ali').command, 'conflicts');

  // A bare `conflicts` is not a report, so it must not resolve to the command
  // with review arguments silently absent.
  assert.notStrictEqual(parseCommand('conflicts').command, 'conflicts');
});

test('the parser refuses a flag-shaped operand and a contradictory decision', () => {
  // `--reviewer --accept` means the reviewer operand was omitted; `--accept`
  // must not be read as the reviewer's name (#3187 review).
  const missingOperand = parseCommand('conflicts review cand-1 --reviewer --accept --workspace ws-1');
  assert.strictEqual(missingOperand.args.reviewer, '');
  assert.strictEqual(missingOperand.args.decision, 'accept');

  // A `--workspace` with no operand must not silently become `default` by way
  // of `--reviewer`'s token.
  const workspaceMissing = parseCommand('conflicts review cand-1 --accept --reviewer ali --workspace');
  assert.strictEqual(workspaceMissing.args.workspaceId, 'default');

  // Both decision groups at once is ambiguous: the verdict is refused rather
  // than resolved in favour of accept.
  const contradictory = parseCommand('conflicts review cand-1 --accept --reject --reviewer ali');
  assert.strictEqual(contradictory.args.decision, '');
  const contradictoryTr = parseCommand('conflicts review cand-1 --kabul --ret --reviewer ali');
  assert.strictEqual(contradictoryTr.args.decision, '');
});

test('a missing reviewer and a contradictory decision are refused before any verdict is written', () => {
  const { kernel, candidateId } = buildContestedKernel('conflicts-bad-flags');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    assert.throws(
      () => runCli(cli, `conflicts review ${candidateId} --reviewer --accept --workspace ${WORKSPACE}`),
      err => err.code === 'CONFLICT_REVIEW_REVIEWER_REQUIRED',
    );
    assert.throws(
      () => runCli(cli, `conflicts review ${candidateId} --accept --reject --reviewer ali --workspace ${WORKSPACE}`),
      err => err.code === 'CONFLICT_REVIEW_INVALID_DECISION',
    );
    const stored = kernel.getCandidateClaims({ workspaceId: WORKSPACE }).find(item => item.candidateId === candidateId);
    assert.strictEqual(stored.status, 'pending', 'a refused command must leave the candidate unreviewed');
  } finally {
    cli?.agent?.storage?.close?.();
  }
});

test('the review is audited: the CLI gate records the conflict review, not the hypothesis one', () => {
  const { kernel, candidateId } = buildContestedKernel('conflicts-audit');
  const cli = new CLI({ kernelInstance: kernel });
  try {
    const gate = cli.evaluateCliGate('conflicts', { review: true, workspaceId: WORKSPACE });
    assert.strictEqual(gate.canExecute, true);
    assert.strictEqual(gate.metadata.mutationType, 'candidate_claim');

    const events = (kernel.graph._auditEvents || []);
    const reasons = events.map(event => event.details?.reason).filter(Boolean);
    assert.ok(
      reasons.includes('cli_conflict_candidate_review'),
      `the conflict review must be audited under its own reason; got ${JSON.stringify(reasons)}`,
    );
    assert.ok(!reasons.includes('cli_hypothesis_proposal'));
  } finally {
    cli?.agent?.storage?.close?.();
    kernel?.graph?.close?.();
    kernel?.memory?.close?.();
  }
});
