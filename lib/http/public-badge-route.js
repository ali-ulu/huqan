'use strict';

/**
 * Public Trust Badge routes (#1907, "Trusted by Huqan" Faz 1).
 *
 *   GET /api/badge/:receiptId   JSON verification payload (public)
 *   GET /badge/:receiptId.svg   embeddable SVG badge (public)
 *   GET /trust/:receiptId       human-readable verification page (public)
 *
 * ## Why a separate surface from /api/workbench/trust-receipt/
 *
 * The workbench inspector returns the full materialized receipt
 * (receipt, canonicalPayload, chainedReceipt, auditEvent) to an
 * authenticated caller. A public badge must never do that: free-text
 * fields (reason, metadata, actor) and tenancy identifiers (workspaceId)
 * stay server-side. This module projects the inspection down to the
 * allowlisted disclosure set from
 * specs/huqan-trust-protocol/0.2/schemas/public-receipt-redaction-policy.json:
 * verdict, decision, riskScore, createdAt — plus chain status and a
 * bounded 24h activity aggregate. Nothing else leaves the process.
 *
 * ## Scope
 *
 * Default workspace only, mirroring the /graph-data precedent in
 * lib/http/route-auth-policy.js: named workspaces remain authenticated.
 */

const { inspectTrustReceipt } = require('../workbench/trust-receipt-inspector');
const { readReceiptById } = require('../receipt/receipt-read-index');

const BADGE_JSON_PREFIX = '/api/badge/';
const BADGE_SVG_PREFIX = '/badge/';
const TRUST_PAGE_PREFIX = '/trust/';

const MAX_RECEIPT_ID_LEN = 128;
const STATS_WINDOW_MS = 24 * 3600 * 1000;
const STATS_MAX_EVENTS = 500;

const BADGE_HEADERS = Object.freeze({
  'Cache-Control': 'public, max-age=60',
  'X-Content-Type-Options': 'nosniff',
});

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  // oxlint-disable-next-line no-control-regex -- deliberate: strips control characters from badge text
  return value.slice(0, maxLen).replace(/[\x00-\x1F\x7F]/g, '').trim();
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const escapeHtml = escapeXml;

/**
 * @returns {{ kind: 'json'|'svg'|'page', receiptId: string }|null}
 */
function parsePublicBadgePath(pathname) {
  if (typeof pathname !== 'string') return null;
  let kind = null;
  let raw = '';
  if (pathname.startsWith(BADGE_JSON_PREFIX)) {
    kind = 'json';
    raw = pathname.slice(BADGE_JSON_PREFIX.length);
  } else if (pathname.startsWith(BADGE_SVG_PREFIX)) {
    kind = 'svg';
    raw = pathname.slice(BADGE_SVG_PREFIX.length);
  } else if (pathname.startsWith(TRUST_PAGE_PREFIX)) {
    kind = 'page';
    raw = pathname.slice(TRUST_PAGE_PREFIX.length);
  } else {
    return null;
  }
  if (!raw || raw.includes('/')) return { kind, receiptId: '' };
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch (_) {
    return { kind, receiptId: '' };
  }
  if (kind === 'svg' && decoded.toLowerCase().endsWith('.svg')) {
    decoded = decoded.slice(0, -4);
  }
  return { kind, receiptId: sanitize(decoded, MAX_RECEIPT_ID_LEN) };
}

function inspectDefaultWorkspace(source, receiptId, readReceipt) {
  return inspectTrustReceipt({
    receiptId,
    workspaceId: 'default',
    source,
    readReceipt: readReceipt || ((src, id, filters) => readReceiptById(src, id, filters)),
  });
}

/**
 * Bounded 24h activity aggregate for the default workspace.
 * COUNT(*) for the total, one bounded page for the window count —
 * never a full-table materialization (#728 pattern).
 */
function computeBadgeStats(source) {
  try {
    if (!source || typeof source.countAuditEvents !== 'function') return null;
    const receiptsTotal = Number(source.countAuditEvents({ workspaceId: 'default' }));
    if (!Number.isFinite(receiptsTotal)) return null;
    let events24h = null;
    let truncated = false;
    if (typeof source.queryAuditEvents === 'function') {
      const page = source.queryAuditEvents({ filters: { workspaceId: 'default' }, limit: STATS_MAX_EVENTS });
      const items = Array.isArray(page && page.items) ? page.items : [];
      const cutoff = Date.now() - STATS_WINDOW_MS;
      let count = 0;
      for (const event of items) {
        const ts = Date.parse(event && event.timestamp);
        if (Number.isFinite(ts) && ts >= cutoff) count += 1;
      }
      events24h = count;
      truncated = page && page.hasMore === true;
    }
    return { windowHours: 24, events24h, receiptsTotal, truncated };
  } catch (_) {
    return null;
  }
}

/**
 * Allowlisted projection. Every key here is either in the public-receipt
 * redaction allowlist or derived chain/aggregate state. Add nothing
 * actor-, reason- or metadata-shaped without updating the policy first.
 */
function buildBadgeProjection(inspection, stats) {
  if (!inspection || typeof inspection !== 'object') {
    return { ok: false, status: 'rejected', trusted: false, reason: 'receipt_read_failed' };
  }
  if (inspection.ok !== true || inspection.status !== 'found') {
    const reason = inspection.status === 'not_found'
      ? 'receipt_not_found'
      : inspection.status === 'chain_invalid'
        ? 'receipt_chain_invalid'
        : 'receipt_read_failed';
    return {
      ok: false,
      status: inspection.status === 'not_found' ? 'not_found' : 'rejected',
      trusted: false,
      reason,
      ...(stats ? { stats } : {}),
    };
  }
  const riskScore = Number(inspection.receipt && inspection.receipt.riskScore);
  return {
    ok: true,
    status: 'verified',
    trusted: true,
    receiptId: String(inspection.receiptId || ''),
    disclosure: {
      verdict: String(inspection.verdict || ''),
      decision: String((inspection.receipt && inspection.receipt.decision) || ''),
      riskScore: Number.isFinite(riskScore) ? riskScore : null,
      createdAt: String(inspection.timestamp || ''),
    },
    chainStatus: inspection.chainStatus || null,
    ...(stats ? { stats } : {}),
  };
}

function badgeLabel(projection) {
  if (projection.trusted === true) return 'trusted by huqan';
  if (projection.status === 'not_found') return 'receipt not found';
  return 'not trusted';
}

function badgeColor(projection) {
  if (projection.trusted === true) return '#16a34a';
  if (projection.status === 'not_found') return '#6b7280';
  return '#dc2626';
}

function badgeSvg(projection) {
  const label = badgeLabel(projection);
  const color = badgeColor(projection);
  const shortId = String(projection.receiptId || '').slice(0, 8);
  const detail = shortId ? ` ${shortId}` : '';
  const width = 150 + detail.length * 6;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="20" role="img" aria-label="${escapeXml(label)}">`
    + `<rect width="${width}" height="20" rx="3" fill="#111827"/>`
    + `<rect x="118" width="${width - 118}" height="20" rx="3" fill="${color}"/>`
    + `<text x="8" y="14" font-family="Verdana,sans-serif" font-size="11" fill="#ffffff">huqan</text>`
    + `<text x="60" y="14" font-family="Verdana,sans-serif" font-size="11" fill="#9ca3af">| ${escapeXml(label)}${escapeXml(detail)}</text>`
    + `</svg>`;
}

function trustPageHtml(projection, receiptId) {
  const title = projection.trusted === true ? 'Trusted by Huqan — verified' : 'Trusted by Huqan — not verified';
  const rows = projection.trusted === true
    ? `<li>verdict: <b>${escapeHtml(projection.disclosure.verdict)}</b></li>`
      + `<li>decision: <b>${escapeHtml(projection.disclosure.decision)}</b></li>`
      + `<li>risk score: <b>${escapeHtml(String(projection.disclosure.riskScore))}</b></li>`
      + `<li>created at: <b>${escapeHtml(projection.disclosure.createdAt)}</b></li>`
      + `<li>chain: <b>${escapeHtml(String(projection.chainStatus))}</b></li>`
    : `<li>reason: <b>${escapeHtml(projection.reason || 'unknown')}</b></li>`;
  const stats = projection.stats
    ? `<p>Last 24h (default workspace): ${escapeHtml(String(projection.stats.events24h))} events`
      + ` · ${escapeHtml(String(projection.stats.receiptsTotal))} total receipts`
      + (projection.stats.truncated ? ' (truncated)' : '') + `.</p>`
    : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width,initial-scale=1">`
    + `<title>${escapeHtml(title)}</title></head><body>`
    + `<h1>${escapeHtml(title)}</h1>`
    + `<p>receipt: <code>${escapeHtml(receiptId)}</code></p>`
    + `<ul>${rows}</ul>${stats}`
    + `<p><a href="/api/badge/${escapeHtml(receiptId)}">machine-readable JSON</a> · `
    + `<a href="/badge/${escapeHtml(receiptId)}.svg">embed badge</a></p>`
    + `</body></html>`;
}

function methodNotAllowed(writeJson, req, res) {
  writeJson(req, res, 405, { ok: false, status: 'method_not_allowed', error: { code: 'method_not_allowed' } }, BADGE_HEADERS);
  return true;
}

function invalidRequest(writeJson, req, res, code) {
  writeJson(req, res, 400, { ok: false, status: 'invalid_request', trusted: false, reason: code }, BADGE_HEADERS);
  return true;
}

/**
 * Route handler. Returns true when the path belongs to this surface
 * (even when the answer is 4xx), false otherwise.
 */
function handlePublicBadgeRequest({ req, res, reqUrl, source, writeJson, readReceipt }) {
  const parsed = parsePublicBadgePath(reqUrl && reqUrl.pathname);
  if (!parsed) return false;
  if (String(req.method || 'GET').toUpperCase() !== 'GET') return methodNotAllowed(writeJson, req, res);
  if (!parsed.receiptId) {
    if (parsed.kind !== 'json') {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...BADGE_HEADERS });
      res.end('receiptId is required');
      return true;
    }
    return invalidRequest(writeJson, req, res, 'receiptId_required');
  }
  const inspection = inspectDefaultWorkspace(source, parsed.receiptId, readReceipt);
  const projection = buildBadgeProjection(inspection, computeBadgeStats(source));

  if (parsed.kind === 'svg') {
    const svg = badgeSvg(projection);
    res.writeHead(projection.trusted ? 200 : 404, { 'Content-Type': 'image/svg+xml', ...BADGE_HEADERS });
    res.end(svg);
    return true;
  }
  if (parsed.kind === 'page') {
    const html = trustPageHtml(projection, parsed.receiptId);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...BADGE_HEADERS });
    res.end(html);
    return true;
  }
  const statusCode = projection.ok ? 200 : projection.status === 'not_found' ? 404 : 502;
  writeJson(req, res, statusCode, projection, BADGE_HEADERS);
  return true;
}

module.exports = {
  BADGE_JSON_PREFIX,
  BADGE_SVG_PREFIX,
  TRUST_PAGE_PREFIX,
  parsePublicBadgePath,
  buildBadgeProjection,
  computeBadgeStats,
  badgeSvg,
  trustPageHtml,
  handlePublicBadgeRequest,
};
