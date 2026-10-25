'use strict';

/**
 * Input validation the authority service applies before touching the ledger
 * (#3860, ADR-016).
 *
 * `proves`, `boundedText` and `validateStop` lived inside
 * `lib/authority/authority-service.js` as module-private helpers. They have
 * no closure over the service, so they move here: the service imports them,
 * and the file that owns the authority's public surface stays under its
 * 400-line budget.
 */

const crypto = require('node:crypto');

const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Checks a consume-proof preimage against its recorded SHA-256 digest.
 * Timing-safe on the digest compare so a wrong guess does not leak how close
 * it was.
 */
function proves(proof, hash) {
  if (typeof proof !== 'string' || proof.length < 32 || proof.length > 256 || !HEX64.test(hash || '')) return false;
  const digest = crypto.createHash('sha256').update(proof, 'utf8').digest();
  return crypto.timingSafeEqual(digest, Buffer.from(hash, 'hex'));
}

/**
 * Bounded, control-character-free text for the fields an authority input may
 * carry. `required` only demands a non-empty trim; an optional field may be
 * absent.
 */
const boundedText = (value, max, required) => (typeof value === 'string' && value.length <= max
  && ![...value].some(ch => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  && (!required || value.trim().length > 0));

// The local stop a runtime reports (#3892). Shape only: the authority cannot
// see the runtime's ledger, so it records the claim and its local hash, and
// `huqan audit --authority` later checks that the hash is still there.
function validateStop(input) {
  const { workspaceId, scope, agentId, reason, actor, localSeq, localHash, stoppedAt } = input || {};
  const ok = boundedText(workspaceId, 128, true) && (scope === 'agent' || scope === 'workspace')
    && (scope === 'agent' ? boundedText(agentId, 256, true) : agentId === null)
    && boundedText(reason, 256, false) && boundedText(actor, 64, true)
    && Number.isInteger(localSeq) && localSeq >= 0 && HEX64.test(localHash || '')
    && boundedText(stoppedAt, 40, true) && Number.isFinite(Date.parse(stoppedAt));
  return ok ? { workspaceId, scope, agentId, reason, actor, localSeq, localHash, stoppedAt } : null;
}

module.exports = { proves, boundedText, validateStop };