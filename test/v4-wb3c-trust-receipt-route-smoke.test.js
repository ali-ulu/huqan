'use strict';

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-v4-wb3c-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'v4-wb3c-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
process.env.AXIOM_USE_SQLITE = 'false';

const server = require('../server');

function approvedAdmissionOpts(workspaceId, overrides = {}) {
  return {
    workspaceId,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: overrides.approvalId || `apr-v4-wb3c-${Math.random().toString(36).slice(2, 8)}`,
    provenance: {
      provenanceId: overrides.provenanceId || `prov-v4-wb3c-${Math.random().toString(36).slice(2, 8)}`,
      sourceType: 'test',
      sourceRef: 'test:v4-wb3c-workbench-smoke',
      actor: 'workbench-route-smoke-test',
      workspaceId,
      timestamp: overrides.timestamp || new Date().toISOString(),
      trustPolicyVersion: '1.0.0',
    },
  };
}

function requestJson(port, pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method: opts.method || 'GET',
      headers: {
        ...(opts.auth === false ? {} : { Authorization: `Bearer ${process.env.AXIOM_API_KEY}` }),
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
    req.end();
  });
}

async function seedReceipt(text, workspaceId, overrides = {}) {
  const result = server.kernel.learn(text, approvedAdmissionOpts(workspaceId, overrides));
  assert.equal(result.data?.admission?.outcome, 'allow');
  assert.ok(result.data?.admission?.receipt);
  return result.data.admission.receipt;
}

describe('V4-WB3C: no-mock workbench trust receipt route smoke (real server.js)', () => {
  let port;

  before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeAxiom();
  });

  it('reads a real receipt through the WB1 inspector via the live route', async () => {
    const workspaceId = 'v4-wb3c-valid';
    const receipt = await seedReceipt('kirlangic kustur', workspaceId, { provenanceId: 'prov-v4-wb3c-valid' });

    const response = await requestJson(
      port,
      `/api/workbench/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.status, 'found');
    assert.equal(response.body.receiptId, receipt.receiptId);
    assert.equal(response.body.workspaceId, workspaceId);
    assert.equal(response.body.source.readOnly, true);
  });

  it('rejects unauthenticated requests before the inspector runs', async () => {
    const response = await requestJson(port, '/api/workbench/trust-receipt/anything', { auth: false });
    assert.equal(response.status, 401);
  });

  it('fails closed for an unknown receiptId without synthesizing data', async () => {
    const workspaceId = 'v4-wb3c-unknown';
    await seedReceipt('bulbul kustur', workspaceId, { provenanceId: 'prov-v4-wb3c-unknown' });

    const response = await requestJson(port, `/api/workbench/trust-receipt/does-not-exist?workspaceId=${encodeURIComponent(workspaceId)}`);

    assert.equal(response.status, 404);
    assert.equal(response.body.ok, false);
    assert.equal(response.body.status, 'not_found');
  });

  it('fails closed for a missing receiptId', async () => {
    const response = await requestJson(port, '/api/workbench/trust-receipt/');
    assert.equal(response.status, 400);
    assert.equal(response.body.status, 'invalid_request');
  });

  it('fails closed when the workspaceId filter does not match the stored receipt', async () => {
    const workspaceId = 'v4-wb3c-wrong-ws';
    const receipt = await seedReceipt('saksagan kustur', workspaceId, { provenanceId: 'prov-v4-wb3c-wrong-ws' });

    const response = await requestJson(
      port,
      `/api/workbench/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=some-other-workspace`,
    );

    assert.equal(response.status, 404);
    assert.equal(response.body.status, 'not_found');
  });

  it('does not mutate graph state as a side effect of reading', async () => {
    const workspaceId = 'v4-wb3c-readonly';
    const receipt = await seedReceipt('flamingo kustur', workspaceId, { provenanceId: 'prov-v4-wb3c-readonly' });
    const before = await requestJson(port, `/graph-data?workspaceId=${encodeURIComponent(workspaceId)}`);

    await requestJson(
      port,
      `/api/workbench/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );

    const after = await requestJson(port, `/graph-data?workspaceId=${encodeURIComponent(workspaceId)}`);
    assert.deepEqual(after.body, before.body);
  });

  it('still serves the original /api/trust-receipt route unchanged', async () => {
    const workspaceId = 'v4-wb3c-legacy-route';
    const receipt = await seedReceipt('leylek kustur', workspaceId, { provenanceId: 'prov-v4-wb3c-legacy' });

    const response = await requestJson(
      port,
      `/api/trust-receipt/${encodeURIComponent(receipt.receiptId)}?workspaceId=${encodeURIComponent(workspaceId)}`,
    );

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.deepEqual(response.body.receipt, receipt);
  });
});
