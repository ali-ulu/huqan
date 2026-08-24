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

function classifyMemoryMutation(entry, context = {}) {
  const normalized = normalizeEntry(entry, context);
  const signal = [normalized.action, normalized.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');

  if (!normalized.id && !normalized.action && !normalized.changeType && !normalized.scope) {
    return {
      ok: false,
      id: '',
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'malformed',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.MALFORMED_INPUT_REVIEW_REQUIRED,
      notes: ['Memory entry could not be normalized.'],
      sensitive: false,
      contentChanged: false,
      linksChanged: false,
      auditChanged: false,
    };
  }

  if (isCrossWorkspaceEntry(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'cross_workspace',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.CROSS_WORKSPACE_MUTATION_BLOCKED,
      notes: ['Entry workspace does not match the target workspace.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isSecretMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'secret',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.SECRET_MUTATION_BLOCKED,
      notes: ['Sensitive token-like content detected.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isAuditMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'audit',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.AUDIT_REWRITE_OR_DELETE_BLOCKED,
      notes: ['Audit rewrite/delete surface detected.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isReleaseOrAutoMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'release_or_auto',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: containsAny(signal, RELEASE_ACTIONS)
        ? MEMORY_MUTATION_GATE_REASONS.RELEASE_OR_DEPLOY_MUTATION_BLOCKED
        : MEMORY_MUTATION_GATE_REASONS.AUTO_MERGE_OR_AUTOPUSH_BLOCKED,
      notes: ['Release/deploy or auto-merge surface detected.'],
      sensitive: true,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isDestructiveDelete(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'delete',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.CRITICAL,
      riskScore: 1,
      decision: MEMORY_MUTATION_GATE_DECISIONS.BLOCK,
      reason: MEMORY_MUTATION_GATE_REASONS.CANONICAL_GRAPH_MUTATION_BLOCKED,
      notes: ['Destructive delete surface detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (hasGraphMutation(normalized, context)) {
    const isBroadGraph = Boolean(context.mutationMetadata && (context.mutationMetadata.entryCount >= BREADTH_DRY_RUN_THRESHOLD || context.mutationMetadata.graphCount >= 3 || context.mutationMetadata.linkCount >= 3));
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'graph',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.HIGH,
      riskScore: 0.85,
      decision: isBroadGraph ? MEMORY_MUTATION_GATE_DECISIONS.DRY_RUN_ONLY : MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      // This branch never blocks -- it answers review or dry-run-only -- so its
      // reason must never read ..._BLOCKED. The reason used to be picked by a
      // second, narrower keyword match over the same signal that
      // hasGraphMutation had already matched: an entry that qualified only
      // through entry.linksChanged / tombstoned / superseded, or through a
      // GRAPH_ACTION outside that narrower list ('contradict', 'support',
      // 'reference', 'graph'), produced decision:review with
      // reason:CANONICAL_GRAPH_MUTATION_BLOCKED. Downstream consumers that read
      // the reason -- audit records, the MCP surface, telemetry -- saw a review
      // reported as a block. CANONICAL_GRAPH_MUTATION_BLOCKED still belongs to
      // the destructive-delete branch above, which does block.
      reason: MEMORY_MUTATION_GATE_REASONS.GRAPH_MUTATION_REQUIRES_REVIEW,
      notes: ['Canonical graph-adjacent mutation detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isPackageOrImportMutation(normalized, context)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'package_import',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.6,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.PACKAGE_OR_IMPORT_REQUIRES_REVIEW,
      notes: ['Package/import/sync surface detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isReadOnlyEntry(normalized)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'read_only',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.LOW,
      riskScore: 0.15,
      decision: MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
      reason: MEMORY_MUTATION_GATE_REASONS.LOW_RISK_MEMORY_INSPECTION,
      notes: ['Read-only memory inspection.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (isMetadataOnlyEntry(normalized)) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'metadata',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.LOW,
      riskScore: 0.2,
      decision: MEMORY_MUTATION_GATE_DECISIONS.ALLOW,
      reason: MEMORY_MUTATION_GATE_REASONS.LOW_RISK_METADATA_ONLY,
      notes: ['Metadata-only memory change.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  if (normalized.contentChanged) {
    return {
      ok: true,
      id: normalized.id,
      action: normalized.action,
      changeType: normalized.changeType,
      scope: normalized.scope,
      workspaceId: normalized.workspaceId,
      targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
      category: 'content',
      riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
      riskScore: 0.55,
      decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
      reason: MEMORY_MUTATION_GATE_REASONS.CONTENT_EDIT_REQUIRES_REVIEW,
      notes: ['Memory content edit detected.'],
      sensitive: false,
      contentChanged: normalized.contentChanged,
      linksChanged: normalized.linksChanged,
      auditChanged: normalized.auditChanged,
    };
  }

  return {
    ok: true,
    id: normalized.id,
    action: normalized.action,
    changeType: normalized.changeType,
    scope: normalized.scope,
    workspaceId: normalized.workspaceId,
    targetSpace: context.targetSpace || DEFAULT_WORKSPACE_ID,
    category: 'unknown',
    riskLevel: MEMORY_MUTATION_RISK_LEVELS.MEDIUM,
    riskScore: 0.55,
    decision: MEMORY_MUTATION_GATE_DECISIONS.REVIEW,
    reason: MEMORY_MUTATION_GATE_REASONS.UNKNOWN_OPERATION_TYPE_REVIEW_REQUIRED,
    notes: ['Memory mutation surface could not be safely categorized.'],
    sensitive: false,
    contentChanged: normalized.contentChanged,
    linksChanged: normalized.linksChanged,
    auditChanged: normalized.auditChanged,
  };
}

module.exports = {
  classifyMemoryMutation,
};
