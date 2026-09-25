'use strict';

// Payment and financial action gate v0 (#2505/D): assessment only, never an
// allow. Amount limits and keyword inference are explicit follow-ups.

const assert = require('node:assert/strict');
const { describe, it, test } = require('node:test');

const { evaluateFinancialAction, FINANCIAL_REASONS } = require('../lib/financial-action-policy');
const { classifyAgentAction } = require('../lib/action-risk-classifier');
const { evaluateExternalAction } = require('../lib/external-action-guard');

describe('financial action assessment', () => {
  it('holds blind money movement for review as CRITICAL, never allows', () => {
    for (const input of [
      undefined,
      null,
      'pay',
      42,
      {},
      { amount: 10 },
      { destination: 'vendor' },
      { amount: 0, destination: 'vendor' },
      { amount: -5, destination: 'vendor' },
      { amount: 'a lot', destination: 'vendor' },
      { amount: 10, destination: '   ' },
    ]) {
      const result = evaluateFinancialAction(input);
      assert.equal(result.decision, 'HUMAN_REVIEW', JSON.stringify(input));
      assert.equal(result.reason, FINANCIAL_REASONS.DETAILS_ABSENT, JSON.stringify(input));
      assert.equal(result.riskLevel, 'CRITICAL', JSON.stringify(input));
      assert.ok(Object.isFrozen(result));
    }
  });

  it('flags irreversible movement CRITICAL even when fully described', () => {
    const result = evaluateFinancialAction({ amount: 25, currency: 'usd', destination: 'vendor', reversible: false });
    assert.equal(result.decision, 'HUMAN_REVIEW');
    assert.equal(result.reason, FINANCIAL_REASONS.IRREVERSIBLE);
    assert.equal(result.riskLevel, 'CRITICAL');
    assert.deepEqual(result.assessment, {
      amount: 25, exactAmount: { units: '25', scale: 0 }, currency: 'USD', destinationPresent: true,
      reversible: false, limitsConfigured: false,
      aggregatedDestinationTotal: null, aggregatedTaskTotal: null, tier: null, requiredApprovers: 0,
    });
  });

  it('records a reversible, fully described action as HIGH and still holds for review', () => {
    const result = evaluateFinancialAction({ amount: '100.50', destination: 'vendor', reversible: true });
    assert.equal(result.decision, 'HUMAN_REVIEW');
    assert.equal(result.reason, FINANCIAL_REASONS.ASSESSED);
    assert.equal(result.riskLevel, 'HIGH');
    assert.equal(result.assessment.amount, 100.5);
  });

  it('treats unknown reversibility as irreversible (fail-closed)', () => {
    const result = evaluateFinancialAction({ amount: 10, destination: 'vendor' });
    assert.equal(result.reason, FINANCIAL_REASONS.IRREVERSIBLE);
    assert.equal(result.riskLevel, 'CRITICAL');
  });

  it('carries matching aggregated totals without changing the verdict', () => {
    const totals = {
      byDestination: { vendor: { USD: { units: '11000', scale: 2 } } },
      byTask: { 'task-1': { USD: { units: '6000', scale: 2 } } },
    };
    const result = evaluateFinancialAction({
      amount: 50, currency: 'usd', destination: 'vendor', reversible: true,
      taskId: 'task-1', aggregatedTotals: totals,
    });
    assert.equal(result.decision, 'HUMAN_REVIEW');
    assert.equal(result.reason, FINANCIAL_REASONS.TIER_SINGLE_REVIEW);
    assert.deepEqual(result.assessment.aggregatedDestinationTotal, { units: '11000', scale: 2 });
    assert.deepEqual(result.assessment.aggregatedTaskTotal, { units: '6000', scale: 2 });
    assert.ok(Object.isFrozen(result.assessment.aggregatedDestinationTotal));
  });

  it('unmatched or malformed totals degrade to null, never zero and never throw', () => {
    const totals = { byDestination: { vendor: { USD: { units: '11000', scale: 2 } } }, byTask: {} };
    const wrongCurrency = evaluateFinancialAction({
      amount: 50, currency: 'EUR', destination: 'vendor', reversible: true, aggregatedTotals: totals,
    });
    assert.equal(wrongCurrency.assessment.aggregatedDestinationTotal, null);
    const wrongVendor = evaluateFinancialAction({
      amount: 50, currency: 'USD', destination: 'other', reversible: true, aggregatedTotals: totals,
    });
    assert.equal(wrongVendor.assessment.aggregatedDestinationTotal, null);
    for (const bad of [null, 42, 'totals', { byDestination: { vendor: { USD: { units: 'x', scale: 2 } } } }, { byDestination: null }]) {
      const result = evaluateFinancialAction({
        amount: 50, currency: 'USD', destination: 'vendor', reversible: true, aggregatedTotals: bad,
      });
      assert.equal(result.decision, 'HUMAN_REVIEW', JSON.stringify(bad));
      assert.equal(result.assessment.aggregatedDestinationTotal, null, JSON.stringify(bad));
      assert.equal(result.assessment.aggregatedTaskTotal, null, JSON.stringify(bad));
    }
  });

  it('USD tiers escalate single review, quorum and mandate block on exact amounts', () => {
    const pay = (amount) => evaluateFinancialAction({
      amount, currency: 'USD', destination: 'vendor', reversible: true,
    });
    const single = pay('100');
    assert.equal(single.decision, 'HUMAN_REVIEW');
    assert.equal(single.reason, FINANCIAL_REASONS.TIER_SINGLE_REVIEW);
    assert.equal(single.riskLevel, 'HIGH');
    assert.equal(single.assessment.tier, 'single');
    assert.equal(single.assessment.requiredApprovers, 1);

    const quorum = pay('100.01');
    assert.equal(quorum.decision, 'HUMAN_REVIEW');
    assert.equal(quorum.reason, FINANCIAL_REASONS.TIER_QUORUM);
    assert.equal(quorum.riskLevel, 'CRITICAL');
    assert.equal(quorum.assessment.tier, 'quorum');
    assert.equal(quorum.assessment.requiredApprovers, 2);

    const edge = pay('1000');
    assert.equal(edge.reason, FINANCIAL_REASONS.TIER_QUORUM);

    const mandate = pay('1000.01');
    assert.equal(mandate.decision, 'BLOCK');
    assert.equal(mandate.reason, FINANCIAL_REASONS.TIER_MANDATE_BLOCK);
    assert.equal(mandate.riskLevel, 'CRITICAL');
    assert.equal(mandate.assessment.tier, 'mandate');

    const nonUsd = evaluateFinancialAction({ amount: '5000', currency: 'EUR', destination: 'vendor', reversible: true });
    assert.equal(nonUsd.decision, 'HUMAN_REVIEW');
    assert.equal(nonUsd.reason, FINANCIAL_REASONS.ASSESSED);
    assert.equal(nonUsd.assessment.tier, null);

    const floatInput = evaluateFinancialAction({ amount: 50.5, currency: 'USD', destination: 'vendor', reversible: true });
    assert.equal(floatInput.reason, FINANCIAL_REASONS.ASSESSED, 'inexact input cannot enter a tier');
    assert.equal(floatInput.assessment.tier, null);
  });
});

test('financial category is wired into the canonical action classifier', () => {
  const reversible = classifyAgentAction({
    category: 'FINANCIAL_TRANSACTION',
    action: 'pay',
    context: { financial: { amount: 100, currency: 'EUR', destination: 'vendor', reversible: true } },
  });
  assert.equal(reversible.decision, 'HUMAN_REVIEW');
  assert.equal(reversible.riskLevel, 'HIGH');
  assert.equal(reversible.reason, FINANCIAL_REASONS.ASSESSED);
  assert.ok(!reversible.flags.includes('UNKNOWN_ACTION_CATEGORY'));

  const irreversible = classifyAgentAction({
    category: 'FINANCIAL_TRANSACTION',
    action: 'pay',
    context: { financial: { amount: 100, destination: 'vendor', reversible: false } },
  });
  assert.equal(irreversible.decision, 'HUMAN_REVIEW');
  assert.equal(irreversible.riskLevel, 'CRITICAL');
  assert.equal(irreversible.reason, FINANCIAL_REASONS.IRREVERSIBLE);
});

test('external action guard forwards financial details into the policy', () => {
  const result = evaluateExternalAction({
    invocationId: 'financial-call-1',
    agentName: 'finance-agent',
    sessionId: 'financial-session-1',
    toolName: 'payment.execute',
    riskCategory: 'FINANCIAL_TRANSACTION',
    args: { amount: 42, currency: 'EUR', destination: 'vendor-7', reversible: true },
    cwd: process.cwd(),
    workspaceRoot: process.cwd(),
  }, { requireIdentityCard: false, receiptWriter: { append() {} } });

  const finding = result.findings.find((entry) => entry.gate === 'AB1');
  assert.ok(finding);
  assert.equal(finding.decision, 'review');
  assert.equal(finding.reason, FINANCIAL_REASONS.ASSESSED);
  assert.equal(finding.riskLevel, 'HIGH');
  assert.equal(result.decision, 'review');
});
