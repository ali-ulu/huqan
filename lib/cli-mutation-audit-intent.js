'use strict';

const { normalizeWorkspaceId } = require('./workspace-id');

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
  'phase',
]);
/**
 * `attempted` is written before the mutation runs and says only that the
 * command was admitted; `committed` is written after it actually completed.
 * Without the distinction a reader cannot tell an audited-and-executed
 * mutation from one that was audited and then failed (#760).
 */
const CLI_MUTATION_AUDIT_PHASES = new Set(['attempted', 'committed']);
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
  // quickstart was gated and audited by the CLI but missing here, so every one
  // of its audit writes was rejected as an unknown mapping and — before the
  // gate started failing closed — silently discarded (#760).
  ['quickstart', 'demo_sandbox', 'UPDATE', 'allow', true, 'cli_quickstart_isolated_demo_store'],
  ['kaydet', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['exit', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['cikis', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['backup', 'export', 'EXPORTED', 'allow', true, 'cli_backup_export_local'],
  ['restore', 'state_replace', 'IMPORTED', 'allow', true, 'cli_restore_state_replace_local'],
  ['optimize', 'canonical', 'BLOCKED', 'block', false, 'cli_canonical_mutation_unavailable'],
  ['evolve', 'canonical', 'BLOCKED', 'block', false, 'cli_canonical_mutation_unavailable'],
  ['konsolide', 'canonical', 'BLOCKED', 'block', false, 'cli_canonical_mutation_unavailable'],
  ['dusun', 'automation', 'BLOCKED', 'block', false, 'cli_automation_unavailable'],
]);

const { isPlainObject } = require('./is-plain-object');

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

  validated.phase = Object.prototype.hasOwnProperty.call(intent, 'phase')
    ? intent.phase
    : 'attempted';
  if (!CLI_MUTATION_AUDIT_PHASES.has(validated.phase)) return null;

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
  CLI_MUTATION_AUDIT_PHASES,
  CLI_MUTATION_AUDIT_MAPPINGS,
  normalizeWorkspaceId,
  isPlainObject,
  validateCliMutationAuditIntent,
};
