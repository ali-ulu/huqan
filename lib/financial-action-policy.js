'use strict';

/**
 * Payment and financial action gate, v0 assessment (#2505/D).
 *
 * Money leaves the operator's control and is hard to get back, so a
 * financial action is never silently allowed: without a readable amount and
 * destination it holds for human review as CRITICAL, and even a fully
 * described one holds for review until owner-configured amount limits exist.
 * Recorded assessment, never an allow -- the limits that could relax this
 * are an explicit owner follow-up, as is the amount/destination keyword
 * inference that would route free text here.
 *
 * Pure assessment on explicit input: no filesystem, no network, no process
 * state. Malformed input degrades to review, never to allow and never throws.
 */

const { ACTION_DECISIONS, RISK_LEVELS } = require('./risk-policy-constants');
const { parseDecimalAmount } = require('./financial-aggregation');

const FINANCIAL_REASONS = Object.freeze({
  DETAILS_ABSENT: 'FINANCIAL_DETAILS_ABSENT',
  IRREVERSIBLE: 'FINANCIAL_IRREVERSIBLE',
  ASSESSED: 'FINANCIAL_ASSESSMENT_RECORDED',
  TIER_SINGLE_REVIEW: 'FINANCIAL_TIER_SINGLE_REVIEW',
  TIER_QUORUM: 'FINANCIAL_TIER_QUORUM',
  TIER_MANDATE_BLOCK: 'FINANCIAL_TIER_MANDATE_BLOCK',
});

// ADR-0009 v0.1 starter USD bands, in minor-free exact form: amounts compare
// as integer minor units at their own scale, never as floats. Other
// currencies stay held for review until their own owner tables exist.
const USD_TIER_SINGLE_MAX = { units: '100', scale: 0 };
const USD_TIER_QUORUM_MAX = { units: '1000', scale: 0 };

function text(value) {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : '';
}

function readAmount(input) {
  const raw = input && input.amount !== undefined ? input.amount : (input && input.value);
  const amount = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

/** Compare two exact decimal amounts. Returns negative, zero, or positive. */
function compareExact(left, right) {
  const scale = Math.max(left.scale, right.scale);
  const units = (entry) => BigInt(entry.units) * 10n ** BigInt(scale - entry.scale);
  const diff = units(left) - units(right);
  return diff < 0n ? -1 : diff > 0n ? 1 : 0;
}

/**
 * ADR-0009 v0.1 USD tiers for a fully described, reversible, exact payment.
 * Anything else keeps the existing held-for-review behavior below.
 */
function usdTier(exact) {
  if (!exact) return null;
  if (compareExact(exact, USD_TIER_QUORUM_MAX) > 0) {
    return Object.freeze({
      decision: ACTION_DECISIONS.BLOCK,
      reason: FINANCIAL_REASONS.TIER_MANDATE_BLOCK,
      riskLevel: RISK_LEVELS.CRITICAL,
      tier: 'mandate',
      requiredApprovers: 0,
    });
  }
  if (compareExact(exact, USD_TIER_SINGLE_MAX) > 0) {
    return Object.freeze({
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reason: FINANCIAL_REASONS.TIER_QUORUM,
      riskLevel: RISK_LEVELS.CRITICAL,
      tier: 'quorum',
      requiredApprovers: 2,
    });
  }
  return Object.freeze({
    decision: ACTION_DECISIONS.HUMAN_REVIEW,
    reason: FINANCIAL_REASONS.TIER_SINGLE_REVIEW,
    riskLevel: RISK_LEVELS.HIGH,
    tier: 'single',
    requiredApprovers: 1,
  });
}

/**
 * Pick the recorded totals matching this assessment out of a payment-totals
 * report. Anything malformed or unmatched is null (unknown), never zero:
 * a missing total must not read as "nothing spent here".
 */
function selectAggregatedTotals(report, { currency, destination, taskId }) {
  const empty = { destination: null, task: null };
  if (!report || typeof report !== 'object' || Array.isArray(report)) return empty;
  if (!currency || !destination) return empty;
  const pick = (bucket, group) => {
    try {
      const total = bucket && typeof bucket === 'object' && !Array.isArray(bucket)
        ? bucket[group]
        : null;
      const entry = total && typeof total === 'object' ? total[currency] : null;
      if (!entry || typeof entry !== 'object') return null;
      if (typeof entry.units !== 'string' || !/^\d+$/.test(entry.units)
        || !Number.isInteger(entry.scale) || entry.scale < 0) return null;
      return Object.freeze({ units: entry.units, scale: entry.scale });
    } catch (_) {
      return null;
    }
  };
  const groups = report.byDestination && typeof report.byDestination === 'object' ? report.byDestination : {};
  const tasks = report.byTask && typeof report.byTask === 'object' ? report.byTask : {};
  return {
    destination: pick(groups, destination),
    task: taskId ? pick(tasks, taskId) : null,
  };
}

/**
 * Assess one financial action.
 *
 * @param {object} [input] { amount, currency, destination, reversible,
 *   taskId?, aggregatedTotals? } `aggregatedTotals` is a readPaymentTotals
 *   report: the matching destination and task totals for the assessed
 *   currency ride in the assessment so a later gate sees split payments.
 *   Malformed totals degrade to null, never throw and never change the
 *   decision below.
 * @returns {object} frozen { decision, reason, riskLevel, assessment }
 */
function evaluateFinancialAction(input = {}) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {};
  const amount = readAmount(source);
  const currency = text(source.currency).toUpperCase() || null;
  const destination = text(source.destination);
  const reversible = source.reversible === true;
  const exactAmount = parseDecimalAmount(source.amount !== undefined ? source.amount : source.value);
  const totals = selectAggregatedTotals(source.aggregatedTotals, {
    currency,
    destination,
    taskId: text(source.taskId) || null,
  });
  const assessment = Object.freeze({
    amount,
    exactAmount,
    currency,
    destinationPresent: destination !== '',
    reversible,
    limitsConfigured: false,
    aggregatedDestinationTotal: totals.destination,
    aggregatedTaskTotal: totals.task,
    tier: null,
    requiredApprovers: 0,
  });
  if (amount === null || destination === '') {
    return Object.freeze({
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reason: FINANCIAL_REASONS.DETAILS_ABSENT,
      riskLevel: RISK_LEVELS.CRITICAL,
      assessment,
    });
  }
  if (!reversible) {
    return Object.freeze({
      decision: ACTION_DECISIONS.HUMAN_REVIEW,
      reason: FINANCIAL_REASONS.IRREVERSIBLE,
      riskLevel: RISK_LEVELS.CRITICAL,
      assessment,
    });
  }
  if (currency === 'USD' && exactAmount) {
    const tiered = usdTier(exactAmount);
    return Object.freeze({
      decision: tiered.decision,
      reason: tiered.reason,
      riskLevel: tiered.riskLevel,
      assessment: Object.freeze({ ...assessment, tier: tiered.tier, requiredApprovers: tiered.requiredApprovers }),
    });
  }
  return Object.freeze({
    decision: ACTION_DECISIONS.HUMAN_REVIEW,
    reason: FINANCIAL_REASONS.ASSESSED,
    riskLevel: RISK_LEVELS.HIGH,
    assessment,
  });
}

module.exports = { evaluateFinancialAction, FINANCIAL_REASONS };
