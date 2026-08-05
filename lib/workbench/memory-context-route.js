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

function validateRecordId(recordId) {
  if (typeof recordId !== 'string' || !recordId) {
    return { ok: false, code: 'missing_record_id' };
  }
  if (
    recordId !== recordId.trim()
    || CONTROL_CHARACTERS.test(recordId)
    || INVALID_PATH_CHARACTERS.test(recordId)
  ) {
    return { ok: false, code: 'invalid_record_id' };
  }
  if (recordId.length > MAX_ID_LENGTH) {
    return { ok: false, code: 'record_id_too_long' };
  }
  return { ok: true, recordId };
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

  const validation = validateRecordId(decoded);
  return validation.ok
    ? { ok: true, recordId: validation.recordId }
    : { ok: false, code: validation.code, recordId: '' };
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
  const record = validateRecordId(options.recordId);
  if (!record.ok) return invalidRequest(record.code);

  const workspace = validateWorkspaceId(options.workspaceId);
  if (!workspace.ok) return invalidRequest(workspace.code);

  const sourceOptions = options.maxAuditEvents === undefined
    ? {}
    : { maxAuditEvents: options.maxAuditEvents };
  const source = createMemoryContextAuditSource(options.auditOwner, sourceOptions);
  const body = inspectMemoryContext({
    recordId: record.recordId,
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
