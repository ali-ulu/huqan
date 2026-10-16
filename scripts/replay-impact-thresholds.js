'use strict';

// #2505 implementation order, step 1: replay proposed session impact
// thresholds over verified receipt history WITHOUT changing any decision.
//
// This is analysis tooling, not a gate. Thresholds arrive only as explicit
// caller arguments -- there are no defaults, so no policy hides in this
// file. Unverified receipts are excluded and counted, unscored actions are
// `unknown` (never zero), and equality triggers the stated band, per the
// control-set design. The output tells calibration what WOULD have happened.

const fs = require('node:fs');
const {
  hasValidReceiptHash,
  isAdmissionReceipt,
  readReceiptHistory,
} = require('../lib/autonomy-receipt-history');

const VERDICTS = Object.freeze(['allow', 'review', 'quorum', 'block', 'unknown']);

function checkThreshold(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite number at or above 0`);
  }
  return value;
}

function normalizeThresholds(thresholds = {}) {
  if (!thresholds || typeof thresholds !== 'object' || Array.isArray(thresholds)) {
    throw new TypeError('thresholds must be an object');
  }
  const reviewAt = checkThreshold(thresholds.reviewAt, 'reviewAt');
  const quorumAt = checkThreshold(thresholds.quorumAt, 'quorumAt');
  const blockAt = checkThreshold(thresholds.blockAt, 'blockAt');
  if (!(reviewAt <= quorumAt && quorumAt <= blockAt)) {
    throw new TypeError('thresholds must order reviewAt <= quorumAt <= blockAt');
  }
  return Object.freeze({ reviewAt, quorumAt, blockAt });
}

function blastScore(receipt) {
  const score = receipt.metadata?.justification?.blastRadius?.score;
  return Number.isFinite(score) ? score : null;
}

function sessionOf(receipt) {
  const sessionId = typeof receipt.metadata?.sessionId === 'string' ? receipt.metadata.sessionId.trim() : '';
  return sessionId || null;
}

function projectVerdict(cumulative, thresholds) {
  if (cumulative >= thresholds.blockAt) return 'block';
  if (cumulative >= thresholds.quorumAt) return 'quorum';
  if (cumulative >= thresholds.reviewAt) return 'review';
  return 'allow';
}

/**
 * Project session impact bands over verified admission receipts.
 *
 * @param {Array} receipts verified-or-not admission history (tail order)
 * @param {object} thresholds { reviewAt, quorumAt, blockAt } (required, ordered)
 * @param {object} [options] { sessionId } to replay a single session
 */
function projectSessionThresholds(receipts, thresholds, options = {}) {
  const bands = normalizeThresholds(thresholds);
  const list = Array.isArray(receipts) ? receipts : [];
  const onlySession = typeof options.sessionId === 'string' && options.sessionId.trim()
    ? options.sessionId.trim()
    : null;

  const sessions = new Map();
  let unverifiedExcluded = 0;
  let nonAdmissionExcluded = 0;
  let sessionlessExcluded = 0;
  for (const receipt of list) {
    if (!isAdmissionReceipt(receipt)) {
      nonAdmissionExcluded += 1;
      continue;
    }
    if (!hasValidReceiptHash(receipt)) {
      unverifiedExcluded += 1;
      continue;
    }
    const sessionId = sessionOf(receipt);
    if (!sessionId) {
      sessionlessExcluded += 1;
      continue;
    }
    if (onlySession && sessionId !== onlySession) continue;
    if (!sessions.has(sessionId)) sessions.set(sessionId, []);
    sessions.get(sessionId).push(receipt);
  }

  const projected = {};
  const totals = {
    sessions: sessions.size,
    actions: 0,
    scored: 0,
    unscored: 0,
    wouldAllow: 0,
    wouldReview: 0,
    wouldQuorum: 0,
    wouldBlock: 0,
    unknowns: 0,
  };
  for (const [sessionId, actions] of sessions) {
    let cumulative = 0;
    const steps = actions.map((receipt, index) => {
      const score = blastScore(receipt);
      if (score === null) {
        totals.unscored += 1;
        totals.unknowns += 1;
        return Object.freeze({ index, score: null, cumulative, verdict: 'unknown' });
      }
      cumulative += score;
      const verdict = projectVerdict(cumulative, bands);
      totals.scored += 1;
      if (verdict === 'allow') totals.wouldAllow += 1;
      else if (verdict === 'review') totals.wouldReview += 1;
      else if (verdict === 'quorum') totals.wouldQuorum += 1;
      else totals.wouldBlock += 1;
      return Object.freeze({ index, score, cumulative, verdict });
    });
    totals.actions += actions.length;
    projected[sessionId] = Object.freeze({
      actions: actions.length,
      scored: steps.filter((step) => step.verdict !== 'unknown').length,
      unscored: steps.filter((step) => step.verdict === 'unknown').length,
      maxCumulative: steps.reduce((max, step) => Math.max(max, step.cumulative), 0),
      steps: Object.freeze(steps),
    });
  }

  return Object.freeze({
    version: 'huqan-impact-replay-v1',
    thresholds: bands,
    truncated: list.truncated === true,
    excluded: Object.freeze({ nonAdmissionExcluded, unverifiedExcluded, sessionlessExcluded }),
    sessions: Object.freeze(projected),
    totals: Object.freeze(totals),
  });
}

function readArgv(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag.startsWith('--')) throw new Error(`unexpected argument: ${flag}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`missing value for ${flag}`);
    args[flag.slice(2)] = value;
    index += 1;
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = readArgv(argv);
  if (!args.receipts) throw new Error('missing required --receipts <jsonl path>');
  const thresholds = {
    reviewAt: Number(args['session-review']),
    quorumAt: Number(args['session-quorum']),
    blockAt: Number(args['session-block']),
  };
  const history = readReceiptHistory({ path: args.receipts });
  const report = projectSessionThresholds(history, thresholds, { sessionId: args.session });
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`impact replay failed: ${error?.message || error}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  VERDICTS,
  normalizeThresholds,
  projectSessionThresholds,
};
