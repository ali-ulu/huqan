'use strict';

const {
  READ_ACTIONS,
  NOTE_ACTIONS,
  AUDIT_ACTIONS,
  RELEASE_ACTIONS,
  AUTO_ACTIONS,
  PACKAGE_ACTIONS,
  GRAPH_ACTIONS,
  DELETE_ACTIONS,
  DEFAULT_WORKSPACE_ID,
} = require('./memory-mutation-vocabulary');
const { containsAny, isSecretLikeValue, isPlainObject, firstText } = require('./memory-mutation-normalizer');
const { normalizeText } = require('../text-utils');

function isReadOnlyEntry(entry) {
  const signal = [entry.action, entry.changeType].filter(Boolean).join(' ');
  return containsAny(signal, READ_ACTIONS) && !entry.contentChanged && !entry.linksChanged && !entry.auditChanged && !entry.deleted && !entry.tombstoned && !entry.superseded;
}

function isMetadataOnlyEntry(entry) {
  const signal = [entry.action, entry.changeType].filter(Boolean).join(' ');
  return containsAny(signal, NOTE_ACTIONS) || entry.metadataOnly;
}

function isAuditMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return containsAny(signal, AUDIT_ACTIONS) && (containsAny(signal, ['rewrite', 'delete']) || entry.auditChanged);
}

function isCrossWorkspaceEntry(entry, context) {
  const targetSpace = normalizeText(context.targetSpace || (context.metadata && context.metadata.workspaceId) || DEFAULT_WORKSPACE_ID);
  // #378: normalizeEntry()'s workspaceId/scope already fall back to
  // context.targetSpace when the raw entry declares none, so comparing
  // entry.workspaceId against targetSpace here always agreed with itself for
  // an entry that never stated a workspace -- silently bypassing the
  // cross-workspace check. Compare against what the entry itself actually
  // declared (entry.raw), not the post-fallback value.
  const rawEntry = isPlainObject(entry.raw) ? entry.raw : {};
  const declaredEntrySpace = normalizeText(firstText(rawEntry.workspaceId, rawEntry.workspace, rawEntry.targetSpace, rawEntry.scope, ''));
  if (!declaredEntrySpace) return false;
  return Boolean(targetSpace && declaredEntrySpace !== targetSpace);
}

function isReleaseOrAutoMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return containsAny(signal, RELEASE_ACTIONS) || containsAny(signal, AUTO_ACTIONS);
}

function isPackageOrImportMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return containsAny(signal, PACKAGE_ACTIONS);
}

function isSecretMutation(entry, context) {
  return isSecretLikeValue({
    id: entry.id,
    action: entry.action,
    changeType: entry.changeType,
    scope: entry.scope,
    workspaceId: entry.workspaceId,
    diffSummary: context.diffSummary,
    mutationMetadata: context.mutationMetadata,
  });
}

function hasGraphMutation(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return entry.linksChanged || entry.tombstoned || entry.superseded || containsAny(signal, GRAPH_ACTIONS);
}

function isDestructiveDelete(entry, context) {
  const signal = [entry.action, entry.changeType, context.operationType, context.mutationType, context.diffSummary].filter(Boolean).join(' ');
  return entry.deleted || containsAny(signal, DELETE_ACTIONS);
}

module.exports = {
  isReadOnlyEntry,
  isMetadataOnlyEntry,
  isAuditMutation,
  isCrossWorkspaceEntry,
  isReleaseOrAutoMutation,
  isPackageOrImportMutation,
  isSecretMutation,
  hasGraphMutation,
  isDestructiveDelete,
};
