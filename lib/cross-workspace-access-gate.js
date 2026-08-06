'use strict';

/**
 * AB11 — Cross-Workspace Access Gate.
 *
 * The graph already *stores* nodes and edges under a workspace scope
 * (`nodeStorageKey` in graph.js), and `memory-admission-gate` (AB4) checks a
 * single target workspace. Neither of them answers the tenant-isolation
 * question this gate exists for: an actor operating in workspace A is
 * reaching into workspace B -- should that be allowed at all?
 *
 * Deliberately pure: it takes two workspace identifiers, an operation, and an
 * explicit grant list, and returns a decision. It reads and writes nothing.
 *
 * Two design points worth stating, because both are places a subtle bypass
 * would otherwise live:
 *
 * 1. **Comparison matches storage exactly** -- `trim()` only, and
 *    case-sensitive. graph.js's `normalizeWorkspaceId` trims without lowering,
 *    so 'ws-a' and 'WS-A' are genuinely different storage scopes. A gate that
 *    compared case-insensitively would call them the same workspace and wave
 *    through an access that storage treats as crossing a boundary.
 *
 * 2. **A missing workspace is refused, not defaulted.** Storage falls back to
 *    'default' when no workspace is given, but a gate must not: defaulting an
 *    unidentified actor to 'default' would hand it the default workspace's
 *    data. Callers that mean 'default' can say so. This is deliberately
 *    stricter than the storage layer's implicit fallback.
 */

const AB11_GATE_VERSION = 'AB11-v0.1.0';

const CROSS_WORKSPACE_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  REVIEW: 'review',
  BLOCK: 'block',
});

const CROSS_WORKSPACE_REASONS = Object.freeze({
  SAME_WORKSPACE: 'same_workspace',
  WORKSPACE_REQUIRED: 'workspace_required',
  UNKNOWN_OPERATION: 'unknown_operation',
  CROSS_WORKSPACE_DENIED: 'cross_workspace_denied',
  CROSS_WORKSPACE_READ_GRANTED: 'cross_workspace_read_granted',
  CROSS_WORKSPACE_WRITE_REVIEW: 'cross_workspace_write_requires_review',
});

const READ_OPERATIONS = Object.freeze(['read', 'get', 'list', 'query', 'search', 'inspect', 'verify']);
const WRITE_OPERATIONS = Object.freeze(['write', 'create', 'update', 'learn', 'delete', 'remove', 'mutate']);

/**
 * Matches graph.js `normalizeWorkspaceId`: trim, no case folding. Returns ''
 * for anything that is not a usable identifier, so the caller can refuse it
 * rather than silently substituting a default.
 */
function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeOperation(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function classifyOperation(operation) {
  if (READ_OPERATIONS.includes(operation)) return 'read';
  if (WRITE_OPERATIONS.includes(operation)) return 'write';
  return '';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Finds a grant permitting `actor -> target` for `operationKind`.
 *
 * Grants are explicit workspace pairs. There is intentionally no wildcard: a
 * wildcard grant in a tenant-isolation gate is a standing hole, and nothing
 * in this codebase needs one yet.
 */
function findGrant(grants, actorWorkspaceId, targetWorkspaceId, operationKind) {
  if (!Array.isArray(grants)) return null;

  return grants.find((grant) => {
    if (!isPlainObject(grant)) return false;
    if (normalizeWorkspaceId(grant.fromWorkspaceId) !== actorWorkspaceId) return false;
    if (normalizeWorkspaceId(grant.toWorkspaceId) !== targetWorkspaceId) return false;
    if (!Array.isArray(grant.operations)) return false;
    return grant.operations
      .map((op) => classifyOperation(normalizeOperation(op)))
      .includes(operationKind);
  }) || null;
}

/**
 * Decides whether an actor in one workspace may touch another.
 *
 * @param {object} input
 * @param {string} input.actorWorkspaceId workspace the caller operates in
 * @param {string} input.targetWorkspaceId workspace being read or written
 * @param {string} input.operation e.g. 'read', 'learn', 'delete'
 * @param {object[]} [input.grants] explicit {fromWorkspaceId, toWorkspaceId, operations}
 * @param {string} [input.resourceType] recorded for audit only
 * @returns {{decision: string, reason: string, crossWorkspace: boolean, operationKind: string, gateVersion: string}}
 */
function evaluateCrossWorkspaceAccess(input = {}) {
  const source = isPlainObject(input) ? input : {};
  const actorWorkspaceId = normalizeWorkspaceId(source.actorWorkspaceId);
  const targetWorkspaceId = normalizeWorkspaceId(source.targetWorkspaceId);
  const operation = normalizeOperation(source.operation);
  const operationKind = classifyOperation(operation);
  const resourceType = typeof source.resourceType === 'string' ? source.resourceType.trim() : '';

  const base = {
    actorWorkspaceId,
    targetWorkspaceId,
    operation,
    operationKind,
    resourceType,
    gateVersion: AB11_GATE_VERSION,
  };

  // Cannot verify isolation without knowing both sides.
  if (!actorWorkspaceId || !targetWorkspaceId) {
    return build(CROSS_WORKSPACE_DECISIONS.BLOCK, CROSS_WORKSPACE_REASONS.WORKSPACE_REQUIRED, base, false);
  }

  // An operation this gate cannot classify might be a write; refuse it rather
  // than guess it is harmless.
  if (!operationKind) {
    return build(CROSS_WORKSPACE_DECISIONS.BLOCK, CROSS_WORKSPACE_REASONS.UNKNOWN_OPERATION, base, false);
  }

  if (actorWorkspaceId === targetWorkspaceId) {
    return build(CROSS_WORKSPACE_DECISIONS.ALLOW, CROSS_WORKSPACE_REASONS.SAME_WORKSPACE, base, false);
  }

  const grant = findGrant(source.grants, actorWorkspaceId, targetWorkspaceId, operationKind);
  if (!grant) {
    return build(CROSS_WORKSPACE_DECISIONS.BLOCK, CROSS_WORKSPACE_REASONS.CROSS_WORKSPACE_DENIED, base, true);
  }

  // A granted cross-workspace read is allowed outright; a granted write still
  // needs a human, because a grant says the boundary may be crossed, not that
  // any particular mutation across it is intended.
  if (operationKind === 'write') {
    return build(CROSS_WORKSPACE_DECISIONS.REVIEW, CROSS_WORKSPACE_REASONS.CROSS_WORKSPACE_WRITE_REVIEW, base, true);
  }

  return build(CROSS_WORKSPACE_DECISIONS.ALLOW, CROSS_WORKSPACE_REASONS.CROSS_WORKSPACE_READ_GRANTED, base, true);
}

function build(decision, reason, base, crossWorkspace) {
  return {
    ok: true,
    decision,
    reason,
    allowed: decision === CROSS_WORKSPACE_DECISIONS.ALLOW,
    crossWorkspace,
    ...base,
  };
}

module.exports = {
  AB11_GATE_VERSION,
  CROSS_WORKSPACE_DECISIONS,
  CROSS_WORKSPACE_REASONS,
  READ_OPERATIONS,
  WRITE_OPERATIONS,
  classifyOperation,
  evaluateCrossWorkspaceAccess,
};
