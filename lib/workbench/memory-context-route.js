'use strict';

const { createMemoryContextAuditSource } = require('./memory-context-audit-source');
const { inspectMemoryContext } = require('./memory-context-inspector');

const ROUTE_PREFIX = '/api/workbench/memory-context/';
const MAX_ID_LENGTH = 128;
const CONTROL_CHARACTERS = /[\x00-\x1F\x7F]/;
const INVALID_PATH_CHARACTERS = /[\\/?#]/;

const STATUS_TO_HTTP = Object.freeze({
  ok: 200,
  invalid_request: 400,
  not_found: 404,
  read_error: 502,
});

function invalidRequest(code) {
  return {
    statusCode: 400,
    body: {
      ok: false,
      status: 'invalid_request',
      error: { code },
    },
  };
}

function parseWorkbenchMemoryContextPath(pathname) {
  if (typeof pathname !== 'string' || !pathname.startsWith(ROUTE_PREFIX)) return null;
  const encoded = pathname.slice(ROUTE_PREFIX.length);
  if (!encoded) return { ok: false, code: 'missing_record_id', recordId: '' };

  let decoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch (_error) {
    return { ok: false, code: 'invalid_record_id', recordId: '' };
  }

  if (!decoded || decoded !== decoded.trim() || CONTROL_CHARACTERS.test(decoded)) {
    return { ok: false, code: 'invalid_record_id', recordId: '' };
  }
  if (INVALID_PATH_CHARACTERS.test(decoded)) {
    return { ok: false, code: 'invalid_record_id', recordId: '' };
  }
  if (decoded.length > MAX_ID_LENGTH) {
    return { ok: false, code: 'record_id_too_long', recordId: '' };
  }
  return { ok: true, recordId: decoded };
}

function validateWorkspaceId(workspaceId) {
  if (typeof workspaceId !== 'string' || !workspaceId.trim()) {
    return { ok: false, code: 'missing_workspace_id' };
  }
  if (workspaceId !== workspaceId.trim() || CONTROL_CHARACTERS.test(workspaceId)) {
    return { ok: false, code: 'invalid_workspace_id' };
  }
  if (workspaceId.length > MAX_ID_LENGTH) {
    return { ok: false, code: 'workspace_id_too_long' };
  }
  return { ok: true, workspaceId };
}

function handleWorkbenchMemoryContextRequest(options = {}) {
  const recordId = typeof options.recordId === 'string' ? options.recordId : '';
  if (!recordId) return invalidRequest('missing_record_id');

  const workspace = validateWorkspaceId(options.workspaceId);
  if (!workspace.ok) return invalidRequest(workspace.code);

  const sourceOptions = options.maxAuditEvents === undefined
    ? {}
    : { maxAuditEvents: options.maxAuditEvents };
  const source = createMemoryContextAuditSource(options.auditOwner, sourceOptions);
  const body = inspectMemoryContext({
    recordId,
    workspaceId: workspace.workspaceId,
    source,
  });
  return {
    statusCode: STATUS_TO_HTTP[body.status] || 502,
    body,
  };
}

module.exports = {
  ROUTE_PREFIX,
  parseWorkbenchMemoryContextPath,
  handleWorkbenchMemoryContextRequest,
};
