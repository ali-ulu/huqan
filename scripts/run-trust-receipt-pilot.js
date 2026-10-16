'use strict';

const crypto = require('node:crypto');

const {
  buildPilotTrustReceipt,
  canonicalHash,
  projectPilotTrustReceipt,
  verifyPilotPublicProjection,
  verifyPilotTrustReceipt,
} = require('../lib/pilot/trust-receipt-pilot');
const { createPilotReceiptArchive } = require('../lib/pilot/trust-receipt-pilot-archive');

function runPilot() {
  const keys = crypto.generateKeyPairSync('ed25519');
  const evaluationTime = '2026-08-26T10:00:00.000Z';
  const input = {
    receiptId: 'issue-1614-pilot-receipt',
    issuedAt: evaluationTime,
    expiresAt: '2026-08-26T10:10:00.000Z',
    issuer: { id: 'huqan-local-pilot', keyId: 'test-key:issue-1614-pilot' },
    receiver: { id: 'huqan-local-verifier' },
    workspaceId: 'issue-1614-pilot-workspace',
    operation: { capability: 'trust.verify', target: 'pilot-event-001', parametersHash: canonicalHash({ event: 'pilot-event-001' }) },
    pilotRun: { pilotId: 'issue-1614', runId: 'local-run-001', eventId: 'pilot-event-001' },
    evidence: { type: 'local-verification', digest: canonicalHash({ result: 'supported' }) },
    provenance: { source: 'scripts/run-trust-receipt-pilot.js', digest: canonicalHash({ revision: 1 }) },
    policyVersion: 'trust-receipt-pilot-policy-v1',
    verdict: 'allow',
    relay: { hop: 0, parentReceiptHash: null },
    signer: { privateKey: keys.privateKey },
  };
  const receipt = buildPilotTrustReceipt(input);
  const publicProjection = projectPilotTrustReceipt(receipt);
  const verification = verifyPilotTrustReceipt(receipt, {
    evaluationTime,
    trustedIssuers: [{ ...input.issuer, status: 'active', publicKey: keys.publicKey }],
    authority: { workspaceId: input.workspaceId, receiverId: input.receiver.id, capabilities: [input.operation.capability] },
    replayReserve: (() => { let reserved = false; return () => reserved ? false : (reserved = true); })(),
  });
  const projectionVerification = verifyPilotPublicProjection(publicProjection, receipt);
  const archive = createPilotReceiptArchive([{ receipt, publicProjection, verification }]);
  return { internalReceipt: receipt, publicProjection, independentVerifier: { ...verification, projection: projectionVerification }, pilotReport: archive.report };
}

if (require.main === module) process.stdout.write(`${JSON.stringify(runPilot(), null, 2)}\n`);

module.exports = { runPilot };
