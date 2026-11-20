'use strict';

/**
 * Experience — acceptance-oracle attestation (#4624).
 *
 * `learning-source.js` decides whether a verified failure may become a
 * learning-eligible candidate, and it needs an acceptance oracle that an
 * operator or CI -- not the proposing agent -- supplied. Its first version read
 * that supplier from `HUQAN_ACCEPTANCE_CHANNEL`, and #4624 is the audit finding:
 * environment variables are supplied by whichever process launches the CLI, so
 * a proposing agent can run `HUQAN_ACCEPTANCE_CHANNEL=ci huqan coder propose`
 * and grade its own homework. A string a caller sets is not evidence of who set
 * it.
 *
 * ## What this adds
 *
 * The supplier now has to be *signed*. The operator registers the acceptance
 * oracle with the approval authority and decides it there; `huqan-authority
 * apply` hands over the signed decision envelope. That envelope is Ed25519 over
 * a payload that binds the exact evidence it authorizes:
 *
 *   sourceHash        the sealed failure record the candidate is derived from
 *   commandHash       the acceptance command itself
 *   allowedPathsHash  the paths the candidate may touch
 *   channel           `operator` or `ci`
 *
 * One attestation therefore authorizes one failure, one command and one path
 * set. Replaying it against a different record, a wider path set or a swapped
 * command fails the binding check, and a file the agent writes itself fails the
 * signature check because the agent does not hold the authority's key.
 *
 * ## Reuse, not a second trust root
 *
 * This module does not introduce a new verifier or a new key distribution. It
 * reuses `lib/authority/decision-envelope.js`'s `verifyDecision`, so the
 * acceptance channel is verified by the same code, against the same pinned key
 * and the same domain separation as every other operator decision (`terfi`,
 * `huqan.agent_resume`, emergency-stop lift). The one thing added here is the
 * action-hash recipe that binds the learning evidence, so a decision minted for
 * a promotion cannot be presented as an acceptance attestation and the reverse.
 *
 * The verification is pure: no filesystem, no clock. The caller resolves the
 * pinned key (`resolveApprovalAuthorityMode`) and reads the envelope; this
 * module only judges what it is handed.
 */

const { createHash } = require('node:crypto');
const { stableStringify } = require('../hash-chain');
const { verifyDecision } = require('../authority/decision-envelope');
const { isPlainObject } = require('../is-plain-object');

const ATTESTATION_TOOL = 'huqan.acceptance_oracle';

const CODES = Object.freeze({
  MISSING: 'acceptance_attestation_missing',
  MALFORMED: 'acceptance_attestation_malformed',
  UNTRUSTED: 'acceptance_attestation_untrusted',
  BINDING_MISMATCH: 'acceptance_attestation_binding_mismatch',
  EXPIRED: 'acceptance_attestation_expired',
});

// `source-file` is signable on purpose: an authority may attest that the oracle
// came from the caller's own file, and the learning layer still refuses it.
// Separating "who signed" (this module) from "is that signer independent"
// (learning-source.js) keeps each refusal about exactly one fact.
const CHANNELS = Object.freeze(['operator', 'ci', 'source-file']);
const HEX64 = /^[0-9a-f]{64}$/u;

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The canonical action hash an acceptance attestation signs.
 *
 * Same recipe as `canonicalActionHash` (sorted keys, one sha256), extended with
 * the three hashes that bind the learning evidence and the channel. `tool` is
 * included so this hash can never equal a promotion's or a lift's.
 */
function acceptanceActionHash({ sourceHash, commandHash, allowedPathsHash, channel } = {}) {
  if (!HEX64.test(sourceHash || '') || !HEX64.test(commandHash || '')
      || !HEX64.test(allowedPathsHash || '') || !CHANNELS.includes(channel)) {
    return null;
  }
  return sha256(stableStringify({
    tool: ATTESTATION_TOOL, sourceHash, commandHash, allowedPathsHash, channel,
  }));
}

/** Hash of a declared path set. Order-insensitive: a reordered declaration is the same grant. */
function allowedPathsHash(allowedPaths) {
  if (!Array.isArray(allowedPaths) || allowedPaths.length === 0) return null;
  if (!allowedPaths.every(value => typeof value === 'string' && value.length > 0)) return null;
  return sha256(stableStringify([...allowedPaths].sort()));
}

/**
 * Verify an acceptance attestation against the evidence it claims to authorize.
 *
 * `trustedKey` is the authority's pinned signing key. Without one there is
 * nothing to verify against and the call refuses: an unverifiable attestation
 * is not a weaker attestation, it is no attestation.
 *
 * @returns {{ok: true, channel: string, approvalId: string, actionHash: string}
 *   | {ok: false, code: string, detail: string}}
 */
function verifyAcceptanceAttestation(attestation, {
  sourceHash, command, allowedPaths, trustedKey, now,
} = {}) {
  if (!attestation) return { ok: false, code: CODES.MISSING, detail: '' };
  if (!isPlainObject(attestation)) return { ok: false, code: CODES.MALFORMED, detail: '' };
  // A pinned key is the whole trust anchor. Absent or unusable, nothing below
  // can prove authorship, so the refusal is "untrusted", not "malformed".
  if (!trustedKey) return { ok: false, code: CODES.UNTRUSTED, detail: '' };
  if (!Number.isFinite(now)) return { ok: false, code: CODES.MALFORMED, detail: 'now' };

  const channel = typeof attestation.channel === 'string' ? attestation.channel.toLowerCase() : '';
  if (!CHANNELS.includes(channel)) return { ok: false, code: CODES.MALFORMED, detail: 'channel' };
  if (typeof command !== 'string' || !command) return { ok: false, code: CODES.MALFORMED, detail: 'command' };

  const pathsHash = allowedPathsHash(allowedPaths);
  if (!pathsHash) return { ok: false, code: CODES.MALFORMED, detail: 'allowedPaths' };
  const actionHash = acceptanceActionHash({
    sourceHash, commandHash: sha256(command), allowedPathsHash: pathsHash, channel,
  });
  if (!actionHash) return { ok: false, code: CODES.MALFORMED, detail: 'actionHash' };

  const payload = isPlainObject(attestation.envelope) ? attestation.envelope.payload : null;
  const approvalId = payload && typeof payload.approvalId === 'string' ? payload.approvalId : '';
  const workspaceId = payload && typeof payload.workspaceId === 'string' ? payload.workspaceId : '';

  let verified;
  try {
    verified = verifyDecision(attestation.envelope, {
      publicKey: trustedKey,
      expected: { approvalId, workspaceId, tool: ATTESTATION_TOOL, actionHash, decision: 'approved' },
      now,
    });
  } catch (_) {
    verified = { ok: false, code: 'malformed' };
  }
  if (!verified.ok) {
    // `expired` is the operator's grant running out, which a caller can fix by
    // asking again; every other failure is a forgery, a wrong key or a decision
    // for different evidence, and stays a binding refusal.
    const code = verified.code === 'expired' ? CODES.EXPIRED : CODES.BINDING_MISMATCH;
    return { ok: false, code, detail: verified.code || '' };
  }

  return { ok: true, channel, approvalId, actionHash };
}

module.exports = Object.freeze({
  ATTESTATION_TOOL,
  CODES,
  CHANNELS,
  acceptanceActionHash,
  allowedPathsHash,
  verifyAcceptanceAttestation,
});
