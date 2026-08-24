'use strict';

const ROLE_PERMISSIONS = Object.freeze({
  viewer: Object.freeze(['read', 'stream']),
  operator: Object.freeze(['read', 'stream', 'queue:write']),
  admin: Object.freeze(['read', 'stream', 'queue:write', 'alerts:write']),
});

function parsePolicy(raw) {
  let source;
  try { source = JSON.parse(String(raw || '')); } catch (_) { source = null; }
  if (!source || typeof source !== 'object' || Array.isArray(source)
      || Object.keys(source).some(key => key !== 'memberships')
      || !Array.isArray(source.memberships) || source.memberships.length > 1000) {
    const error = new Error('Observability authorization policy is invalid.');
    error.code = 'OBSERVABILITY_AUTHZ_POLICY_INVALID';
    throw error;
  }
  const seen = new Set();
  const memberships = source.memberships.map(entry => {
    const exact = entry && typeof entry === 'object' && !Array.isArray(entry)
      && Object.keys(entry).every(key => ['subject', 'workspaceId', 'role'].includes(key));
    const subject = exact && typeof entry.subject === 'string' ? entry.subject.trim() : '';
    const workspaceId = exact && typeof entry.workspaceId === 'string' ? entry.workspaceId.trim() : '';
    const role = exact && typeof entry.role === 'string' ? entry.role.trim() : '';
    if (!subject || subject.length > 128 || !workspaceId || workspaceId.length > 128
        || subject === '*' || workspaceId === '*' || !ROLE_PERMISSIONS[role]
        || /[\x00-\x1F\x7F]/.test(subject + workspaceId)) {
      const error = new Error('Observability membership is invalid.');
      error.code = 'OBSERVABILITY_AUTHZ_POLICY_INVALID';
      throw error;
    }
    const key = `${subject}\0${workspaceId}`;
    if (seen.has(key)) {
      const error = new Error('Observability membership is ambiguous.');
      error.code = 'OBSERVABILITY_AUTHZ_POLICY_INVALID';
      throw error;
    }
    seen.add(key);
    return Object.freeze({ subject, workspaceId, role });
  });
  return Object.freeze(memberships);
}

function createObservabilityAuthorizer({ policy } = {}) {
  const memberships = parsePolicy(policy);
  return Object.freeze({
    authorize({ principal, workspaceId, permission } = {}) {
      const subject = typeof principal?.subject === 'string' ? principal.subject.trim() : '';
      const workspace = typeof workspaceId === 'string' ? workspaceId.trim() : '';
      if (!subject) return Object.freeze({ allowed: false, code: 'OBSERVABILITY_PRINCIPAL_REQUIRED' });
      if (!workspace) return Object.freeze({ allowed: false, code: 'OBSERVABILITY_WORKSPACE_REQUIRED' });
      const membership = memberships.find(item => item.subject === subject && item.workspaceId === workspace);
      if (!membership) return Object.freeze({ allowed: false, code: 'OBSERVABILITY_WORKSPACE_FORBIDDEN' });
      if (!ROLE_PERMISSIONS[membership.role].includes(permission)) {
        return Object.freeze({ allowed: false, code: 'OBSERVABILITY_PERMISSION_FORBIDDEN' });
      }
      return Object.freeze({ allowed: true, code: 'OBSERVABILITY_AUTHORIZED', role: membership.role });
    },
  });
}

module.exports = { ROLE_PERMISSIONS, createObservabilityAuthorizer, parsePolicy };
