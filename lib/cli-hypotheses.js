'use strict';

const {
  buildHypothesisCandidate,
  generateHypotheses,
} = require('./graph-hypotheses');
const { reviewHypothesisCandidate } = require('./hypothesis-review');
const { buildFeedbackStats } = require('./hypothesis-feedback');
const { buildTuningAdvice } = require('./hypothesis-tuning');
const { buildFitnessReport } = require('./hypothesis-fitness');

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

function formatFeedbackReport(feedback) {
  const lines = [
    `Hipotez geri bildirimi — workspace: ${feedback.meta.workspaceId}`,
    `  aday: ${feedback.meta.candidateCount}  kural: ${feedback.meta.ruleCount}`,
  ];
  if (feedback.rules.length === 0) {
    lines.push('  Henüz incelenecek hipotez adayı yok.');
    return lines.join('\n');
  }
  const rate = value => (value === null ? '  -  ' : `${(value * 100).toFixed(0).padStart(3)}%`);
  for (const row of feedback.rules) {
    lines.push(`${row.ruleType.padEnd(18)} kabul ${row.accepted}  ret ${row.rejected}  bekleyen ${row.pending}`);
    lines.push(`  └─ kabul oranı ${rate(row.acceptanceRate)}  ret oranı ${rate(row.rejectionRate)}  (incelenen ${row.reviewed}/${row.total})`);
  }
  return lines.join('\n');
}

function runCliHypothesesFeedback(kernel, args, opts = {}) {
  const feedback = buildFeedbackStats(kernel, { workspaceId: args.workspaceId });
  return opts.json === true || args.json === true ? { feedback } : formatFeedbackReport(feedback);
}

function formatTuningAdvice(tuning) {
  const lines = [
    `Eşik tuning tavsiyesi — workspace: ${tuning.meta.workspaceId}`,
    `  en az ${tuning.meta.minReviewed} inceleme ve %${Math.round(tuning.meta.rejectionTrigger * 100)} üzeri red oranı aranır`,
  ];
  if (tuning.suggestions.length === 0) {
    lines.push('  Öneri yok.');
  }
  for (const item of tuning.suggestions) {
    lines.push(`${item.ruleType.padEnd(18)} ${item.option}: ${item.currentValue} -> ${item.suggestedValue}`);
    lines.push(`  └─ ${item.reason}`);
  }
  for (const item of tuning.skipped) {
    lines.push(`${item.ruleType.padEnd(18)} atlandı (${item.reason}, incelenen ${item.reviewed})`);
  }
  lines.push('  Bu bir tavsiyedir; hiçbir eşik değiştirilmedi.');
  return lines.join('\n');
}

function runCliHypothesesTuning(kernel, args, opts = {}) {
  const feedback = buildFeedbackStats(kernel, { workspaceId: args.workspaceId });
  const tuning = buildTuningAdvice(feedback, {
    confidenceFloor: finiteOption(args.confidenceFloor),
    criticalInDegree: finiteOption(args.criticalInDegree),
    smallComponentSize: finiteOption(args.smallComponentSize),
  });
  return opts.json === true || args.json === true ? { tuning } : formatTuningAdvice(tuning);
}

const FITNESS_LABELS = Object.freeze({
  evidenceCoverage: 'kanıt kapsamı',
  hypothesisAccuracy: 'hipotez isabeti',
  connectivity: 'bağlantılılık',
  consistency: 'tutarlılık',
});

function formatFitnessReport(fitness) {
  const lines = [
    `Graf sağlığı — workspace: ${fitness.meta.workspaceId}`,
    `  düğüm: ${fitness.meta.nodeCount}  kenar: ${fitness.meta.edgeCount}`,
    fitness.score === null
      ? '  Skor hesaplanamadı: ölçülebilir bileşen yok.'
      : `  Skor: ${fitness.score.toFixed(2)}  Not: ${fitness.grade}`,
  ];
  for (const component of fitness.components) {
    const label = (FITNESS_LABELS[component.name] || component.name).padEnd(16);
    const value = component.value === null ? 'veri yok' : component.value.toFixed(2);
    lines.push(`  ${label} ${value}  (ağırlık ${component.weight})`);
  }
  lines.push('  Bu rapor ölçer; hiçbir şeyi optimize etmez.');
  return lines.join('\n');
}

function runCliHypothesesFitness(kernel, args, opts = {}) {
  const fitness = buildFitnessReport(kernel, { workspaceId: args.workspaceId });
  return opts.json === true || args.json === true ? { fitness } : formatFitnessReport(fitness);
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
  if (args.feedback === true) return runCliHypothesesFeedback(kernel, args, opts);
  if (args.tuning === true) return runCliHypothesesTuning(kernel, args, opts);
  if (args.fitness === true) return runCliHypothesesFitness(kernel, args, opts);
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
  formatFeedbackReport,
  formatFitnessReport,
  formatTuningAdvice,
  formatHypothesisReport,
  formatReviewResult,
  runCliHypotheses,
};
