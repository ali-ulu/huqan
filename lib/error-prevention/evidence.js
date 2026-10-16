'use strict';

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function evidenceRef(item, index) {
  if (!item || typeof item !== 'object') {
    return { type: 'evidence', ref: `evidence:${index}` };
  }
  return {
    type: cleanString(item.type || item.kind) || 'evidence',
    ref: cleanString(item.ref || item.id || item.url || item.path) || `evidence:${index}`,
  };
}

function collectRuleEvidenceRefs(store, rules, workspaceId) {
  const refs = [];
  for (const rule of Array.isArray(rules) ? rules : []) {
    if (!rule?.sourceFailureMemoryId) continue;
    const failureResult = store.get(rule.sourceFailureMemoryId, workspaceId);
    if (!failureResult.ok || failureResult.memory?.content?.kind !== 'failure_record') continue;
    const failure = failureResult.memory.content;
    const evidence = Array.isArray(failure.evidence) ? failure.evidence : [];
    evidence.forEach((item, index) => {
      refs.push({
        ruleId: rule.ruleId,
        failureId: failure.failureId,
        failureMemoryId: rule.sourceFailureMemoryId,
        ...evidenceRef(item, index),
      });
    });
  }
  return refs;
}

module.exports = { collectRuleEvidenceRefs, evidenceRef };
