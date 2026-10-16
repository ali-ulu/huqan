'use strict';

const {
  MEMORY_MUTATION_GATE_DECISIONS,
  MEMORY_MUTATION_GATE_REASONS,
  MEMORY_MUTATION_RISK_LEVELS,
  DEFAULT_WORKSPACE_ID,
  RELEASE_ACTIONS,
  BREADTH_DRY_RUN_THRESHOLD,
} = require('./memory-mutation-vocabulary');
const { containsAny, normalizeEntry } = require('./memory-mutation-normalizer');
const {
  isReadOnlyEntry,
  isMetadataOnlyEntry,
  isAuditMutation,
  isCrossWorkspaceEntry,
  isReleaseOrAutoMutation,
  isPackageOrImportMutation,
  isSecretMutation,
  hasGraphMutation,
  isDestructiveDelete,
} = require('./memory-mutation-entry-predicates');

/** The fields every verdict carries, taken from the normalized entry. */
function baseVerdict(normalized, context) {
  return {
    ok: true,
    id: normalized.id,
    action: normalized.action,
    changeType: normalized.changeType,
    scope: normalized.scope,
    workspaceId: normalized.workspaceId,
    targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
  };
}

function changeFlags(normalized) {
  return {
    contentChanged: normalized.contentChanged,
    linksChanged: normalized.linksChanged,
    auditChanged: normalized.auditChanged,
  };
}

const { CRITICAL, HIGH, MEDIUM, LOW } = MEMORY_MUTATION_RISK_LEVELS;
const { BLOCK, REVIEW, DRY_RUN_ONLY, ALLOW } = MEMORY_MUTATION_GATE_DECISIONS;
const REASONS = MEMORY_MUTATION_GATE_REASONS;

function isBroadGraphChange(context) {
  const metadata = context.mutationMetadata;
  return Boolean(metadata && (metadata.entryCount >= BREADTH_DRY_RUN_THRESHOLD || metadata.graphCount >= 3 || metadata.linkCount >= 3));
}

/**
 * The classification rules, in the order they are tried (#2401): the first
 * whose `when` holds decides. `verdict` is the part that differs per rule; a
 * function where it depends on the entry or context. A new category is a new
 * row in its place, not another copy of the shared fields.
 */
const CLASSIFICATION_RULES = Object.freeze([
  {
    when: isCrossWorkspaceEntry,
    verdict: {
      category: 'cross_workspace', riskLevel: CRITICAL, riskScore: 1, decision: BLOCK,
      reason: REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED,
      notes: ['Entry workspace does not match the target workspace.'], sensitive: true,
    },
  },
  {
    when: isSecretMutation,
    verdict: {
      category: 'secret', riskLevel: CRITICAL, riskScore: 1, decision: BLOCK,
      reason: REASONS.SECRET_MUTATION_BLOCKED,
      notes: ['Sensitive token-like content detected.'], sensitive: true,
    },
  },
  {
    when: isAuditMutation,
    verdict: {
      category: 'audit', riskLevel: CRITICAL, riskScore: 1, decision: BLOCK,
      reason: REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED,
      notes: ['Audit rewrite/delete surface detected.'], sensitive: true,
    },
  },
  {
    when: isReleaseOrAutoMutation,
    verdict: (normalized, context, signal) => ({
      category: 'release_or_auto', riskLevel: CRITICAL, riskScore: 1, decision: BLOCK,
      reason: containsAny(signal, RELEASE_ACTIONS)
        ? REASONS.RELEASE_OR_DEPLOY_MUTATION_BLOCKED
        : REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED,
      notes: ['Release/deploy or auto-merge surface detected.'], sensitive: true,
    }),
  },
  {
    when: isDestructiveDelete,
    verdict: {
      category: 'delete', riskLevel: CRITICAL, riskScore: 1, decision: BLOCK,
      reason: REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED,
      notes: ['Destructive delete surface detected.'], sensitive: false,
    },
  },
  {
    when: hasGraphMutation,
    // This branch never blocks -- it answers review or dry-run-only -- so its
    // reason must never read ..._BLOCKED. The reason used to be picked by a
    // second, narrower keyword match over the same signal hasGraphMutation had
    // already matched, so an entry that qualified only through linksChanged /
    // tombstoned / superseded, or a GRAPH_ACTION outside that narrower list,
    // produced decision:review with reason:CANONICAL_GRAPH_MUTATION_BLOCKED and
    // downstream consumers (audit, MCP surface, telemetry) saw a review
    // reported as a block. CANONICAL_GRAPH_MUTATION_BLOCKED belongs to the
    // destructive-delete rule above, which does block.
    verdict: (normalized, context) => ({
      category: 'graph', riskLevel: HIGH, riskScore: 0.85,
      decision: isBroadGraphChange(context) ? DRY_RUN_ONLY : REVIEW,
      reason: REASONS.GRAPH_MUTATION_REQUIRES_REVIEW,
      notes: ['Canonical graph-adjacent mutation detected.'], sensitive: false,
    }),
  },
  {
    when: isPackageOrImportMutation,
    verdict: {
      category: 'package_import', riskLevel: MEDIUM, riskScore: 0.6, decision: REVIEW,
      reason: REASONS.PACKAGE_OR_IMPORT_REQUIRES_REVIEW,
      notes: ['Package/import/sync surface detected.'], sensitive: false,
    },
  },
  {
    when: isReadOnlyEntry,
    verdict: {
      category: 'read_only', riskLevel: LOW, riskScore: 0.15, decision: ALLOW,
      reason: REASONS.LOW_RISK_MEMORY_INSPECTION,
      notes: ['Read-only memory inspection.'], sensitive: false,
    },
  },
  {
    when: isMetadataOnlyEntry,
    verdict: {
      category: 'metadata', riskLevel: LOW, riskScore: 0.2, decision: ALLOW,
      reason: REASONS.LOW_RISK_METADATA_ONLY,
      notes: ['Metadata-only memory change.'], sensitive: false,
    },
  },
  {
    when: (normalized) => normalized.contentChanged,
    verdict: {
      category: 'content', riskLevel: MEDIUM, riskScore: 0.55, decision: REVIEW,
      reason: REASONS.CONTENT_EDIT_REQUIRES_REVIEW,
      notes: ['Memory content edit detected.'], sensitive: false,
    },
  },
]);

const UNKNOWN_VERDICT = Object.freeze({
  category: 'unknown', riskLevel: MEDIUM, riskScore: 0.55, decision: REVIEW,
  reason: REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED,
  notes: ['Memory mutation surface could not be safely categorized.'], sensitive: false,
});

function classifyMemoryMutation(entry, context = {}) {
  const normalized = normalizeEntry(entry, context);
  const signal = [normalized.action, normalized.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');

  // #2253: `scope` always falls back to the default workspace in normalizeEntry,
  // so requiring an empty scope made this branch unreachable (`null`/`{}` fell
  // through to `unknown`). A malformed entry is one that carries no identity,
  // no operation signal (entry or context), and no mutation flags at all --
  // flag-bearing entries keep their substantive routing (e.g. an anonymous
  // `{ deleted: true }` still blocks as `delete`, never downgrades to REVIEW).
  if (!normalized.id && !normalized.action && !normalized.changeType && !signal
    && !normalized.contentChanged && !normalized.linksChanged && !normalized.auditChanged
    && !normalized.deleted && !normalized.tombstoned && !normalized.superseded
    && !normalized.metadataOnly) {
    return {
      ...baseVerdict(normalized, context),
      ok: false,
      id: '',
      category: 'malformed',
      riskLevel: MEDIUM,
      riskScore: 0.6,
      decision: REVIEW,
      reason: REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      notes: ['Memory entry could not be normalized.'],
      sensitive: false,
      contentChanged: false,
      linksChanged: false,
      auditChanged: false,
    };
  }

  const rule = CLASSIFICATION_RULES.find((candidate) => candidate.when(normalized, context));
  const specific = !rule ? UNKNOWN_VERDICT
    : typeof rule.verdict === 'function' ? rule.verdict(normalized, context, signal) : rule.verdict;
  return {
    ...baseVerdict(normalized, context),
    ...specific,
    notes: [...specific.notes],
    ...changeFlags(normalized),
  };
}

module.exports = {
  classifyMemoryMutation,
};
