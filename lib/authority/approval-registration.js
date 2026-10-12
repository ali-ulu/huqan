'use strict';

// Validation of an approval the runtime registers with the authority (#3860).
//
// The authority recomputes the action hash from the arguments it was shown and
// refuses a registration whose claimed hash differs: the decision the operator
// signs then covers exactly what will run, not what the runtime said would.
//
// Part of the authority bundle (lib/authority/bundle-manifest.js).

const { canonicalActionHash } = require('../mcp-operator-capability');

const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
const MAX_TEXT = 512;
const MAX_ARGUMENTS_BYTES = 16 * 1024;
const MAX_APPROVAL_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
// A registration that expires almost at once costs ledger space and can never
// be decided by a human; refusing it keeps flooding from being free.
const MIN_APPROVAL_LIFETIME_MS = 5 * 60 * 1000;
const HEX64 = /^[0-9a-f]{64}$/;

function invalid(reason) {
  return { ok: false, status: 400, code: 'INVALID', reason };
}

/**
 * @returns {{ok: true, approval: object} | {ok: false, status: number, code: string, reason?: string}}
 */
function validateRegistration(input, now) {
  const { approvalId, workspaceId, tool, arguments: args, actionHash, consumeProofHash, summary, expiresAt } = input || {};
  if (typeof approvalId !== 'string' || !ID.test(approvalId)) return invalid('approvalId');
  for (const [field, value] of [['workspaceId', workspaceId], ['tool', tool]]) {
    if (typeof value !== 'string' || !value || value.length > MAX_TEXT) return invalid(field);
  }
  if (typeof summary !== 'string' || summary.length > MAX_TEXT) return invalid('summary');
  if (typeof consumeProofHash !== 'string' || !HEX64.test(consumeProofHash)) return invalid('consumeProofHash');
  if (!args || typeof args !== 'object' || Array.isArray(args)) return invalid('arguments');
  if (Buffer.byteLength(JSON.stringify(args), 'utf8') > MAX_ARGUMENTS_BYTES) return invalid('arguments too large');
  const expiry = typeof expiresAt === 'string' && ISO_INSTANT.test(expiresAt) ? Date.parse(expiresAt) : Number.NaN;
  if (!Number.isFinite(expiry)) return invalid('expiresAt');
  if (expiry <= now) return { ok: false, status: 409, code: 'EXPIRED' };
  if (expiry - now > MAX_APPROVAL_LIFETIME_MS) return invalid('expiresAt too far');
  if (expiry - now < MIN_APPROVAL_LIFETIME_MS) return invalid('expiresAt too soon');
  let recomputed;
  try {
    recomputed = canonicalActionHash({ tool, workspaceId, approvalId, arguments: args });
  } catch {
    return invalid('action binding');
  }
  if (recomputed !== actionHash) return { ok: false, status: 409, code: 'HASH_MISMATCH' };
  return { ok: true, approval: { approvalId, workspaceId, tool, arguments: args, actionHash, consumeProofHash, summary, expiresAt } };
}

module.exports = { validateRegistration };
