'use strict';

const DEFAULT_WORKSPACE_ID = 'default';
const MAX_WORKSPACE_ID_LENGTH = 128;
const WORKSPACE_ID_INVALID = 'WORKSPACE_ID_INVALID';

function workspaceIdError(message, options = {}) {
  const error = new TypeError(message);
  error.code = options.errorCode || WORKSPACE_ID_INVALID;
  return error;
}

/**
 * Canonical workspace boundary normalization.
 *
 * Missing and blank identifiers preserve the established default workspace.
 * Any supplied non-string identifier is rejected instead of being coerced or
 * silently redirected into a different workspace.
 */
function normalizeWorkspaceId(value, options = {}) {
  const normalizedOptions = typeof options === 'string'
    ? { fallback: options }
    : (options && typeof options === 'object' ? options : {});
  const fallback = normalizedOptions.fallback ?? DEFAULT_WORKSPACE_ID;
  const required = normalizedOptions.required === true;
  const maxLength = normalizedOptions.maxLength ?? MAX_WORKSPACE_ID_LENGTH;
  const errorMessage = normalizedOptions.errorMessage;

  if (value === undefined || value === null || value === '') {
    if (required) throw workspaceIdError(errorMessage || 'workspaceId is required', normalizedOptions);
    return fallback;
  }
  if (typeof value !== 'string') {
    throw workspaceIdError(errorMessage || 'workspaceId must be a string', normalizedOptions);
  }

  const workspaceId = value.trim();
  if (!workspaceId) {
    if (required) throw workspaceIdError(errorMessage || 'workspaceId is required', normalizedOptions);
    return fallback;
  }
  if (!Number.isInteger(maxLength) || maxLength < 1 || workspaceId.length > maxLength) {
    throw workspaceIdError(errorMessage || `workspaceId must be at most ${maxLength} characters`, normalizedOptions);
  }
  return workspaceId;
}

/**
 * Read-side counterpart for records already held in a store: true iff the
 * record's workspace id names `workspaceId`. A missing or blank id belongs to
 * the default workspace, as on the write side. An id the canonical helper
 * would reject belongs to no workspace, so a malformed record is excluded from
 * every scope instead of leaking into the default one, and one bad record
 * cannot fail the whole read (#4032).
 */
function isRecordInWorkspace(recordWorkspaceId, workspaceId) {
  try {
    return normalizeWorkspaceId(recordWorkspaceId) === workspaceId;
  } catch {
    return false;
  }
}

module.exports = {
  DEFAULT_WORKSPACE_ID,
  MAX_WORKSPACE_ID_LENGTH,
  WORKSPACE_ID_INVALID,
  isRecordInWorkspace,
  normalizeWorkspaceId,
};
