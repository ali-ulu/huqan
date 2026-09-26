'use strict';

// The guard's identity phase (#2173): who is acting, whether their claimed
// authority grew during the session, and the graduated-autonomy ceiling. It
// runs before the envelope is judged malformed so every receipt carries an
// identity. Mutates the caller's `state` and `findings` in place.

const { RISK_LEVELS } = require('./action-risk-classifier');
const { evaluateAgentIdentity } = require('./external-action-identity');
const { privilegeEscalationOptions, evaluateIdentityEscalation } = require('./identity-privilege-escalation');
const { evaluateGraduatedAutonomy, graduatedAutonomyOptions } = require('./graduated-autonomy');
const { summarizeSessionImpact } = require('./session-impact');
const { genericDecision, mergeDecision, recordGateError } = require('./external-action-guard-gates');
const { EXTERNAL_ACTION_DECISIONS, EXTERNAL_ACTION_REASONS } = require('./external-action-guard-rules');

function evaluateIdentityPhase(envelope, options, continuousMonitoring, findings, state) {
  // Identity runs first and unconditionally: even a malformed envelope or a
  // rejected card leaves a persisted identity on the receipt, so the audit
  // trail never has an action without an answer to "who did this".
  const identity = evaluateAgentIdentity(envelope, options);
  envelope.identity = identity.identity;
  findings.push(identity.finding);
  state.decision = mergeDecision(state.decision, genericDecision(identity.finding.decision));
  if (state.decision !== EXTERNAL_ACTION_DECISIONS.ALLOW) state.reason = identity.finding.reason;

  // #1891: the identity gate above is memoryless. This asks what needs a
  // session's memory: has this identity's claimed authority grown since the
  // session began? On by default since #2157; a deployment can opt out.
  const escalationConfig = privilegeEscalationOptions(options);
  if (escalationConfig) {
    const escalation = evaluateIdentityEscalation({ envelope, identity: identity.identity }, escalationConfig);
    if (escalation) {
      findings.push(escalation);
      const before = state.decision;
      state.decision = mergeDecision(state.decision, genericDecision(escalation.decision));
      if (state.decision !== before) state.reason = escalation.reason;
    }
  }

  // Graduated autonomy (on by default since #2157) is a ceiling over AB1-AB11:
  // it may require review above the identity's tier, never relax a stricter one.
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
      envelope.sessionImpact = summarizeSessionImpact(autonomyOptions.receipts, envelope.session.id, { sandboxEscapes: options.sandboxEscapes });
      findings.push(autonomy.finding);
      state.decision = mergeDecision(state.decision, genericDecision(autonomy.decision));
      if (autonomy.decision !== EXTERNAL_ACTION_DECISIONS.ALLOW) state.reason = autonomy.reason;
    }
  } catch (error) {
    state.decision = mergeDecision(state.decision, recordGateError('graduated-autonomy', error, findings));
    state.reason = EXTERNAL_ACTION_REASONS.GATE_ERROR;
    state.riskLevel = RISK_LEVELS.CRITICAL;
    state.riskScore = 100;
  }
}

module.exports = { evaluateIdentityPhase };
