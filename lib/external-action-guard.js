'use strict';

const { classifyAgentAction, ACTION_DECISIONS, RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateToolCall } = require('./tool-call-gate');
const { evaluateCommandExec } = require('./command-exec-gate');
const { evaluateMemoryMutation } = require('./memory-mutation-gate');
const { evaluateAutomationSafety } = require('./automation-safety-gate');
const { evaluateEgress } = require('./data-egress-gate');
const { evaluateDataResidency, collectDestinations } = require('./data-residency-gate');
const { expectedEgressOptions, evaluateUnexpectedEgress } = require('./unexpected-egress-gate');
const { observeFile } = require('./file-effect-sensor');
const { evaluateCrossWorkspaceAccess } = require('./cross-workspace-access-gate');
const { resolvePathWithinRoot } = require('./path-safety');
const { isControlPlanePath, findControlPlaneCommandTarget } = require('./control-plane-paths');
const { normalizeExternalActionEnvelope, EXTERNAL_ACTION_KINDS } = require('./external-action-envelope');
const { evaluateAgentIdentity } = require('./external-action-identity');
const { privilegeEscalationOptions, evaluateIdentityEscalation } = require('./identity-privilege-escalation');
const { evaluateGraduatedAutonomy, graduatedAutonomyOptions } = require('./graduated-autonomy');
const { evaluatePostActionBehavior, postActionMonitoringOptions } = require('./post-action-monitor');
const {
  EXTERNAL_ACTION_GUARD_VERSION,
  buildExternalActionAdmissionReceipt,
  buildExternalActionOutcomeReceipt,
  persistExternalActionReceipt,
} = require('./external-action-receipt');

const EXTERNAL_ACTION_DECISIONS = Object.freeze({ ALLOW: 'allow', REVIEW: 'review', BLOCK: 'block' });
const DECISION_RANK = Object.freeze({ allow: 0, review: 1, block: 2 });

const SHELL_SIDE_EFFECT_RULES = Object.freeze([
  Object.freeze({
    pattern: /(?:^|\s)find(?:\.exe)?\b[\s\S]*?(?:^|\s)-delete(?:\s|$)/i,
    decision: 'block',
    reason: 'read_command_destructive_flag_blocked',
  }),
  Object.freeze({
    pattern: /(?:^|\s)find(?:\.exe)?\b[\s\S]*?(?:^|\s)-(?:exec|execdir|ok|okdir)(?:\s|$)/i,
    decision: 'review',
    reason: 'read_command_exec_flag_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)find(?:\.exe)?\b[\s\S]*?(?:^|\s)-(?:fprint|fprint0|fprintf|fls)(?:\s|$)/i,
    decision: 'review',
    reason: 'read_command_output_flag_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+(?:diff|log|show)\b[\s\S]*?(?:^|\s)--output(?:=|\s)/i,
    decision: 'review',
    reason: 'git_output_flag_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+diff\b[\s\S]*?(?:^|\s)--(?:ext-diff|textconv)(?:\s|$)/i,
    decision: 'review',
    reason: 'git_external_diff_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)(?:rg|ripgrep)(?:\.exe)?\b[\s\S]*?(?:^|\s)--pre(?:=|\s)/i,
    decision: 'review',
    reason: 'search_preprocessor_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+branch\b[\s\S]*?(?:^|\s)(?:-D|--delete)(?:\s|$)/,
    decision: 'block',
    reason: 'git_branch_delete_blocked',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+branch\b[\s\S]*?(?:^|\s)(?:-d|-m|-M|-c|-C|--move|--copy|--edit-description|--set-upstream-to|--unset-upstream)(?:=|\s|$)/,
    decision: 'review',
    reason: 'git_branch_mutation_review_required',
  }),
  Object.freeze({
    pattern: /(?:^|\s)git(?:\.exe)?\s+remote\s+(?:add|remove|rename|set-head|set-branches|set-url|prune|update)(?:\s|$)/i,
    decision: 'review',
    reason: 'git_remote_mutation_review_required',
  }),
]);

const EXTERNAL_ACTION_REASONS = Object.freeze({
  ALLOWED: 'external_action_allowed',
  REVIEW: 'external_action_review_required',
  BLOCKED: 'external_action_blocked',
  MALFORMED: 'malformed_external_action_blocked',
  GATE_ERROR: 'external_action_gate_error',
  OUTSIDE_WORKSPACE: 'external_action_path_outside_workspace',
  CONTROL_PLANE: 'external_action_control_plane_blocked',
  RECEIPT_PERSISTENCE_FAILED: 'external_action_receipt_persistence_failed',
  DATA_RESIDENCY: 'external_action_data_residency_blocked',
});

function mergeDecision(current, requested) {
  return (DECISION_RANK[requested] ?? 2) > (DECISION_RANK[current] ?? 2) ? requested : current;
}

function scoreForLevel(level) {
  const value = String(level || '').toLowerCase();
  if (value === 'critical') return 100;
  if (value === 'high') return 80;
  if (value === 'medium') return 50;
  return 10;
}

function normalizeScore(score, level) {
  if (!Number.isFinite(score)) return scoreForLevel(level);
  return score <= 1 ? Math.round(score * 100) : Math.max(0, Math.min(100, score));
}

function actionDecision(value) {
  if (value === ACTION_DECISIONS.BLOCK) return EXTERNAL_ACTION_DECISIONS.BLOCK;
  if (value === ACTION_DECISIONS.ALLOW) return EXTERNAL_ACTION_DECISIONS.ALLOW;
  return EXTERNAL_ACTION_DECISIONS.REVIEW;
}

function genericDecision(value) {
  return value === 'allow' ? EXTERNAL_ACTION_DECISIONS.ALLOW
    : value === 'block' ? EXTERNAL_ACTION_DECISIONS.BLOCK
      : EXTERNAL_ACTION_DECISIONS.REVIEW;
}

function recordGateError(gate, error, findings) {
  findings.push({ gate, decision: 'block', reason: EXTERNAL_ACTION_REASONS.GATE_ERROR, error: String(error?.message || error) });
  return EXTERNAL_ACTION_DECISIONS.BLOCK;
}

function runGate(gate, findings, evaluate, project) {
  try {
    const result = evaluate();
    const finding = project(result);
    findings.push({ gate, ...finding });
    return genericDecision(finding.decision);
  } catch (error) {
    return recordGateError(gate, error, findings);
  }
}


/**
 * The declared residency for this evaluation.
 *
 * An explicit option wins so a caller can evaluate against a rule that is not
 * on disk; otherwise the deployment policy file is read. Absent means the gate
 * stays inert, which is what keeps an existing installation unchanged.
 */
function resolveDataResidency(options) {
  if (options && options.dataResidency !== undefined) return options.dataResidency;
  return require('./external-action-command-policy').readDataResidency(options && options.policyPath);
}

function buildAb1Input(envelope) {
  const target = {};
  if (envelope.target.path) target.path = envelope.target.path;
  if (envelope.target.url) target.url = envelope.target.url;
  return {
    action: envelope.action,
    category: envelope.riskCategory,
    target,
    context: {
      source: 'external-action-guard',
      flags: Array.isArray(envelope.metadata.flags) ? envelope.metadata.flags : [],
      allowlistedPaths: [envelope.workspaceRoot],
      allowlistedUrls: Array.isArray(envelope.metadata.allowlistedUrls) ? envelope.metadata.allowlistedUrls : [],
    },
  };
}

function classifierForToolGate(ab1) {
  return {
    classifierVersion: EXTERNAL_ACTION_GUARD_VERSION,
    risk: {
      level: String(ab1.riskLevel || RISK_LEVELS.HIGH).toLowerCase(),
      score: scoreForLevel(ab1.riskLevel) / 100,
      category: ab1.category || 'external-action',
    },
  };
}

function evaluateExternalAction(input, options = {}) {
  const envelope = normalizeExternalActionEnvelope(input, options);
  const continuousMonitoring = postActionMonitoringOptions(options);
  const findings = [];
  let decision = EXTERNAL_ACTION_DECISIONS.ALLOW;
  let reason = EXTERNAL_ACTION_REASONS.ALLOWED;
  let riskLevel = RISK_LEVELS.LOW;
  let riskScore = 10;

  // Identity runs first and unconditionally: even a malformed envelope or a
  // rejected card leaves a persisted identity on the receipt, so the audit
  // trail never has an action without an answer to "who did this".
  const identity = evaluateAgentIdentity(envelope, options);
  envelope.identity = identity.identity;
  findings.push(identity.finding);
  decision = mergeDecision(decision, genericDecision(identity.finding.decision));
  if (decision !== EXTERNAL_ACTION_DECISIONS.ALLOW) reason = identity.finding.reason;

  // #1891: the identity gate above is memoryless -- it asks whether the card
  // presented now grants the capability used now. This asks the question that
  // needs a session's memory: has this identity's claimed authority grown since
  // the session began? Opt-in, so an unconfigured deployment is unchanged.
  const escalationConfig = privilegeEscalationOptions(options);
  if (escalationConfig) {
    const escalation = evaluateIdentityEscalation({ envelope, identity: identity.identity }, escalationConfig);
    if (escalation) {
      findings.push(escalation);
      const before = decision;
      decision = mergeDecision(decision, genericDecision(escalation.decision));
      if (decision !== before) reason = escalation.reason;
    }
  }

  // Graduated autonomy is an opt-in ceiling over the existing AB1-AB11
  // decisions. It may require review for an action above the identity's tier,
  // but it never upgrades or bypasses a stricter safety-gate result.
  try {
    const autonomyOptions = graduatedAutonomyOptions(continuousMonitoring && !options.graduatedAutonomy
      ? {
          ...options,
          graduatedAutonomy: {
            enabled: true,
            receipts: continuousMonitoring.receipts,
            receiptPath: continuousMonitoring.receiptPath,
            activation: continuousMonitoring.activation,
          },
        }
      : options);
    if (autonomyOptions) {
      const autonomy = evaluateGraduatedAutonomy({
        identity: envelope.identity,
        action: { kind: envelope.kind, riskCategory: envelope.riskCategory },
        receipts: autonomyOptions.receipts,
        activation: autonomyOptions.activation,
      }, { now: autonomyOptions.now });
      envelope.autonomy = autonomy.autonomy;
      findings.push(autonomy.finding);
      decision = mergeDecision(decision, genericDecision(autonomy.decision));
      if (autonomy.decision !== EXTERNAL_ACTION_DECISIONS.ALLOW) reason = autonomy.reason;
    }
  } catch (error) {
    decision = mergeDecision(decision, recordGateError('graduated-autonomy', error, findings));
    reason = EXTERNAL_ACTION_REASONS.GATE_ERROR;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
  }

  if (envelope.malformed) {
    decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
    reason = EXTERNAL_ACTION_REASONS.MALFORMED;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
    findings.push({ gate: 'envelope', decision, reason, flags: envelope.errors });
    return finalize(envelope, { decision, reason, risk: { level: riskLevel, score: riskScore }, findings }, options);
  }

  if ([EXTERNAL_ACTION_KINDS.FILE_READ, EXTERNAL_ACTION_KINDS.FILE_WRITE].includes(envelope.kind)
      && envelope.target.path) {
    const absoluteTarget = require('node:path').resolve(envelope.cwd, envelope.target.path);
    try {
      resolvePathWithinRoot(envelope.workspaceRoot, absoluteTarget, { allowMissing: true });
    } catch (_) {
      decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
      reason = EXTERNAL_ACTION_REASONS.OUTSIDE_WORKSPACE;
      riskLevel = RISK_LEVELS.CRITICAL;
      riskScore = 100;
      findings.push({ gate: 'path-safety', decision, reason });
    }
  }

  // The guard's own wiring outranks ordinary workspace paths: a write here
  // decides whether any later action is evaluated at all, so it cannot be one
  // more `ask` among many. `allowControlPlane` comes from the deployment that
  // installed the hook and is never read off the invocation, so an agent
  // cannot grant itself the exemption by asking for it.
  if (!options.allowControlPlane) {
    const controlPlane = envelope.kind === EXTERNAL_ACTION_KINDS.SHELL
      ? findControlPlaneCommandTarget(envelope.command)
      : (envelope.kind === EXTERNAL_ACTION_KINDS.FILE_WRITE ? isControlPlanePath(envelope.target.path) : null);
    if (controlPlane) {
      decision = EXTERNAL_ACTION_DECISIONS.BLOCK;
      reason = EXTERNAL_ACTION_REASONS.CONTROL_PLANE;
      riskLevel = RISK_LEVELS.CRITICAL;
      riskScore = 100;
      findings.push({ gate: 'control-plane', decision, reason, profile: controlPlane.profile, path: controlPlane.path });
    }
  }

  let ab1;
  try {
    ab1 = classifyAgentAction(buildAb1Input(envelope));
    const projected = actionDecision(ab1.decision);
    findings.push({ gate: 'AB1', decision: projected, reason: ab1.reason, riskLevel: ab1.riskLevel, flags: ab1.flags || [] });
    decision = mergeDecision(decision, projected);
    riskLevel = ab1.riskLevel || riskLevel;
    riskScore = Math.max(riskScore, scoreForLevel(riskLevel));
  } catch (error) {
    decision = mergeDecision(decision, recordGateError('AB1', error, findings));
    reason = EXTERNAL_ACTION_REASONS.GATE_ERROR;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = 100;
  }

  // Shell invocations are classified by AB1 and then parsed by the shell-aware
  // AB8 gate below. Passing generic shell tool names (Bash, terminal, exec)
  // through AB2 as well would turn even AB8-allowlisted read commands into an
  // "unknown tool" review, making adapter spelling affect policy.
  if (ab1 && envelope.kind !== EXTERNAL_ACTION_KINDS.SHELL) {
    const ab2Decision = runGate('AB2', findings, () => evaluateToolCall({
      toolName: envelope.tool.name,
      action: envelope.action,
      args: envelope.args,
      workspaceId: envelope.workspaceId,
      classifier: classifierForToolGate(ab1),
    }), result => ({ decision: result.decision, reason: result.reason, riskLevel: result.risk?.level }));
    decision = mergeDecision(decision, ab2Decision);
  }

  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL) {
    for (const rule of SHELL_SIDE_EFFECT_RULES) {
      if (!rule.pattern.test(envelope.command)) continue;
      findings.push({ gate: 'shell-side-effect', decision: rule.decision, reason: rule.reason });
      decision = mergeDecision(decision, rule.decision);
    }
    const ab8Decision = runGate('AB8', findings, () => evaluateCommandExec({
      command: envelope.command,
      cwd: envelope.cwd,
      workspaceRoot: envelope.workspaceRoot,
    }), result => ({
      decision: result.decision,
      reason: result.reason,
      denylistMatch: result.denylistMatch,
      injectionMatches: result.injectionMatches,
    }));
    decision = mergeDecision(decision, ab8Decision);
  }

  if (envelope.kind === EXTERNAL_ACTION_KINDS.MEMORY) {
    const entries = Array.isArray(envelope.args.entries) && envelope.args.entries.length
      ? envelope.args.entries
      : [{
          id: `external-${envelope.invocationId}`,
          action: envelope.action,
          changeType: 'content',
          scope: envelope.workspaceId,
          workspaceId: envelope.workspaceId,
          content: envelope.args.text || '',
        }];
    const ab4Decision = runGate('AB4', findings, () => evaluateMemoryMutation({
      entries,
      operationType: envelope.action,
      mutationType: 'graph',
      targetSpace: envelope.targetWorkspaceId || envelope.workspaceId,
    }), result => ({ decision: result.decision, reason: result.reason, riskLevel: result.risk?.level }));
    decision = mergeDecision(decision, ab4Decision);
  }

  if ([EXTERNAL_ACTION_KINDS.AUTOMATION, EXTERNAL_ACTION_KINDS.DEPLOYMENT].includes(envelope.kind)) {
    const ab5Decision = runGate('AB5', findings, () => evaluateAutomationSafety({
      operation: { action: envelope.action, operationType: envelope.action, target: envelope.tool.name },
      operationType: envelope.action,
      target: envelope.tool.name,
      actor: envelope.agent.name,
      preview: false,
      dryRun: false,
      metadata: { source: 'external-action-guard' },
    }), result => ({ decision: result.decision, reason: result.reason, riskLevel: result.risk?.level }));
    decision = mergeDecision(decision, ab5Decision);
  }

  // Collected once and shared: AB9 records where the action was headed, and
  // AB13 decides whether anyone expected it to go there. Two calls would let
  // the observation on the receipt and the destination that was judged drift
  // apart, which is precisely the pair that has to agree.
  const observedDestinations = collectDestinations(envelope.args);

  const egressDecision = runGate('AB9', findings, () => evaluateEgress(envelope.args), result => ({
    decision: result.piiDetected || result.secretDetected ? 'review' : 'allow',
    reason: result.piiDetected || result.secretDetected ? 'sensitive_payload_review_required' : 'no_sensitive_payload',
    piiTypes: result.piiTypes || [],
    secretDetected: result.secretDetected,
    // Observed always, enforced only when a residency is declared (AB12).
    //
    // Without this the two halves deadlock: a residency rule can be mined from
    // the receipt trail only if the trail records where things went, and the
    // trail recorded destinations only when a rule already existed. Nobody
    // could derive the first rule from evidence.
    //
    // Recording a destination changes no decision. It is an observation, and
    // the receipt keeps it under AB9 -- which reports what the payload IS --
    // rather than under AB12, which reports what was REFUSED. A reader can
    // tell "we saw this go somewhere" from "we stopped this going somewhere".
    destinations: observedDestinations.hosts,
  }));
  decision = mergeDecision(decision, egressDecision);

  // AB12 consumes AB9's finding rather than re-detecting: AB9 owns what counts
  // as citizen data, this gate owns where it may go. Split that way, a change
  // to the PII vocabulary cannot silently narrow the residency boundary.
  const egressFinding = findings[findings.length - 1];
  const residency = resolveDataResidency(options);
  if (residency) {
    const residencyDecision = runGate('AB12', findings, () => evaluateDataResidency({
      payload: envelope.args,
      piiDetected: Boolean(egressFinding && egressFinding.gate === 'AB9' && (egressFinding.piiTypes || []).length > 0),
      piiTypes: (egressFinding && egressFinding.piiTypes) || [],
      residency,
    }), result => ({
      decision: result.decision,
      reason: result.reason,
      destinations: result.destinations,
      piiTypes: result.piiTypes,
    }));
    decision = mergeDecision(decision, residencyDecision);
    if (residencyDecision === EXTERNAL_ACTION_DECISIONS.BLOCK) {
      // The reason is left to the generic path, which reports the blocking
      // gate's own `data_residency_violation` -- more use to a compliance
      // reader than a second, blunter constant naming only the guard. The risk
      // level is set here because a cross-border transfer of personal data is
      // critical whatever the command's own classification said.
      riskLevel = RISK_LEVELS.CRITICAL;
      riskScore = 100;
    }
  }

  // AB13 (#1891): AB12 above speaks only when citizen data is in the payload
  // and a residency is declared. This asks the question that holds regardless
  // of what the bytes are -- was this destination expected at all -- so an
  // unexpected host carrying nothing sensitive stops passing in silence.
  const expectedEgress = expectedEgressOptions(options);
  if (expectedEgress) {
    const unexpectedEgressDecision = runGate('AB13', findings, () => evaluateUnexpectedEgress({
      destinations: observedDestinations.hosts,
      expected: expectedEgress.expected,
      decision: expectedEgress.decision,
      unparseable: observedDestinations.unparseable,
    }), result => ({
      decision: result.decision,
      reason: result.reason,
      unexpectedDestinations: result.unexpectedDestinations,
    }));
    decision = mergeDecision(decision, unexpectedEgressDecision);
  }

  if (envelope.targetWorkspaceId && envelope.targetWorkspaceId !== envelope.workspaceId) {
    const ab11Decision = runGate('AB11', findings, () => evaluateCrossWorkspaceAccess({
      actorWorkspaceId: envelope.workspaceId,
      targetWorkspaceId: envelope.targetWorkspaceId,
      operation: envelope.action,
      grants: envelope.workspaceGrants,
      resourceType: envelope.kind,
    }), result => ({ decision: result.decision, reason: result.reason, crossWorkspace: result.crossWorkspace }));
    decision = mergeDecision(decision, ab11Decision);
  }

  for (const finding of findings) {
    riskScore = Math.max(riskScore, normalizeScore(finding.risk?.score, finding.riskLevel));
  }
  if (decision === EXTERNAL_ACTION_DECISIONS.BLOCK) {
    reason = findings.findLast(finding => finding.decision === 'block')?.reason || EXTERNAL_ACTION_REASONS.BLOCKED;
    riskLevel = RISK_LEVELS.CRITICAL;
    riskScore = Math.max(riskScore, 95);
  } else if (decision === EXTERNAL_ACTION_DECISIONS.REVIEW) {
    reason = EXTERNAL_ACTION_REASONS.REVIEW;
    riskLevel = riskScore >= 80 ? RISK_LEVELS.HIGH : RISK_LEVELS.MEDIUM;
    riskScore = Math.max(riskScore, 50);
  }

  return finalize(envelope, {
    decision,
    reason,
    risk: { level: riskLevel, score: Math.min(100, riskScore) },
    findings,
  }, options);
}

function finalize(envelope, partial, options) {
  let result = {
    ok: true,
    allowed: partial.decision === EXTERNAL_ACTION_DECISIONS.ALLOW,
    canExecute: partial.decision === EXTERNAL_ACTION_DECISIONS.ALLOW,
    requiredReview: partial.decision === EXTERNAL_ACTION_DECISIONS.REVIEW,
    decision: partial.decision,
    reason: partial.reason,
    risk: partial.risk,
    findings: partial.findings,
    envelope,
    metadata: {
      guardVersion: EXTERNAL_ACTION_GUARD_VERSION,
      autonomy: envelope.autonomy || null,
    },
  };
  // The first of the two readings that make `effectVerification: observed`
  // possible. Taken here, from the filesystem, so the later conclusion does not
  // rest on what the executor reports. Only for an action that names a file;
  // everything else carries null and stays `reported`.
  // Measured against the action cwd, never the guard process's: a relative
  // target resolved anywhere else would observe the wrong file (#1865).
  envelope.fileBefore = envelope.target.path ? observeFile(envelope.target.resolvedPath || envelope.target.path) : null;
  let receipt = buildExternalActionAdmissionReceipt(envelope, result, options);
  let receiptPersisted = false;
  let receiptError = null;
  try {
    receiptPersisted = persistExternalActionReceipt(options.receiptWriter, receipt);
    if (['promoted', 'demoted'].includes(envelope.autonomy?.transition?.status) && !receiptPersisted) {
      throw new Error('graduated autonomy transition requires durable receipt persistence');
    }
  } catch (error) {
    receiptError = String(error?.message || error);
    result = {
      ...result,
      allowed: false,
      canExecute: false,
      requiredReview: false,
      decision: EXTERNAL_ACTION_DECISIONS.BLOCK,
      reason: EXTERNAL_ACTION_REASONS.RECEIPT_PERSISTENCE_FAILED,
      risk: { level: RISK_LEVELS.CRITICAL, score: 100 },
      findings: [...result.findings, { gate: 'receipt', decision: 'block', reason: EXTERNAL_ACTION_REASONS.RECEIPT_PERSISTENCE_FAILED, error: receiptError }],
    };
    receipt = buildExternalActionAdmissionReceipt(envelope, result, options);
  }
  return Object.freeze({ ...result, receipt, receiptPersisted, receiptError });
}

function recordExternalActionOutcome(input, admissionReceipt, outcome, options = {}) {
  const envelope = normalizeExternalActionEnvelope(input, options);
  if (envelope.malformed) throw new TypeError(`invalid external action envelope: ${envelope.errors.join(',')}`);
  envelope.identity = evaluateAgentIdentity(envelope, options).identity;
  const monitoringOptions = postActionMonitoringOptions(options);
  const monitoring = monitoringOptions
    ? evaluatePostActionBehavior({ envelope, identity: envelope.identity, admissionReceipt, outcome }, monitoringOptions)
    : null;
  envelope.postActionMonitoring = monitoring?.receiptSummary || null;
  const receipt = buildExternalActionOutcomeReceipt(envelope, admissionReceipt, outcome, options);
  let persisted = false;
  let receiptError = null;
  try {
    persisted = persistExternalActionReceipt(options.receiptWriter, receipt);
    if (monitoring?.anomaly && !persisted) {
      throw new Error('post-action quarantine requires durable receipt persistence');
    }
  } catch (error) {
    receiptError = String(error?.message || error);
  }
  const quarantined = monitoring?.anomaly === true && persisted;
  let findingError = null;
  if (quarantined && monitoringOptions.findingSink && monitoring.finding) {
    try {
      monitoringOptions.findingSink(monitoring.finding);
    } catch (error) {
      findingError = String(error?.message || error);
    }
  }
  const monitoringError = monitoring && !monitoring.active
    ? monitoring.receiptSummary.reason
    : findingError;
  return Object.freeze({
    ok: receiptError === null && monitoringError === null,
    receipt,
    receiptPersisted: persisted,
    receiptError,
    monitoringError,
    monitoring,
    quarantined,
    demotedTo: quarantined ? 'T1' : null,
    finding: monitoring?.finding || null,
  });
}

module.exports = {
  EXTERNAL_ACTION_DECISIONS,
  EXTERNAL_ACTION_REASONS,
  evaluateExternalAction,
  recordExternalActionOutcome,
  mergeExternalActionDecisions: mergeDecision,
  SHELL_SIDE_EFFECT_RULES,
};
