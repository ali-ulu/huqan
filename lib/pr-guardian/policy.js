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

/**
 * Where a pattern is allowed to look.
 *
 * `intent` is what the author says: title, body, branch names. `change` is what
 * the diff does: filenames, and the added lines of each patch.
 *
 * The distinction is not cosmetic. Every pattern used to read both, and the two
 * that describe a kind of *file* rather than a kind of *plan* -- secrets and
 * migrations -- fired on any prose containing their vocabulary. Measured against
 * five real pull requests on this repository, three were flagged
 * `secret_or_credential_change` and two of those touched no credential at all:
 * one adds a source scanner and says "tokenise" throughout, the other ships a
 * viewer page whose own copy reads "without exposing operator credentials".
 *
 * A gate that is wrong two times in three stops being read, so those two now
 * want evidence in the change rather than a word in a sentence. The patterns
 * that describe an intent still read the intent: someone announcing a
 * force-push is the signal, and there may be no diff that corroborates it.
 */
const SCOPES = Object.freeze({ INTENT: 'intent', CHANGE: 'change' });

const RISK_PATTERNS = Object.freeze([
  Object.freeze({ label: 'force-push', scope: SCOPES.INTENT, pattern: /force[-_ ]?push|history[-_ ]?rewrite/i, decision: DECISIONS.BLOCK, reason: 'history_rewrite_or_force_push' }),
  Object.freeze({ label: 'branch-protection-bypass', scope: SCOPES.INTENT, pattern: /branch[-_ ]?protection|bypass.*protection|protected branch.*bypass/i, decision: DECISIONS.BLOCK, reason: 'branch_protection_bypass' }),
  Object.freeze({ label: 'production-data-delete', scope: SCOPES.INTENT, pattern: /delete.*production|drop.*production|truncate.*production|production.*records.*delete/i, decision: DECISIONS.BLOCK, reason: 'production_data_destruction' }),
  Object.freeze({ label: 'deploy', scope: SCOPES.INTENT, pattern: /(^|[^a-z])deploy([^a-z]|$)|production release|release to prod/i, decision: DECISIONS.DRY_RUN_ONLY, reason: 'production_deploy_requires_explicit_gate' }),
  // A path that carries credentials, or an added line that assigns one. The
  // bare word is deliberately not enough: `token` turns up in ordinary prose
  // and in half the identifiers of any codebase that talks to an API.
  Object.freeze({
    label: 'secret-change',
    scope: SCOPES.CHANGE,
    pattern: /(^|[/.])(\.env|\.npmrc|\.netrc|id_rsa|\S*\.(pem|key|p12|pfx|jks))\b|(^|\/)(secrets?|credentials?)\//im,
    // The value has to look like a secret, not merely be assigned to something
    // named like one: a literal blob to the end of the line. `apiKey = "sk_live_..."`
    // matches; `apiKey = readFromEnv()` and `token = process.env.TOKEN` do not,
    // and neither does the cleanup that replaces the first with the second.
    addedLine: /^\+(?!\+).*\b(secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key)\b\s*[:=]\s*["'`]?(?!process\.|import\.|globalThis|window\.|env\.|config\.|settings\.|secrets\.|vars\.)[A-Za-z0-9_\-/+=.]{8,}["'`]?\s*[,;]?\s*$/im,
    decision: DECISIONS.REVIEW,
    reason: 'secret_or_credential_change',
  }),
  // A CI workflow is where credentials are actually reachable: it holds the
  // repository's secrets and runs whatever the file says. Narrowing
  // `secret-change` to credential-bearing paths removed the one case on this
  // repository that deserved a second pair of eyes, so the surface gets named
  // directly instead of being caught sideways by a word in a sentence.
  Object.freeze({
    label: 'ci-workflow-change',
    scope: SCOPES.CHANGE,
    pattern: /(^|\/)\.github\/workflows\/\S+\.ya?ml$/im,
    decision: DECISIONS.REVIEW,
    reason: 'ci_workflow_change',
  }),
  // Likewise a migration is a file or a DDL statement, not the word "schema" --
  // which this repository writes constantly, since its pages carry schema.org
  // markup and its modules ship JSON schemas.
  Object.freeze({
    label: 'migration',
    scope: SCOPES.CHANGE,
    pattern: /(^|\/)migrations?\/|\S*\.sql\b/im,
    addedLine: /^\+(?!\+).*\b(create|alter|drop|truncate|rename)\s+(table|index|column|schema|database)\b/im,
    decision: DECISIONS.REVIEW,
    reason: 'database_or_schema_change',
  }),
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

/** What the author says they are doing. */
function intentText(snapshot = {}) {
  return [
    text(snapshot.title),
    text(snapshot.body),
    text(snapshot.baseRef),
    text(snapshot.headRef),
  ].filter(Boolean).join('\n');
}

/** The paths the change touches. */
function changedPaths(snapshot = {}) {
  if (!Array.isArray(snapshot.files)) return '';
  return snapshot.files.map(file => text(file?.filename)).filter(Boolean).join('\n');
}

/**
 * Only the lines a patch adds. A removed line proves the opposite of the thing
 * being looked for, and context lines belong to whoever wrote them earlier.
 */
function addedLines(snapshot = {}) {
  if (!Array.isArray(snapshot.files)) return '';
  return snapshot.files
    .map(file => text(file?.patch))
    .filter(Boolean)
    .join('\n')
    .split('\n')
    .filter(line => line.startsWith('+') && !line.startsWith('+++'))
    .join('\n');
}

/**
 * Kept for callers that want the whole snapshot as one string. The risk scan no
 * longer uses it: reading intent and change through one haystack is what let a
 * word in a sentence stand in for a credential in a file.
 */
function snapshotText(snapshot = {}) {
  const files = Array.isArray(snapshot.files) ? snapshot.files.map(file => `${text(file?.filename)} ${text(file?.patch)}`).join('\n') : '';
  return [intentText(snapshot), files].filter(Boolean).join('\n');
}

function matchesRisk(risk, scopes) {
  if (risk.scope === SCOPES.INTENT) return risk.pattern.test(scopes.intent);
  // A change-scoped pattern accepts either signal: the path says what kind of
  // file this is, the added line says what was written into it.
  if (risk.pattern.test(scopes.paths)) return true;
  return Boolean(risk.addedLine) && risk.addedLine.test(scopes.added);
}

function evaluateRiskSignals(snapshot = {}) {
  const scopes = {
    intent: intentText(snapshot),
    paths: changedPaths(snapshot),
    added: addedLines(snapshot),
  };
  const labels = [];
  const findings = [];
  for (const risk of RISK_PATTERNS) {
    if (!matchesRisk(risk, scopes)) continue;
    labels.push(risk.label);
    findings.push({ label: risk.label, decision: risk.decision, reason: risk.reason });
  }
  return { labels, findings };
}

/**
 * Whether the required checks on this PR have passed.
 *
 * "No check is marked required" is not the same as "no check is required".
 * GitHub's check-runs API carries no requiredness at all -- that lives in
 * branch protection -- so a snapshot built from check-runs alone cannot answer
 * the question. Reporting `known: true, passed: true` for that case made the
 * `required_checks_not_passed` escalation dead code and advertised a
 * protection that was never running (#1267).
 *
 * `known: false` says the gate has no opinion, which callers can surface,
 * rather than an opinion it has not earned.
 */
function requiredChecksPass(snapshot = {}) {
  const checks = normalizeChecks(snapshot.checks);
  const required = checks.filter(check => check.required);
  if (required.length === 0) return { known: false, passed: true, missing: [] };
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

  // Most severe risk decision present wins, and its first finding carries the
  // reason. Written as one lookup per severity rather than a some()/find()
  // pair per branch: that duplication is what let `signals.find` -- `signals`
  // is `{ labels, findings }` and has no `.find` -- survive in two of the
  // three branches, since the `some()` beside it was spelled correctly and
  // the typo only threw once a matching risk was actually present.
  for (const severity of [DECISIONS.BLOCK, DECISIONS.DRY_RUN_ONLY, DECISIONS.REVIEW]) {
    const finding = signals.findings.find(item => item.decision === severity);
    if (!finding) continue;
    decision = severity;
    reasons.push(finding.reason);
    break;
  }

  if (snapshot.filesTruncated === true) {
    // Fail closed: an unexamined tail of the diff is not evidence of safety.
    // Every risk signal comes from files[].filename and files[].patch, so a
    // truncated list means the scan did not cover the change.
    decision = decision === DECISIONS.BLOCK ? decision : DECISIONS.REVIEW;
    reasons.push('file_list_truncated');
  }

  if (!checks.known) {
    // Surfaced, not escalated. Escalating here would send every PR to review
    // wherever the requirement set cannot be read, which is a policy choice
    // rather than a defect fix; what matters for #1267 is that the gap stops
    // being invisible.
    reasons.push('required_checks_unknown');
  } else if (!checks.passed) {
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
