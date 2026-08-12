'use strict';

const TERMINAL_BY_ADMISSION = Object.freeze({
  reject: 'rejected',
  quarantine: 'quarantined',
});

function effectiveRuleStatus(memory) {
  if (memory?.status === 'superseded') return 'superseded';
  return memory?.content?.status || 'proposed';
}

function terminalStatusForAdmission(admission) {
  return TERMINAL_BY_ADMISSION[admission?.decision?.decision] || '';
}

function persistActivationTerminal(store, ruleMemoryId, ruleResult, rule, admission, opts = {}) {
  const status = terminalStatusForAdmission(admission);
  if (!status) return null;
  const terminal = {
    ...rule,
    status,
    decisionReason: admission.decision.reason || '',
    decidedAt: new Date().toISOString(),
  };
  return store.supersede(ruleMemoryId, terminal, {
    workspaceId: opts.workspaceId || rule.workspaceId || 'default',
    actor: opts.actor,
    provenance: opts.provenance || ruleResult.memory.provenance,
    trustPolicyVersion: ruleResult.memory.trustPolicyVersion,
  });
}

function persistReplacementTerminal(store, rule, currentMemory, admission, opts = {}) {
  const status = terminalStatusForAdmission(admission);
  if (!status) return null;
  return store.storeContent({
    ...rule,
    status,
    decisionReason: admission.decision.reason || '',
    decidedAt: new Date().toISOString(),
  }, {
    workspaceId: opts.workspaceId || rule.workspaceId || 'default',
    actor: opts.actor,
    provenance: opts.provenance || currentMemory.provenance,
    trustPolicyVersion: currentMemory.trustPolicyVersion,
  });
}

module.exports = {
  effectiveRuleStatus,
  persistActivationTerminal,
  persistReplacementTerminal,
  terminalStatusForAdmission,
};
