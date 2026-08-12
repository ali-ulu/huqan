'use strict';

/**
 * HUQAN is an English-positioned product. Its public HTTP surface must answer
 * in English: canonical English verify statuses, English error messages and
 * the canonical `huqan` service identity.
 *
 * Legacy input spellings (`statement`, `text`) stay accepted per the RFC-001
 * reader rule; only the emitted form is canonical.
 */

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { after, before, describe, it } = require('node:test');
const assert = require('node:assert/strict');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-english-api-'));
process.env.AXIOM_DISABLE_AUTO_LISTEN = '1';
process.env.AXIOM_API_KEY = 'english-api-test-key';
process.env.AXIOM_MEMORY_PATH = path.join(tempDir, 'memory.json');
process.env.AXIOM_USE_SQLITE = 'false';

const server = require('../server');
const { CANONICAL_VERIFY_STATUSES } = require('../lib/verify-status-vocabulary');

const LEGACY_STATUS_PATTERN = /dogrulandi|celiski|bilinmiyor/;

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
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, raw, body: raw ? JSON.parse(raw) : null });
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('error', reject);
    req.end(body || '');
  });
}

describe('public HTTP API answers in English', () => {
  let port;

  before(async () => {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    server.closeAxiom();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('GET /health reports the canonical huqan service identity', async () => {
    const response = await requestJson(port, '/health');
    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.equal(response.body.service, 'huqan');
  });

  it('GET /health still exposes the legacy service name for existing probes', async () => {
    const response = await requestJson(port, '/health');
    assert.equal(response.body.legacyService, 'axiom');
  });

  it('POST /verify returns a canonical English status for an unknown claim', async () => {
    const response = await requestJson(port, '/verify', {
      method: 'POST',
      body: { statement: 'Smoking causes lung cancer' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'unknown');
    assert.ok(
      CANONICAL_VERIFY_STATUSES.includes(response.body.status),
      `status must be canonical, got ${response.body.status}`,
    );
    assert.equal(LEGACY_STATUS_PATTERN.test(response.raw), false, response.raw);
  });

  it('POST /verify accepts the canonical `claim` input field', async () => {
    const response = await requestJson(port, '/verify', {
      method: 'POST',
      body: { claim: 'Smoking causes lung cancer' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'unknown');
    assert.equal(typeof response.body.confidence, 'number');
    assert.ok(Array.isArray(response.body.evidence));
  });

  it('POST /verify still accepts the legacy `statement` and `text` fields', async () => {
    for (const field of ['statement', 'text']) {
      const response = await requestJson(port, '/verify', {
        method: 'POST',
        body: { [field]: 'Smoking causes lung cancer' },
      });
      assert.equal(response.status, 200, `${field} must remain accepted`);
      assert.equal(response.body.status, 'unknown');
    }
  });

  it('`claim` and `statement` produce an identical verdict for identical input', async () => {
    const viaClaim = await requestJson(port, '/verify', {
      method: 'POST',
      body: { claim: 'Smoking causes lung cancer' },
    });
    const viaStatement = await requestJson(port, '/verify', {
      method: 'POST',
      body: { statement: 'Smoking causes lung cancer' },
    });
    assert.deepEqual(viaClaim.body, viaStatement.body);
  });

  it('POST /verify reports a missing claim in English', async () => {
    const response = await requestJson(port, '/verify', { method: 'POST', body: {} });

    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'claim, statement or text is required');
    assert.equal(/gerekli/.test(response.raw), false, 'error must not be Turkish');
  });

  it('POST /dogrula stays available and answers in the same English contract', async () => {
    const response = await requestJson(port, '/dogrula', {
      method: 'POST',
      body: { claim: 'Smoking causes lung cancer' },
    });
    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'unknown');
  });

  it('POST /v2/verify emits no legacy status anywhere in the full envelope', async () => {
    const response = await requestJson(port, '/v2/verify', {
      method: 'POST',
      body: { claim: 'Smoking causes lung cancer' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.data.status, 'unknown');
    assert.equal(
      LEGACY_STATUS_PATTERN.test(response.raw),
      false,
      `legacy status leaked in /v2/verify envelope: ${response.raw}`,
    );
  });

  it('POST /v2/verify projects the nested reasoning-trace statuses too', async () => {
    const response = await requestJson(port, '/v2/verify', {
      method: 'POST',
      body: { claim: 'Smoking causes lung cancer' },
    });

    const trace = response.body.meta?.reasoningTrace;
    assert.ok(trace, 'reasoning trace should be present in the v2 envelope');
    assert.ok(CANONICAL_VERIFY_STATUSES.includes(trace.status), trace.status);
    assert.ok(
      CANONICAL_VERIFY_STATUSES.includes(trace.trustReceiptPreview.finalStatus),
      trace.trustReceiptPreview.finalStatus,
    );
    for (const step of trace.steps || []) {
      assert.ok(CANONICAL_VERIFY_STATUSES.includes(step.status), `step status: ${step.status}`);
    }
  });

  it('POST /v2/verify reports a missing claim in English', async () => {
    const response = await requestJson(port, '/v2/verify', { method: 'POST', body: {} });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'claim, statement or text is required');
  });

  it('a verified claim serializes as "verified", not "verified"', async () => {
    server.kernel.learn('aspirin reduces fever', {
      workspaceId: 'default',
      approvalRequired: true,
      approvalStatus: 'approved',
      approvalId: 'apr-english-api',
      provenance: {
        provenanceId: 'prov-english-api',
        sourceType: 'test',
        sourceRef: 'test:english-api',
        actor: 'english-api-test',
        workspaceId: 'default',
        timestamp: new Date().toISOString(),
        trustPolicyVersion: '1.0.0',
      },
    });

    const response = await requestJson(port, '/verify', {
      method: 'POST',
      body: { claim: 'aspirin reduces fever' },
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.status, 'verified');
    assert.equal(LEGACY_STATUS_PATTERN.test(response.raw), false, response.raw);
  });

  it('the internal kernel representation is unchanged by the boundary adapter', async () => {
    // The whole point of the edge adapter: persistence and internal runtime
    // still speak the legacy vocabulary, so nothing already stored is
    // reinterpreted.
    const internal = server.kernel.verify('aspirin reduces fever', { workspaceId: 'default' });
    assert.equal(internal.data.status, 'verified');
  });
});
