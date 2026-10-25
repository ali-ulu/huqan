'use strict';

// #4237: an emergency-stop lift is fail-closed -- it only lifts through a
// consumed operator decision verified against a pinned key. Tests that
// legitimately lift mint the authority's Ed25519 envelopes with a local
// keypair and mount the matching service mode on the ledger.

const crypto = require('node:crypto');
const { canonicalActionHash } = require('../../lib/mcp-operator-capability');
const { signDecision, DECISION_VERSION } = require('../../lib/authority/decision-envelope');
const { signConsumption } = require('../../lib/authority/consumption-envelope');
const { OPERATIONAL_TOOLS } = require('../../lib/authority/operational-guard');

const NOW = Date.now();
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

/** A `ledger.lift` call that carries a minted, consumed operator decision. */
function authorityLift(ledger) {
  const signing = crypto.generateKeyPairSync('ed25519');
  const mode = Object.freeze({ mode: 'service', boundary: 'os-service', pin: { signingKey: signing.publicKey } });
  return function lift({ scope, workspaceId, agentId, reason, actor, operatorIdentity } = {}) {
    const args = { action: 'lift', scope, workspaceId, agentId: agentId || '', reason: reason || '' };
    const approvalId = `ops-${crypto.randomBytes(12).toString('hex')}`;
    const actionHash = canonicalActionHash({ tool: OPERATIONAL_TOOLS.EMERGENCY_STOP, workspaceId, approvalId, arguments: args });
    const envelope = signDecision({ v: DECISION_VERSION, approvalId, workspaceId, tool: OPERATIONAL_TOOLS.EMERGENCY_STOP,
      actionHash, decision: 'approved', reason: '', decidedAt: at(-60_000), validUntil: at(9 * 60_000),
      ledgerSeq: 3, ledgerHash: 'b'.repeat(64), operator: 'totp:primary' }, signing.privateKey);
    const consumption = signConsumption({ approvalId, workspaceId, tool: OPERATIONAL_TOOLS.EMERGENCY_STOP,
      actionHash, ledgerSeq: 4, ledgerHash: 'c'.repeat(64), consumedAt: at(-30_000) }, signing.privateKey);
    return ledger.lift({ scope, workspaceId, agentId, reason, actor, operatorIdentity,
      authority: { approvalId, envelope, consumption, mode } });
  };
}

module.exports = { authorityLift };
