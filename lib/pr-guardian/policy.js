'use strict';

const DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  DRY_RUN_ONLY: 'dry_run_only',
  BLOCK: 'block',
});

const ACTIONS = Object.freeze({
  READ_SNAPSHOT: 'github.pr.snapshot',
  STATUS_PREVIEW: 'github.status.preview',
  COMMENT_CREATE: 'github.comment.create',
  LABEL_APPLY: 'github.label.apply',
  MERGE_EXECUTE: 'github.merge.execute',
  DEPLOY_START: 'github.deploy.start',
});

const RISK_PATTERNS = Object.freeze([
  Object.freeze({ label: 'force-push', pattern: /force[-_ ]?push|history[-_ ]?rewrite/i, decision: DECISIONS.BLOCK, reason: 'history_rewrite_or_force_push' }),
  Object.freeze({ label: 'branch-protection-bypass', pattern: /branch[-_ ]?protection|bypass.*protection|protected branch.*bypass/i, decision: DECISIONS.BLOCK, reason: 'branch_protection_bypass' }),
  Object.freeze({ label: 'production-data-delete', pattern: /delete.*production|drop.*production|truncate.*production|production.*records.*delete/i, decision: DECISIONS.BLOCK, reason: 'production_data_destruction' }),
  Object.freeze({ label: 'deploy', pattern: /(^|[^a-z])deploy([^a-z]|$)|production release|release to prod/i, decision: DECISIONS.DRY_RUN_ONLY, reason: 'production_deploy_requires_explicit_gate' }),
  Object.freeze({ label: 'secret-change', pattern: /secret|credential|token|private key|password/i, decision: DECISIONS.REVIEW, reason: 'secret_or_credential_change' }),
  Object.freeze({ label: 'migration', pattern: /migration|schema|database|\.sql\b/i, decision: DECISIONS.REVIEW, reason: 'database_or_schema_change' }),
]);

function text(value) {
  return typeof value === 'string' ? value.trim() : String(value == null ? '' : value).trim();
}

function normalizeAction(action) {
  return text(action) || ACTIONS.READ_SNAPSHOT;
}

function normalizeChecks(checks) {
  if (!Array.isArray(checks)) return [];
  return checks.map(check => ({
    name: text(check?.name),
    status: text(check?.status).toLowerCase(),
    conclusion: text(check?.conclusion).toLowerCase(),
    required: check?.required === true,
  })).filter(check => check.name);
}

function snapshotText(snapshot = {}) {
  const files = Array.isArray(snapshot.files) ? snapshot.files.map(file => `${text(file?.filename)} ${text(file?.patch)}`).join('\n') : '';
  return [
    text(snapshot.title),
    text(snapshot.body),
    text(snapshot.baseRef),
    text(snapshot.headRef),
    files,
  ].filter(Boolean).join('\n');
}

function evaluateRiskSignals(snapshot = {}) {
  const haystack = snapshotText(snapshot);
  const labels = [];
  const findings = [];
  for (const risk of RISK_PATTERNS) {
    if (!risk.pattern.test(haystack)) continue;
    labels.push(risk.label);
    findings.push({ label: risk.label, decision: risk.decision, reason: risk.reason });
  }
  return { labels, findings };
}

function requiredChecksPass(snapshot = {}) {
  const checks = normalizeChecks(snapshot.checks);
  const required = checks.filter(check => check.required);
  if (required.length === 0) return { known: true, passed: true, missing: [] };
  const missing = required.filter(check => !['success', 'passed', 'neutral', 'skipped'].includes(check.conclusion || check.status));
  return { known: true, passed: missing.length === 0, missing: missing.map(check => check.name) };
}

function evaluatePullRequest(snapshot = {}, options = {}) {
  const action = normalizeAction(options.action);
  const phase = text(options.phase || 'preview');
  const signals = evaluateRiskSignals(snapshot);
  const checks = requiredChecksPass(snapshot);
  const reasons = [];
  let decision = DECISIONS.ALLOW;

  if (!text(snapshot.repo) || !text(snapshot.headSha) || !text(snapshot.workspaceId)) {
    return {
      decision: DECISIONS.BLOCK,
      reason: 'immutable_pr_snapshot_required',
      riskLabels: ['incomplete-snapshot'],
      findings: [],
      action,
      phase,
      canonicalWrite: false,
    };
  }

  if (signals.findings.some(item => item.decision === DECISIONS.BLOCK)) {
    decision = DECISIONS.BLOCK;
    reasons.push(signals.findings.find(item => item.decision === DECISIONS.BLOCK).reason);
  } else if (signals.findings.some(item => item.decision === DECISIONS.DRY_RUN_ONLY)) {
    decision = DECISIONS.DRY_RUN_ONLY;
    reasons.push(signals.find(item => item.decision === DECISIONS.DRY_RUN_ONLY).reason);
  } else if (signals.findings.some(item => item.decision === DECISIONS.REVIEW)) {
    decision = DECISIONS.REVIEW;
    reasons.push(signals.find(item => item.decision === DECISIONS.REVIEW).reason);
  }

  if (!checks.passed) {
    decision = decision === DECISIONS.BLOCK ? decision : DECISIONS.REVIEW;
    reasons.push('required_checks_not_passed');
  }

  if ([ACTIONS.COMMENT_CREATE, ACTIONS.LABEL_APPLY, ACTIONS.MERGE_EXECUTE].includes(action)) {
    if (decision === DECISIONS.ALLOW) {
      decision = DECISIONS.REVIEW;
      reasons.push('external_github_mutation_requires_operator_approval');
    }
  }

  if (action === ACTIONS.STATUS_PREVIEW || action === ACTIONS.DEPLOY_START) {
    if (decision !== DECISIONS.BLOCK) {
      decision = DECISIONS.DRY_RUN_ONLY;
      reasons.push(action === ACTIONS.DEPLOY_START ? 'deploy_is_preview_only_in_mvp' : 'status_write_is_preview_only');
    }
  }

  if (action === ACTIONS.MERGE_EXECUTE || action === ACTIONS.DEPLOY_START) {
    decision = DECISIONS.BLOCK;
    reasons.push(action === ACTIONS.MERGE_EXECUTE ? 'merge_executor_disabled_in_mvp' : 'deploy_executor_disabled_in_mvp');
  }

  if (phase === 'execute' && options.approved === true && decision === DECISIONS.REVIEW) {
    decision = DECISIONS.ALLOW;
    reasons.push('operator_approval_revalidated');
  }

  return {
    decision,
    reason: reasons[0] || 'read_only_snapshot_allowed',
    reasons,
    riskLabels: [...new Set(signals.labels)],
    findings: signals.findings,
    checks,
    action,
    phase,
    canonicalWrite: false,
  };
}

module.exports = Object.freeze({
  ACTIONS,
  DECISIONS,
  RISK_PATTERNS,
  evaluatePullRequest,
  evaluateRiskSignals,
  normalizeChecks,
});

// Guard against accidental mutation of the exported vocabulary in consumers.
Object.freeze(RISK_PATTERNS);
