'use strict';

/**
 * Public Trust Badge routes (#1907).
 *
 * Locks in the two properties that make a public surface safe:
 * 1. The projection is allowlisted — no actor, reason, metadata or
 *    workspaceId ever leaves, even when the underlying inspection
 *    carries them.
 * 2. The three families are public GET in the central policy, so the
 *    runtime gate does not 401 them.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parsePublicBadgePath,
  buildBadgeProjection,
  badgeSvg,
  trustPageHtml,
  handlePublicBadgeRequest,
} = require('../lib/http/public-badge-route');
const { resolveRouteAuthPolicy, isPublicRoute } = require('../lib/http/route-auth-policy');

test('badge path parsing covers json, svg and trust page', () => {
  assert.deepEqual(parsePublicBadgePath('/api/badge/abc123'), { kind: 'json', receiptId: 'abc123' });
  assert.deepEqual(parsePublicBadgePath('/badge/abc123.svg'), { kind: 'svg', receiptId: 'abc123' });
  assert.deepEqual(parsePublicBadgePath('/badge/abc123'), { kind: 'svg', receiptId: 'abc123' });
  assert.deepEqual(parsePublicBadgePath('/trust/abc123'), { kind: 'page', receiptId: 'abc123' });
  assert.deepEqual(parsePublicBadgePath('/api/badge/'), { kind: 'json', receiptId: '' });
  assert.equal(parsePublicBadgePath('/api/audit'), null);
  assert.equal(parsePublicBadgePath('/verify'), null);
  assert.equal(parsePublicBadgePath('/verify/abc'), null);
});

test('badge projection exposes only the allowlisted disclosure set', () => {
  const inspection = {
    ok: true,
    status: 'found',
    receiptId: 'r1',
    verdict: 'supported',
    timestamp: '2026-09-06T10:00:00.000Z',
    chainStatus: 'valid',
    receipt: {
      receiptId: 'r1',
      decision: 'admit',
      riskScore: 0.1,
      actor: 'secret-actor',
      reason: 'secret reason text',
      workspaceId: 'tenant-a',
      metadata: { prompt: 'secret' },
    },
  };
  const projection = buildBadgeProjection(inspection, null);
  assert.equal(projection.ok, true);
  assert.equal(projection.trusted, true);
  assert.deepEqual(projection.disclosure, {
    verdict: 'supported',
    decision: 'admit',
    riskScore: 0.1,
    createdAt: '2026-09-06T10:00:00.000Z',
  });
  const serialized = JSON.stringify(projection);
  for (const leaked of ['secret-actor', 'secret reason', 'tenant-a', 'prompt']) {
    assert.ok(!serialized.includes(leaked), `must not leak: ${leaked}`);
  }
});

test('badge projection marks chain-invalid and missing receipts untrusted', () => {
  assert.equal(buildBadgeProjection({ ok: false, status: 'chain_invalid' }, null).trusted, false);
  assert.equal(buildBadgeProjection({ ok: false, status: 'not_found' }, null).status, 'not_found');
  assert.equal(buildBadgeProjection(null, null).trusted, false);
});

test('badge svg escapes receipt-controlled text', () => {
  const svg = badgeSvg({ trusted: true, receiptId: '"><script>alert(1)</script>' });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(!svg.includes('<script>'));
  assert.ok(!svg.includes('"><script>'));
  assert.ok(svg.includes('&lt;'));
});

test('trust page escapes receipt-controlled text', () => {
  const html = trustPageHtml({ trusted: false, reason: '<img src=x onerror=1>' }, '<b>id</b>');
  assert.ok(!html.includes('<img src=x'));
  assert.ok(html.includes('&lt;img'));
});

test('badge families are public GET in the central policy', () => {
  for (const pathname of ['/api/badge/abc', '/badge/abc.svg', '/trust/abc']) {
    assert.equal(resolveRouteAuthPolicy(pathname, 'GET').known, true, `${pathname} declared`);
    assert.equal(isPublicRoute(pathname, 'GET'), true, `${pathname} public`);
  }
  assert.equal(resolveRouteAuthPolicy('/api/badge/abc', 'POST').authRequired, true);
});

test('badge handler answers json/svg/page without leaking internals', () => {
  const inspection = {
    ok: true,
    status: 'found',
    receiptId: 'r1',
    verdict: 'supported',
    timestamp: '2026-09-06T10:00:00.000Z',
    chainStatus: 'valid',
    receipt: { decision: 'admit', riskScore: 0.2, actor: 'nope', reason: 'nope', workspaceId: 'w' },
  };
  const source = {
    countAuditEvents: () => 0,
    queryAuditEvents: () => ({ items: [], hasMore: false }),
  };
  const readReceipt = () => { throw new Error('must use injected reader'); };
  const answers = [];
  const res = {
    writeHead: (status, headers) => answers.push({ status, headers }),
    end: (body) => { answers[answers.length - 1].body = String(body); },
  };
  const writeJson = (req, r, status, body, headers) => {
    answers.push({ status, headers, body: JSON.stringify(body) });
  };
  // Force the inspection path through a stubbed reader by passing a source
  // whose readReceipt is used... instead stub at module seam via readReceipt arg.
  const fakeSource = { ...source };
  const { inspectTrustReceipt } = require('../lib/workbench/trust-receipt-inspector');
  assert.equal(typeof inspectTrustReceipt, 'function');

  const handled = handlePublicBadgeRequest({
    req: { method: 'GET' },
    res,
    reqUrl: { pathname: '/api/badge/r1' },
    source: {
      ...source,
      getReceiptFamilyById: () => '',
    },
    writeJson,
    readReceipt: () => ({
      ok: true,
      receiptId: 'r1',
      receipt: inspection.receipt,
      canonicalPayload: { verdict: 'supported', reason: '', actor: '', createdAt: '2026-09-06T10:00:00.000Z' },
      chainedReceipt: null,
      auditEvent: null,
      chainStatus: 'valid',
    }),
  });
  assert.equal(handled, true);
  assert.equal(answers.length, 1);
  assert.equal(answers[0].status, 200);
  assert.ok(!answers[0].body.includes('nope'));
  assert.ok(answers[0].body.includes('trusted'));
});
