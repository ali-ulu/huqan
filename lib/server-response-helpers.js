'use strict';

const crypto = require('crypto');
const net = require('net');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { toCanonicalVerifyStatus } = require('./verify-status-vocabulary');
const { extractApiKey, constantTimeEqual, sanitizeInput } = require('../requestGuards');

const ALLOWED_CORS_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

function isSafeOrigin(origin) {
  if (typeof origin !== 'string' || !origin) return '';
  try {
    const url = new URL(origin);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    if (!ALLOWED_CORS_HOSTS.has(url.hostname)) return '';
    return url.origin;
  } catch (_) {
    return '';
  }
}

function buildCorsHeaders(req, preflight = false) {
  const origin = isSafeOrigin(req.headers?.origin || '');
  if (!origin) return {};
  const headers = {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
  };
  if (preflight) {
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-API-Key';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

// Responses for the workbench memory-context route must never be cached or
// content-sniffed, including the ones produced by generic middleware (rate
// limit, auth) that answers before the route handler runs.
function memoryContextSecurityHeaders(rawPath) {
  return String(rawPath || '').startsWith('/api/workbench/memory-context/')
    ? { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
    : {};
}

function writeJson(req, res, statusCode, payload, headers = {}) {
  res.writeHead(statusCode, {
    'Content-Type': JSON_CONTENT_TYPE,
    ...buildCorsHeaders(req),
    ...headers,
  });
  res.end(JSON.stringify(payload));
}

function writeApiError(req, res, statusCode, code, message, details = {}) {
  writeJson(req, res, statusCode, {
    ok: false,
    error: {
      code,
      message,
      details,
    },
  }, { 'Cache-Control': 'no-cache' });
}

function sendOptions(req, res) {
  const corsHeaders = buildCorsHeaders(req, true);
  if (!Object.keys(corsHeaders).length) {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(204, {
    ...corsHeaders,
    'Content-Length': '0',
  });
  res.end();
}

function getRateLimitKey(req) {
  const apiKey = extractApiKey(req.headers || {});
  const configuredKey = sanitizeInput(readCompatibleEnvironmentVariable('API_KEY') || '', 256);
  if (apiKey && configuredKey && constantTimeEqual(apiKey, configuredKey)) {
    return 'key:' + crypto.createHash('sha256').update(apiKey).digest('hex').slice(0, 16);
  }
  if (readCompatibleEnvironmentVariable('TRUST_PROXY') === '1') {
    // #1295: X-Forwarded-For is client-controlled. TRUST_PROXY=1 asserts
    // exactly one trusted hop sits directly in front of us; that hop
    // appends (does not rewrite) the address it saw the request arrive
    // from onto the *end* of the list, so the trustworthy value is the
    // LAST entry, not the first -- the first entry is whatever the
    // original client claimed, and a client can put any string there.
    // Trusting it would let an attacker mint a fresh rate-limit key on
    // every request just by varying that header.
    const xffList = String(req.headers?.['x-forwarded-for'] || '').split(',').map(s => s.trim());
    const lastEntry = xffList.length > 0 ? xffList[xffList.length - 1] : '';
    if (lastEntry && net.isIP(lastEntry)) {
      return 'ip:' + lastEntry;
    }
  }
  const remoteAddress = String(req.socket?.remoteAddress || '').trim();
  return remoteAddress ? 'ip:' + remoteAddress : '';
}

// Graf verisini D3 formatına dönüştür
function getSafeMemoryLabel(content) {
  if (content === null || content === undefined) return '';
  let str = '';
  if (typeof content === 'string') {
    str = content;
  } else if (typeof content === 'object') {
    if (content.text && typeof content.text === 'string') {
      str = content.text;
    } else if (content.statement && typeof content.statement === 'string') {
      str = content.statement;
    } else if (content.content && typeof content.content === 'string') {
      str = content.content;
    } else {
      try {
        str = JSON.stringify(content);
      } catch (_) {
        str = String(content);
      }
    }
  } else {
    str = String(content);
  }

  // Encode HTML entities so content is safe in both textContent and innerHTML contexts
  str = str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');

  if (str.length > 100) {
    str = str.substring(0, 97) + '...';
  }
  return str;
}

function newIngestApprovalId() {
  return `ingest-approval-${crypto.randomUUID()}`;
}

function publicIngestApproval(record) {
  if (!record) return null;
  const context = record.context && typeof record.context === 'object' ? record.context : {};
  return {
    id: record.id,
    status: record.status,
    decision: record.decision,
    reason: record.reason,
    createdAt: Number(record.created_at || record.createdAt || 0),
    updatedAt: Number(record.updated_at || record.updatedAt || 0),
    snapshotHash: context.snapshot?.snapshotHash || '',
    sourceType: context.snapshot?.sourceType || '',
    sourceRef: context.snapshot?.sourceRef || '',
    idempotencyKey: context.snapshot?.idempotencyKey || '',
    leaseExpiresAt: Number(context.executionClaim?.leaseExpiresAt || 0),
    receipt: context.receipt || null,
  };
}

// HTTP API boundary adapter. The kernel's internal status vocabulary is left
// untouched; only the serialized public form is canonical English. Readers
// that consume this shape (lib/shield.js) accept both vocabularies. See
// lib/verify-status-vocabulary.js and
// docs/verify-status-vocabulary-migration.md.
function legacyVerify(result) {
  return {
    status: toCanonicalVerifyStatus(result.data.status),
    confidence: result.data.confidence,
    evidence: result.evidence.map(e => e.text),
  };
}

module.exports = {
  ALLOWED_CORS_HOSTS,
  JSON_CONTENT_TYPE,
  isSafeOrigin,
  buildCorsHeaders,
  memoryContextSecurityHeaders,
  writeJson,
  writeApiError,
  sendOptions,
  getRateLimitKey,
  getSafeMemoryLabel,
  newIngestApprovalId,
  publicIngestApproval,
  legacyVerify,
};
