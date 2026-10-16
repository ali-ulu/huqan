'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  ROUTE_PREFIX,
  parseWorkbenchMemoryContextPath,
  handleWorkbenchMemoryContextRequest,
} = require('../lib/workbench/memory-context-route');

function event(overrides = {}) {
  return {
    auditId: 'audit-1',
    eventType: 'REVIEW',
    targetType: 'learn',
    targetId: 'target-1',
    workspaceId: 'workspace-1',
    actor: 'test',
    timestamp: '2026-08-05T00:00:00.000Z',
    sourceRef: 'private-source-ref',
    provenanceId: 'private-provenance-id',
    trustPolicyVersion: '1.0.0',
    details: {
      admissionOutcome: 'review',
      reason: 'approval_pending',
      receiptId: 'receipt-1',
      receipt: {
        receiptId: 'receipt-1',
        decision: 'review',
        reason: 'approval_pending',
        secret: 'must-not-leak',
      },
    },
    ...overrides,
  };
}

function owner(events, onRead = null) {
  return {
    getAuditEvents(filters) {
      onRead?.(filters);
      return events.filter((item) => item.workspaceId === filters.workspaceId);
    },
  };
}

test('exports only the bounded route contract', () => {
  const route = require('../lib/workbench/memory-context-route');
  assert.deepEqual(Object.keys(route).sort(), [
    'ROUTE_PREFIX',
    'handleWorkbenchMemoryContextRequest',
    'parseWorkbenchMemoryContextPath',
  ]);
  assert.equal(ROUTE_PREFIX, '/api/workbench/memory-context/');
});

test('parses one exact audit id and ignores non-matching paths', () => {
  assert.deepEqual(
    parseWorkbenchMemoryContextPath(`${ROUTE_PREFIX}audit-123`),
    { ok: true, recordId: 'audit-123' },
  );
  assert.equal(parseWorkbenchMemoryContextPath('/api/workbench/trust-receipt/audit-123'), null);
  assert.equal(parseWorkbenchMemoryContextPath(null), null);
});

test('rejects missing, malformed, ambiguous and oversized path identity', () => {
  assert.equal(parseWorkbenchMemoryContextPath(ROUTE_PREFIX).code, 'missing_record_id');
  assert.equal(parseWorkbenchMemoryContextPath(`${ROUTE_PREFIX}%E0%A4%A`).code, 'invalid_record_id');
  assert.equal(parseWorkbenchMemoryContextPath(`${ROUTE_PREFIX}%00audit`).code, 'invalid_record_id');
  for (const value of ['a/b', 'a\\b', 'a?b', 'a#b', ' audit', 'audit ']) {
    assert.equal(
      parseWorkbenchMemoryContextPath(`${ROUTE_PREFIX}${encodeURIComponent(value)}`).code,
      'invalid_record_id',
    );
  }
  assert.equal(parseWorkbenchMemoryContextPath(`${ROUTE_PREFIX}${'a'.repeat(128)}`).ok, true);
  assert.equal(
    parseWorkbenchMemoryContextPath(`${ROUTE_PREFIX}${'a'.repeat(129)}`).code,
    'record_id_too_long',
  );
});

test('requires exact explicit workspace authority before reading', () => {
  let reads = 0;
  const auditOwner = owner([], () => { reads += 1; });
  for (const workspaceId of [undefined, '', '   ']) {
    const result = handleWorkbenchMemoryContextRequest({ recordId: 'audit-1', workspaceId, auditOwner });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'missing_workspace_id');
  }
  for (const workspaceId of [' workspace-1', 'workspace-1 ', 'workspace\u0000']) {
    const result = handleWorkbenchMemoryContextRequest({ recordId: 'audit-1', workspaceId, auditOwner });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, 'invalid_workspace_id');
  }
  const oversized = handleWorkbenchMemoryContextRequest({
    recordId: 'audit-1',
    workspaceId: 'w'.repeat(129),
    auditOwner,
  });
  assert.equal(oversized.statusCode, 400);
  assert.equal(oversized.body.error.code, 'workspace_id_too_long');
  assert.equal(reads, 0);
});

test('validates direct handler record identity before reading', () => {
  let reads = 0;
  const auditOwner = owner([], () => { reads += 1; });
  const cases = [
    ['', 'missing_record_id'],
    [' audit-1', 'invalid_record_id'],
    ['audit/1', 'invalid_record_id'],
    ['a'.repeat(129), 'record_id_too_long'],
  ];
  for (const [recordId, code] of cases) {
    const result = handleWorkbenchMemoryContextRequest({
      recordId,
      workspaceId: 'workspace-1',
      auditOwner,
    });
    assert.equal(result.statusCode, 400);
    assert.equal(result.body.error.code, code);
  }
  assert.equal(reads, 0);
});

test('maps a source-backed record through adapter and inspector to 200', () => {
  let seenFilters;
  const options = Object.freeze({
    recordId: 'audit-1',
    workspaceId: 'workspace-1',
    auditOwner: owner([event()], (filters) => { seenFilters = filters; }),
  });
  const result = handleWorkbenchMemoryContextRequest(options);

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ok, true);
  assert.equal(result.body.status, 'ok');
  assert.equal(result.body.memoryAdmission.status, 'review_required');
  assert.equal(result.body.memoryAdmission.decision, 'review');
  assert.equal(result.body.provenance.workspaceId, 'workspace-1');
  assert.equal(result.body.provenance.receiptId, 'receipt-1');
  assert.equal(result.body.provenance.traceId, null);
  // The record id is pushed into the filter now, so the owner reads the one
  // matching row instead of the whole workspace history (#736).
  assert.deepEqual(seenFilters, { workspaceId: 'workspace-1', auditId: 'audit-1' });
  assert.equal(JSON.stringify(result.body).includes('must-not-leak'), false);
  assert.equal(JSON.stringify(result.body).includes('private-source-ref'), false);
  assert.equal(JSON.stringify(result.body).includes('private-provenance-id'), false);
});

test('unknown and cross-workspace identity map to 404 without fallback', () => {
  const auditOwner = owner([event()]);
  const unknown = handleWorkbenchMemoryContextRequest({
    recordId: 'missing', workspaceId: 'workspace-1', auditOwner,
  });
  const crossWorkspace = handleWorkbenchMemoryContextRequest({
    recordId: 'audit-1', workspaceId: 'workspace-2', auditOwner,
  });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.body.status, 'not_found');
  assert.equal(crossWorkspace.statusCode, 404);
  assert.equal(crossWorkspace.body.status, 'not_found');
});

test('malformed and throwing read owners map through inspector to 502', () => {
  const malformed = handleWorkbenchMemoryContextRequest({
    recordId: 'audit-1',
    workspaceId: 'workspace-1',
    auditOwner: { getAuditEvents() { return {}; } },
  });
  const throwing = handleWorkbenchMemoryContextRequest({
    recordId: 'audit-1',
    workspaceId: 'workspace-1',
    auditOwner: { getAuditEvents() { throw new Error('boom'); } },
  });
  assert.equal(malformed.statusCode, 502);
  assert.equal(malformed.body.status, 'read_error');
  assert.equal(throwing.statusCode, 502);
  assert.equal(throwing.body.status, 'read_error');
});

test('bounded adapter options cannot exceed 1024', () => {
  assert.throws(
    () => handleWorkbenchMemoryContextRequest({
      recordId: 'audit-1',
      workspaceId: 'workspace-1',
      auditOwner: owner([]),
      maxAuditEvents: 1025,
    }),
    (error) => error?.code === 'INVALID_AUDIT_SCAN_LIMIT',
  );
});
