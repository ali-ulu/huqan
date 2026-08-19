'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { after, before, describe, it } = require('node:test');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-wb2d-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-wb2d-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'graph.json');
process.env.AXIOM_DB_PATH = path.join(tempDir, 'graph.db');
delete process.env.AXIOM_USE_SQLITE;

const server = require('../server');

function admissionOptions(workspaceId, suffix, approved = false) {
  const options = {
    workspaceId,
    provenance: {
      provenanceId: `prov-v4-wb2d-${suffix}`,
      sourceType: 'test',
      sourceRef: `test:v4-wb2d:${suffix}`,
      actor: 'v4-wb2d-smoke',
      workspaceId,
      timestamp: '2026-08-05T17:30:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
  };
  if (approved) {
    options.approvalRequired = true;
    options.approvalStatus = 'approved';
    options.approvalId = `apr-v4-wb2d-${suffix}`;
  }
  return options;
}

function requestJson(port, pathname, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: options.method || 'GET',
      headers: {
        ...(options.auth === false ? {} : { Authorization: `Bearer ${process.env.AXIOM_API_KEY}` }),
        ...(options.origin ? { Origin: options.origin } : {}),
      },
    }, (response) => {
      let text = '';
      response.on('data', (chunk) => { text += chunk; });
      response.on('end', () => {
        try {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: text ? JSON.parse(text) : null,
          });
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on('error', reject);
    request.end();
  });
}

function memoryPath(auditId, workspaceId) {
  return `/api/workbench/memory-context/${encodeURIComponent(auditId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
}

function assertMemoryHeaders(response) {
  assert.equal(response.headers['cache-control'], 'no-store');
  assert.equal(response.headers['x-content-type-options'], 'nosniff');
  assert.match(response.headers['content-type'], /^application\/json/);
}

function snapshot(workspaceId) {
  const graph = server.kernel.graph;
  const nodes = graph.getNodes(workspaceId);
  const edges = Object.keys(nodes)
    .flatMap((nodeId) => graph.getEdges(nodeId, workspaceId))
    .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return JSON.stringify({
    nodes,
    edges,
    audit: graph.getAuditEvents({ workspaceId }),
  });
}

function reviewEvent(workspaceId) {
  const result = server.kernel.learn('kedi hayvandir', admissionOptions(workspaceId, workspaceId));
  assert.equal(result.data.admission.outcome, 'review');
  return server.kernel.graph.getAuditEvents({ workspaceId })
    .find((event) => event.targetType === 'learn');
}

function approvedEvent(workspaceId) {
  const result = server.kernel.learn(
    'kopek memelidir',
    admissionOptions(workspaceId, workspaceId, true),
  );
  assert.equal(result.data.admission.outcome, 'allow');
  const event = server.kernel.graph.getAuditEvents({ workspaceId })
    .find((candidate) => candidate.targetType === 'edge');
  return { event, receipt: result.data.admission.receipt };
}

describe('V4-WB2D: no-mock memory-context route smoke', () => {
  let port;

  before(async () => {
    assert.equal(server.kernel.graph.getStats().backend, 'sqlite');
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeHuqan();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads real review and approved admission evidence through the live server', async () => {
    const review = reviewEvent('wb2d-review');
    const reviewed = await requestJson(port, memoryPath(review.auditId, 'wb2d-review'), {
      origin: 'http://localhost:4173',
    });
    assert.equal(reviewed.status, 200);
    assert.equal(reviewed.body.memoryAdmission.status, 'review_required');
    assert.equal(reviewed.body.memoryAdmission.decision, 'review');
    assert.equal(reviewed.headers['access-control-allow-origin'], 'http://localhost:4173');
    assertMemoryHeaders(reviewed);

    const { event, receipt } = approvedEvent('wb2d-approved');
    const admitted = await requestJson(port, memoryPath(event.auditId, 'wb2d-approved'));
    assert.equal(admitted.status, 200);
    assert.equal(admitted.body.memoryAdmission.status, 'admitted');
    assert.equal(admitted.body.provenance.receiptId, receipt.receiptId);
    assert.deepEqual(admitted.body.contextIntegrity.flags, [
      'workspace_scoped',
      'canonical_mutation',
      'mutation_allowed',
    ]);
    assertMemoryHeaders(admitted);
  });

  it('hardens the unauthenticated 401 emitted by the central auth gate', async () => {
    // The 401 is written by the central route-auth gate in server.js, which
    // returns before the workbench router (and its own header setup) ever
    // runs. Without the headers being carried at that gate, an unauthenticated
    // response to a memory-context path is cacheable and sniffable.
    const event = reviewEvent('wb2d-auth-headers');
    const denied = await requestJson(port, memoryPath(event.auditId, 'wb2d-auth-headers'), { auth: false });

    assert.equal(denied.status, 401);
    assert.equal(denied.headers['www-authenticate'], 'Bearer');
    assert.equal(denied.headers['cache-control'], 'no-store');
    assert.equal(denied.headers['x-content-type-options'], 'nosniff');
  });

  it('rejects authentication, method and malformed identity before any fallback', async () => {
    const event = reviewEvent('wb2d-guards');
    const cases = [
      [memoryPath(event.auditId, 'wb2d-guards'), { auth: false }, 401],
      [memoryPath(event.auditId, 'wb2d-guards'), { method: 'POST' }, 405],
      [`/api/workbench/memory-context/${event.auditId}`, {}, 400],
      [`/api/workbench/memory-context/${event.auditId}?workspaceId=a&workspaceId=b`, {}, 400],
      [`/api/workbench/memory-context/${event.auditId}?workspaceId=`, {}, 400],
      [`/api/workbench/memory-context/${event.auditId}?workspaceId=${encodeURIComponent(' bad')}`, {}, 400],
      [`/api/workbench/memory-context/${event.auditId}?workspaceId=${'w'.repeat(129)}`, {}, 400],
      ['/api/workbench/memory-context/', {}, 400],
      ['/api/workbench/memory-context/%E0%A4%A?workspaceId=wb2d-guards', {}, 400],
      [`/api/workbench/memory-context/${encodeURIComponent('a/b')}?workspaceId=wb2d-guards`, {}, 400],
      [`/api/workbench/memory-context/${'a'.repeat(129)}?workspaceId=wb2d-guards`, {}, 400],
    ];
    for (const [pathname, options, expected] of cases) {
      const response = await requestJson(port, pathname, options);
      assert.equal(response.status, expected, pathname);
      assertMemoryHeaders(response);
    }
  });

  it('fails closed for unknown and cross-workspace reads without mutation', async () => {
    const event = reviewEvent('wb2d-readonly');
    const before = snapshot('wb2d-readonly');
    const unknown = await requestJson(port, memoryPath('missing-audit', 'wb2d-readonly'));
    const cross = await requestJson(port, memoryPath(event.auditId, 'other-workspace'));
    const valid = await requestJson(port, memoryPath(event.auditId, 'wb2d-readonly'));
    const after = snapshot('wb2d-readonly');

    assert.equal(unknown.status, 404);
    assert.equal(cross.status, 404);
    assert.equal(valid.status, 200);
    assert.equal(after, before);
    for (const response of [unknown, cross, valid]) assertMemoryHeaders(response);
  });

  it('serves an exact lookup from a workspace larger than the scan limit (#736)', async () => {
    // Previously this returned 502: the route read the whole workspace history
    // and only then compared its length to maxAuditEvents, so a workspace past
    // 1024 events could not be inspected at all. The lookup is now bounded to
    // the two rows an exact match needs, so history size stops mattering.
    const workspaceId = 'wb2d-over-bound';
    let firstId = '';
    for (let index = 0; index < 1025; index += 1) {
      const event = server.kernel.graph.appendAuditEvent({
        eventType: 'REVIEW',
        targetType: 'learn',
        targetId: `target-${index}`,
        details: { admissionOutcome: 'review', reason: 'approval_pending' },
      }, { workspaceId });
      if (!firstId) firstId = event.auditId;
    }
    const response = await requestJson(port, memoryPath(firstId, workspaceId));
    assert.equal(response.status, 200);
    assert.equal(response.body.memoryAdmission.status, 'review_required');
    assert.equal(response.body.memoryAdmission.decision, 'review');
    assertMemoryHeaders(response);
  });

  it('preserves WB3 and legacy receipt routes', async () => {
    const { receipt } = approvedEvent('wb2d-regression');
    const wb3 = await requestJson(
      port,
      `/api/workbench/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=wb2d-regression`,
    );
    const legacy = await requestJson(
      port,
      `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=wb2d-regression`,
    );
    assert.equal(wb3.status, 200);
    // no-store, not no-cache: the body carries receipt and audit material (#738).
    assert.equal(wb3.headers['cache-control'], 'no-store');
    assert.equal(legacy.status, 200);
    assert.deepEqual(legacy.body.receipt, receipt);
  });
});
