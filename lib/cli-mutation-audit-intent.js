'use strict';

const CLI_MUTATION_AUDIT_FIELDS = new Set([
  'sourceCommand',
  'mutationType',
  'eventType',
  'decision',
  'executionEligible',
  'reason',
  'actor',
  'workspaceId',
  'approvalState',
  'receiptReference',
]);
const CLI_MUTATION_AUDIT_REQUIRED_FIELDS = Object.freeze([
  'sourceCommand',
  'mutationType',
  'eventType',
  'decision',
  'executionEligible',
  'reason',
]);
const CLI_MUTATION_AUDIT_APPROVAL_STATES = new Set([
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
]);
const CLI_MUTATION_AUDIT_MAPPINGS = Object.freeze([
  ['kaydet', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['exit', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['cikis', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['backup', 'export', 'EXPORTED', 'allow', true, 'cli_backup_export_local'],
  ['restore', 'state_replace', 'IMPORTED', 'allow', true, 'cli_restore_state_replace_local'],
  ['optimize', 'canonical', 'REVIEW', 'review', false, 'cli_canonical_mutation_requires_review'],
  ['evolve', 'canonical', 'REVIEW', 'review', false, 'cli_canonical_mutation_requires_review'],
  ['konsolide', 'canonical', 'REVIEW', 'review', false, 'cli_canonical_mutation_requires_review'],
  ['dusun', 'automation', 'REVIEW', 'review', false, 'cli_automation_requires_review'],
]);

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

function validateCliMutationAuditIntent(intent) {
  if (!isPlainObject(intent)) return null;

  const ownKeys = Reflect.ownKeys(intent);
  if (ownKeys.some((key) => typeof key !== 'string' || !CLI_MUTATION_AUDIT_FIELDS.has(key))) {
    return null;
  }
  if (CLI_MUTATION_AUDIT_REQUIRED_FIELDS.some(
    (field) => !Object.prototype.hasOwnProperty.call(intent, field),
  )) {
    return null;
  }

  for (const field of CLI_MUTATION_AUDIT_REQUIRED_FIELDS) {
    if (field === 'executionEligible') {
      if (typeof intent[field] !== 'boolean') return null;
    } else if (typeof intent[field] !== 'string' || !intent[field]) {
      return null;
    }
  }

  const validated = {
    sourceCommand: intent.sourceCommand,
    mutationType: intent.mutationType,
    eventType: intent.eventType,
    decision: intent.decision,
    executionEligible: intent.executionEligible,
    reason: intent.reason,
  };

  for (const field of ['actor', 'workspaceId', 'receiptReference']) {
    if (!Object.prototype.hasOwnProperty.call(intent, field)) continue;
    if (typeof intent[field] !== 'string' || !intent[field].trim()) return null;
    validated[field] = intent[field].trim();
  }

  if (Object.prototype.hasOwnProperty.call(intent, 'approvalState')) {
    if (!CLI_MUTATION_AUDIT_APPROVAL_STATES.has(intent.approvalState)) return null;
    validated.approvalState = intent.approvalState;
  }

  const matchesMapping = CLI_MUTATION_AUDIT_MAPPINGS.some((mapping) => (
    mapping[0] === validated.sourceCommand
    && mapping[1] === validated.mutationType
    && mapping[2] === validated.eventType
    && mapping[3] === validated.decision
    && mapping[4] === validated.executionEligible
    && mapping[5] === validated.reason
  ));
  return matchesMapping ? validated : null;
}

module.exports = {
  CLI_MUTATION_AUDIT_FIELDS,
  CLI_MUTATION_AUDIT_REQUIRED_FIELDS,
  CLI_MUTATION_AUDIT_APPROVAL_STATES,
  CLI_MUTATION_AUDIT_MAPPINGS,
  normalizeWorkspaceId,
  isPlainObject,
  validateCliMutationAuditIntent,
};
