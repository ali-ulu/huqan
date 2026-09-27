'use strict';

/**
 * Workspace boundary normalization for AgentV3's plan() and run(), mirroring
 * lib/workspace-id.js: missing/blank keeps the default workspace, a string is
 * trimmed, and any other type is rejected rather than coerced. Storage
 * enforces the same rule, so letting a raw value through would surface as a
 * TypeError from deep inside the store instead of a structured failure.
 */

function normalizeAgentV3WorkspaceId(workspaceId) {
  if (workspaceId === undefined || workspaceId === null || workspaceId === '') {
    return { ok: true, workspaceId: 'default' };
  }
  if (typeof workspaceId !== 'string') {
    return { ok: false, message: 'workspaceId must be a string.' };
  }
  return { ok: true, workspaceId: workspaceId.trim() || 'default' };
}

module.exports = { normalizeAgentV3WorkspaceId };
