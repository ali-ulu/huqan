'use strict';

const crypto = require('node:crypto');
const { stableStringify } = require('./receipt/canonical-receipt');

const CAPABILITY_PREFIX = 'mcp-op-v1';
const DEFAULT_TTL_MS = 60_000;
const MAX_TTL_MS = 5 * 60_000;
const MAX_TOKEN_BYTES = 4096;
const HEX_SHA256 = /^[0-9a-f]{64}$/;

function text(value, max = 256) {
  return typeof value === 'string' && value.length > 0
    && value.trim() === value && Buffer.byteLength(value, 'utf8') <= max;
}

function nullableText(value, max = 256) {
  return value === null || (typeof value === 'string' && value.length <= max && value.trim() === value);
}

function canonicalActionHash({ tool, workspaceId, approvalId = null, runId = null, arguments: args = {} } = {}) {
  if (!text(tool) || !text(workspaceId) || !nullableText(approvalId) || !nullableText(runId)) {
    throw new TypeError('invalid MCP capability action binding');
  }
  return crypto.createHash('sha256')
    .update(stableStringify({ tool, workspaceId, approvalId, runId, arguments: args }), 'utf8')
    .digest('hex');
}

function capabilityBinding({ tool, workspaceId, approvalId = null, runId = null, arguments: args = {} } = {}) {
  return {
    tool,
    workspaceId,
    approvalId,
    runId,
    actionHash: canonicalActionHash({ tool, workspaceId, approvalId, runId, arguments: args }),
  };
}

function sign(secret, encodedPayload) {
  return crypto.createHmac('sha256', secret).update(encodedPayload, 'ascii').digest('base64url');
}

function createMcpOperatorCapability({ secret, tool, workspaceId, approvalId = null, runId = null, actionHash, ttlMs = DEFAULT_TTL_MS, now = Date.now(), nonce } = {}) {
  if (!text(secret, 4096) || !text(tool) || !text(workspaceId)
      || !nullableText(approvalId) || !nullableText(runId) || !HEX_SHA256.test(String(actionHash || ''))) {
    throw new TypeError('invalid MCP operator capability input');
  }
  const boundedTtl = Math.max(1, Math.min(MAX_TTL_MS, Number(ttlMs) || DEFAULT_TTL_MS));
  const exp = Math.floor((Number(now) + boundedTtl) / 1000);
  const capabilityNonce = text(nonce, 128) ? nonce : crypto.randomBytes(16).toString('base64url');
  const payload = {
    v: 1,
    tool,
    workspaceId,
    approvalId,
    runId,
    actionHash,
    exp,
    nonce: capabilityNonce,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${CAPABILITY_PREFIX}.${encodedPayload}.${sign(secret, encodedPayload)}`;
}

function consumeNonce(nonceStore, nonce, exp, now) {
  if (!nonceStore) return true;
  if (!(nonceStore instanceof Map || nonceStore instanceof Set)) return false;
  if (nonceStore instanceof Map) {
    const nowSeconds = Math.floor(Number(now) / 1000);
    for (const [knownNonce, knownExp] of nonceStore) {
      if (knownExp <= nowSeconds) nonceStore.delete(knownNonce);
    }
    if (nonceStore.has(nonce)) return false;
    nonceStore.set(nonce, exp);
    return true;
  }
  if (nonceStore.has(nonce)) return false;
  nonceStore.add(nonce);
  return true;
}

function verifyMcpOperatorCapability({ secret, capability, expected, now = Date.now(), nonceStore } = {}) {
  const fail = reason => ({ ok: false, reason });
  if (!text(secret, 4096) || !text(capability, MAX_TOKEN_BYTES) || !expected || typeof expected !== 'object') {
    return fail('capability.invalid');
  }
  const parts = capability.split('.');
  if (parts.length !== 3 || parts[0] !== CAPABILITY_PREFIX || !parts[1] || !parts[2]) {
    return fail('capability.invalid');
  }
  const [prefix, encodedPayload, presentedSignature] = parts;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8'));
  } catch (_) {
    return fail('capability.invalid');
  }
  if (!payload || payload.v !== 1 || !text(payload.tool) || !text(payload.workspaceId)
      || !nullableText(payload.approvalId) || !nullableText(payload.runId)
      || !HEX_SHA256.test(String(payload.actionHash || '')) || !Number.isInteger(payload.exp)
      || !text(payload.nonce, 128)) {
    return fail('capability.invalid');
  }
  const expectedSignature = sign(secret, encodedPayload);
  const presented = Buffer.from(presentedSignature, 'base64url');
  const expectedBytes = Buffer.from(expectedSignature, 'base64url');
  if (presented.length !== expectedBytes.length || !crypto.timingSafeEqual(presented, expectedBytes)) {
    return fail('capability.invalid');
  }
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (payload.exp <= nowSeconds || payload.exp > nowSeconds + Math.ceil(MAX_TTL_MS / 1000) + 1) {
    return fail('capability.expired');
  }
  for (const key of ['tool', 'workspaceId', 'approvalId', 'runId', 'actionHash']) {
    if (payload[key] !== expected[key]) return fail('capability.scope_mismatch');
  }
  if (!consumeNonce(nonceStore, payload.nonce, payload.exp, Number(now))) {
    return fail('capability.replayed');
  }
  return { ok: true, payload };
}

module.exports = Object.freeze({
  CAPABILITY_PREFIX,
  DEFAULT_TTL_MS,
  MAX_TTL_MS,
  canonicalActionHash,
  capabilityBinding,
  createMcpOperatorCapability,
  verifyMcpOperatorCapability,
});
