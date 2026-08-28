'use strict';

/**
 * The README's "How it works" section names the decisions this system can
 * reach. That list drifted: it advertised an `ESCALATE` gate outcome that no
 * gate returns, and omitted `quarantine` and `reject`, which the memory
 * admission gate does return — the word "quarantine" appeared nowhere in the
 * README at all.
 *
 * Escalation is real, but it lives one layer up: it is a decision a reviewer
 * makes at the approval boundary, not an answer the gate gives. That
 * distinction is the product's own architecture (multi-party control, present
 * for an organization, absent for a single user), so the README should state
 * it rather than flatten it into the gate's vocabulary.
 *
 * These tests read the constants and fail when the README claims an outcome
 * the code does not produce, or omits one it does.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { MCP_GATE_DECISIONS } = require('../lib/mcp-gate-adapter');
const { AGENT_ACTION_FIREWALL_DECISIONS } = require('../lib/agent-action-firewall');
const { DECISIONS: PR_GUARDIAN_DECISIONS } = require('../lib/pr-guardian/policy');
const { DECISION_TYPES, CASE_STATUSES } = require('../lib/human-oversight-approval-runtime-primitives');

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

/** The `ALLOW / REVIEW / …` line in the "How it works" block. */
function outcomeLine() {
  const line = README.split('\n').find(candidate => /^[A-Z][A-Z -]*( \/ [A-Z][A-Z -]*)+$/.test(candidate.trim()));
  assert.ok(line, 'the How it works block must list the decision outcomes');
  return line.trim();
}

test('the outcome line names no decision the gates cannot return', () => {
  const gateVocabulary = new Set([
    ...Object.values(MCP_GATE_DECISIONS),
    ...Object.values(AGENT_ACTION_FIREWALL_DECISIONS),
    ...Object.values(PR_GUARDIAN_DECISIONS),
    // lib/memory-admission-gate.js DECISION_SEVERITY
    'allow', 'review', 'quarantine', 'reject',
  ].map(decision => String(decision).toLowerCase()));

  for (const advertised of outcomeLine().split('/').map(part => part.trim())) {
    const normalized = advertised.toLowerCase().replace(/[ -]/g, '_');
    assert.ok(
      gateVocabulary.has(normalized),
      `README advertises "${advertised}", which no gate returns. Gate vocabulary: ${[...gateVocabulary].sort().join(', ')}`,
    );
  }
});

test('escalate is not advertised as a gate outcome', () => {
  const line = outcomeLine();
  assert.doesNotMatch(line, /escalat/i, 'escalation is an approval-boundary decision, not a gate outcome');

  // And it is not a gate outcome anywhere in the code either.
  for (const [name, decisions] of [
    ['MCP_GATE_DECISIONS', MCP_GATE_DECISIONS],
    ['AGENT_ACTION_FIREWALL_DECISIONS', AGENT_ACTION_FIREWALL_DECISIONS],
    ['PR Guardian DECISIONS', PR_GUARDIAN_DECISIONS],
  ]) {
    for (const decision of Object.values(decisions)) {
      assert.doesNotMatch(String(decision), /escalat/i, `${name} unexpectedly contains an escalate outcome`);
    }
  }
});

test('the outcomes the gates do return are all named', () => {
  const line = outcomeLine().toLowerCase();
  for (const decision of ['allow', 'review', 'quarantine', 'block', 'reject']) {
    assert.match(line, new RegExp(decision), `README omits the "${decision}" outcome`);
  }
  assert.match(line, /dry-run only/, 'README omits the dry-run-only outcome');
});

test('the README explains escalation as a human decision at the approval boundary', () => {
  assert.match(README, /Escalation is a decision a person makes, not one the gate returns/);
  assert.match(README, /escalated/, 'the escalated case status should be named');
  assert.match(README, /single-user install/, 'the README should say why a single user does not get escalation');

  // The claim points at a real module with a real vocabulary.
  assert.match(README, /lib\/human-oversight-approval-runtime\.js/);
  assert.ok(DECISION_TYPES.includes('escalate'), 'escalate must be a real approval decision type');
  assert.ok(CASE_STATUSES.includes('escalated'), 'escalated must be a real case status');
});

test('the decision types the README lists match the runtime', () => {
  for (const decisionType of ['approve', 'reject', 'expire', 'cancel', 'escalate', 'override']) {
    assert.ok(DECISION_TYPES.includes(decisionType), `${decisionType} is claimed by the README but missing from DECISION_TYPES`);
    assert.match(README, new RegExp(`\`${decisionType}\``), `README omits the "${decisionType}" decision type`);
  }
});
