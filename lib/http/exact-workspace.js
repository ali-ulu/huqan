'use strict';

function readExactWorkspace(searchParams) {
  if (!searchParams || typeof searchParams.getAll !== 'function') {
    return { ok: false, code: 'MISSING_WORKSPACE_ID' };
  }
  const values = searchParams.getAll('workspaceId');
  if (values.length !== 1) {
    return { ok: false, code: values.length ? 'INVALID_WORKSPACE_ID' : 'MISSING_WORKSPACE_ID' };
  }
  const workspaceId = typeof values[0] === 'string' ? values[0].trim() : '';
  if (!workspaceId || workspaceId !== values[0] || workspaceId.length > 128 || /[\x00-\x1F\x7F]/.test(workspaceId)) {
    return { ok: false, code: 'INVALID_WORKSPACE_ID' };
  }
  return { ok: true, workspaceId };
}

module.exports = { readExactWorkspace };
