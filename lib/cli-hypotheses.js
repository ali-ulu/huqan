'use strict';

const {
  buildHypothesisCandidate,
  generateHypotheses,
} = require('./graph-hypotheses');
const { reviewHypothesisCandidate } = require('./hypothesis-review');

function finiteOption(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function normalizedArgs(args = {}) {
  if (typeof args === 'string') return { workspaceId: args.trim() || 'default' };
  return args && typeof args === 'object' ? args : {};
}

function formatHypothesisReport(report, proposal = null) {
  const lines = [
    `Hipotez raporu — workspace: ${report.meta.workspaceId}`,
    `  düğüm: ${report.meta.nodeCount}  kenar: ${report.meta.edgeCount}`,
  ];
  if (report.hypotheses.length === 0) {
    lines.push('  Graf temiz görünüyor. Hipotez yok.');
  } else {
    for (const hypothesis of report.hypotheses) {
      lines.push(`${hypothesis.severity.toUpperCase().padEnd(6)} [${hypothesis.type}] ${hypothesis.target}`);
      lines.push(`  └─ ${hypothesis.gerekce}`);
    }
  }
  if (proposal) lines.push(`  Candidate claim kuyruğuna alınan yüksek ciddiyetli hipotez: ${proposal.queued}`);
  return lines.join('\n');
}

function formatReviewResult(review) {
  return [
    `Hipotez incelemesi — ${review.candidateId}`,
    `  kural: ${review.ruleType || '(bilinmiyor)'}`,
    `  durum: ${review.previousStatus} -> ${review.status}`,
    `  inceleyen: ${review.reviewedBy}`,
    '  Kanonik graf değişmedi: kabul teşhis onayıdır, kenar onayı değildir.',
  ].join('\n');
}

function runCliHypothesesReview(kernel, args, opts = {}) {
  const review = reviewHypothesisCandidate(kernel, {
    candidateId: args.candidateId,
    decision: args.decision,
    reviewer: args.reviewer,
    workspaceId: args.workspaceId,
  });
  if (typeof opts.commitMutation === 'function') {
    const warning = opts.commitMutation();
    if (warning) review.warning = warning;
  }
  return opts.json === true || args.json === true ? { review } : formatReviewResult(review);
}

function runCliHypotheses(kernel, rawArgs = {}, opts = {}) {
  const args = normalizedArgs(rawArgs);
  if (args.review === true) return runCliHypothesesReview(kernel, args, opts);
  const report = generateHypotheses(kernel?.graph, {
    workspaceId: args.workspaceId,
    confidenceFloor: finiteOption(args.confidenceFloor),
    criticalInDegree: finiteOption(args.criticalInDegree),
    smallComponentSize: finiteOption(args.smallComponentSize),
  });

  let proposal = null;
  if (args.propose === true) {
    const highSeverity = report.hypotheses.filter(item => item.severity === 'high');
    for (const hypothesis of highSeverity) {
      kernel.addCandidateClaim(
        buildHypothesisCandidate(hypothesis, report.meta.workspaceId),
        { workspaceId: report.meta.workspaceId },
      );
    }
    proposal = { requested: true, queued: highSeverity.length };
    if (highSeverity.length > 0 && typeof opts.commitMutation === 'function') {
      const warning = opts.commitMutation();
      if (warning) proposal.warning = warning;
    }
  }

  const result = proposal ? { ...report, proposal } : report;
  return opts.json === true || args.json === true ? result : formatHypothesisReport(report, proposal);
}

module.exports = {
  formatHypothesisReport,
  formatReviewResult,
  runCliHypotheses,
};
