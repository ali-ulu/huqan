'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-pr3-api-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-pr3-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
process.env.AXIOM_USE_SQLITE = 'false';

const server = require('../server');

function approvedAdmissionOpts(workspaceId, overrides = {}) {
  return {
    workspaceId,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: overrides.approvalId || `apr-v4-pr3-${Math.random().toString(36).slice(2, 8)}`,
    provenance: {
      provenanceId: overrides.provenanceId || `prov-v4-pr3-${Math.random().toString(36).slice(2, 8)}`,
      sourceType: 'test',
      sourceRef: 'test:v4-pr3-api',
      actor: 'receipt-api-test',
      workspaceId,
      timestamp: overrides.timestamp || new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  };
}

function requestJson(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const body = opts.body === undefined
      ? undefined
      : (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body));
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: opts.method || 'GET',
      headers: {
        Authorization: `Bearer ${process.env.AXIOM_API_KEY}`,
        ...(body ? {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        } : {}),
        ...(opts.headers || {}),
      },
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body || '');
  });
}

async function seedReceipt(port, text, workspaceId, overrides = {}) {
  const response = await requestJson(port, `/yukle?workspaceId=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    body: {
      text,
      ...approvedAdmissionOpts(workspaceId, overrides),
    },
  });
  assert.equal(response.status, 200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.admission?.outcome, 'allow');
  assert.ok(response.body.admission?.receipt);
  return response.body.admission.receipt;
}

describe('V4-PR3: read-only Trust Receipt API surface', () => {
  let port;

  before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeAxiom();
  });

  it('returns a stored/materialized receipt by valid receiptId', async () => {
    const workspaceId = 'v4-pr3-api-valid';
    const receipt = await seedReceipt(port, 'turna kustur', workspaceId, { provenanceId: 'prov-v4-pr3-valid' });

    const response = await requestJson(
      port,
      `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.receipt, receipt);
  });

  it('finds a non-default workspace receipt by receiptId when no workspaceId filter is supplied', async () => {
    const workspaceId = 'v4-pr3-api-no-query';
    const receipt = await seedReceipt(port, 'saka kustur', workspaceId, { provenanceId: 'prov-v4-pr3-no-query' });

    const response = await requestJson(
      port,
      `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.receipt, receipt);
  });

  it('fails closed when an explicit workspaceId does not match the stored receipt workspace', async () => {
    const workspaceId = 'v4-pr3-api-right-workspace';
    const receipt = await seedReceipt(port, 'kumru kustur', workspaceId, { provenanceId: 'prov-v4-pr3-wrong-query' });

    const response = await requestJson(
      port,
      `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=v4-pr3-api-wrong-workspace`,
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'receipt_not_found');
    assert.equal(response.body.receipt, undefined);
  });

  it('fails closed for unknown receiptId without synthesizing a receipt', async () => {
    const workspaceId = 'v4-pr3-api-unknown';
    await seedReceipt(port, 'pelikan kustur', workspaceId, { provenanceId: 'prov-v4-pr3-unknown' });
    const beforeGraph = await requestJson(port, `/graph-data?workspaceId=${encodeURIComponent(workspaceId)}`);

    const response = await requestJson(
      port,
      `/api/trust-receipt/missing-receipt-id?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    const afterGraph = await requestJson(port, `/graph-data?workspaceId=${encodeURIComponent(workspaceId)}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.error.code, 'receipt_not_found');
    assert.equal(response.body.receipt, undefined);
    assert.deepEqual(afterGraph.body, beforeGraph.body);
  });

  it('fails closed for missing, empty, and whitespace receiptId', async () => {
    const missing = await requestJson(port, '/api/trust-receipt/');
    assert.equal(missing.status, 400);
    assert.equal(missing.body.ok, false);
    assert.equal(missing.body.error.code, 'missing_receipt_id');

    const whitespace = await requestJson(port, '/api/trust-receipt/%20%20%20');
    assert.equal(whitespace.status, 400);
    assert.equal(whitespace.body.ok, false);
    assert.equal(whitespace.body.error.code, 'invalid_receipt_id');

    const malformed = await requestJson(port, '/api/trust-receipt/%E0%A4%A');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.ok, false);
    assert.equal(malformed.body.error.code, 'invalid_receipt_id');
  });

  it('response mutation cannot mutate the stored receipt', async () => {
    const workspaceId = 'v4-pr3-api-clone';
    const receipt = await seedReceipt(port, 'marti kustur', workspaceId, { provenanceId: 'prov-v4-pr3-clone' });
    const pathWithId = `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=${encodeURIComponent(workspaceId)}`;

    const first = await requestJson(port, pathWithId);
    first.body.receipt.reason = 'client-side mutation';
    const second = await requestJson(port, pathWithId);

    assert.equal(second.status, 200);
    assert.notEqual(second.body.receipt.reason, 'client-side mutation');
    assert.deepEqual(second.body.receipt, receipt);
  });

  it('read API does not append audit events or mutate graph state', async () => {
    const workspaceId = 'v4-pr3-api-readonly';
    const receipt = await seedReceipt(port, 'leylek kustur', workspaceId, { provenanceId: 'prov-v4-pr3-readonly' });
    const beforeGraph = await requestJson(port, `/graph-data?workspaceId=${encodeURIComponent(workspaceId)}`);

    const response = await requestJson(
      port,
      `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );

    const afterGraph = await requestJson(port, `/graph-data?workspaceId=${encodeURIComponent(workspaceId)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(afterGraph.body, beforeGraph.body);
  });

  it('keeps existing health, status, and graph-data routes available', async () => {
    const health = await requestJson(port, '/health', { headers: {} });
    assert.equal(health.status, 200);
    assert.equal(health.body.ok, true);
    assert.equal(health.body.service, 'axiom');

    const status = await requestJson(port, '/v2-status', { headers: {} });
    assert.equal(status.status, 200);
    assert.equal(status.body.ok, true);
    assert.ok(Array.isArray(status.body.phases));
    assert.ok(status.body.currentFocus);

    const graph = await requestJson(port, '/graph-data', { headers: {} });
    assert.equal(graph.status, 200);
    assert.ok(Array.isArray(graph.body.nodes));
    assert.ok(Array.isArray(graph.body.links) || Array.isArray(graph.body.edges));
  });
});
