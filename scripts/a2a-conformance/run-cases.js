'use strict';


const { canonicalHash, envelopeCoreView } = require('./verifier');

const {
  EVALUATION_TIME, clone, identity, resignHops, resignPackage, resignRequest, rebindAll,
} = require('./run-support');
const { buildFixture } = require('./run-fixture');

function mutated(mutator) {
  const fixture = buildFixture();
  const request = clone(fixture.request);
  const authority = clone(fixture.authority);
  mutator({ fixture, request, authority });
  return { authority, request };
}

const NEGATIVE_CASES = [
  ['identity_alone_insufficient', 'exchange_shape_invalid', ({ request }) => {
    for (const key of ['delegation', 'constraints', 'observation', 'evidence', 'expiresAt']) delete request[key];
  }],
  ['missing_scope', 'delegation_invalid', ({ fixture, request }) => {
    request.delegation.hops[1].scope = []; resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['missing_evidence', 'exchange_shape_invalid', ({ request }) => { delete request.evidence; }],
  ['missing_receipt', 'exchange_shape_invalid', ({ request }) => { delete request.evidence.receipt; }],
  ['missing_expiry', 'exchange_shape_invalid', ({ request }) => { delete request.expiresAt; }],
  ['missing_constraints', 'exchange_shape_invalid', ({ request }) => { delete request.constraints; }],
  ['missing_observation', 'exchange_shape_invalid', ({ request }) => { delete request.observation; }],
  ['missing_route_receipt', 'exchange_shape_invalid', ({ request }) => { delete request.routeReceipt; }],
  ['parent_receipt_binding_mismatch', 'route_receipt_invalid', ({ fixture, request }) => {
    request.routeReceipt.parent_receipt_id = '0'.repeat(64);
    const { route_receipt_id: ignored, ...projection } = request.routeReceipt;
    request.routeReceipt.route_receipt_id = canonicalHash(projection);
    request.evidence.package.manifest.source.envelopeHash = canonicalHash(envelopeCoreView(request));
    resignPackage(fixture, request);
    resignRequest(fixture, request);
  }],
  ['delegation_signature_tampered', 'delegation_signature_invalid', ({ request }) => {
    const value = request.delegation.hops[0].signature.value;
    request.delegation.hops[0].signature.value = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  }],
  ['delegation_scope_escalation', 'delegation_scope_escalation', ({ fixture, request }) => {
    request.delegation.hops[1].scope.push('admin.write'); resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['delegation_child_target_changes', 'delegation_scope_escalation', ({ fixture, request }) => {
    request.delegation.hops[1].target = 'claim:other'; resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['delegation_expiry_equal', 'delegation_expired', ({ fixture, request }) => {
    request.delegation.hops[0].expiresAt = EVALUATION_TIME; resignHops(fixture, request); rebindAll(fixture, request);
  }],
  ['delegation_chain_link_broken', 'delegation_chain_invalid', ({ request }) => {
    request.delegation.hops[1].delegatorId = 'agent-source';
  }],
  ['delegation_parent_hash_broken', 'delegation_chain_invalid', ({ request }) => {
    request.delegation.hops[1].parentDelegationHash = '0'.repeat(64);
  }],
  ['delegation_loop', 'delegation_chain_invalid', ({ request }) => {
    request.delegation.chain = ['agent-source', 'agent-middle', 'agent-source'];
  }],
  ['capability_outside_scope', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.capability = 'memory.write'; rebindAll(fixture, request);
  }],
  ['target_outside_delegation', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.target = 'claim:other'; rebindAll(fixture, request);
  }],
  ['requested_risk_exceeded', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.riskTier = 'high'; rebindAll(fixture, request);
  }],
  ['requested_tool_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.tool = 'shell.exec'; rebindAll(fixture, request);
  }],
  ['requested_connector_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.requestedAction.connector = 'network.http'; rebindAll(fixture, request);
  }],
  ['observed_risk_exceeded', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.observedRiskTier = 'high'; rebindAll(fixture, request);
  }],
  ['observed_tool_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedTools = ['shell.exec']; rebindAll(fixture, request);
  }],
  ['observed_tool_differs_but_is_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedTools = ['axiom.trace']; rebindAll(fixture, request);
  }],
  ['observed_connector_not_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedConnectors = ['network.http']; rebindAll(fixture, request);
  }],
  ['observed_connector_differs_but_is_allowed', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.usedConnectors = ['audit_file']; rebindAll(fixture, request);
  }],
  ['observed_at_expiry_equal', 'constraints_exceeded', ({ fixture, request }) => {
    request.observation.observedAt = request.expiresAt; rebindAll(fixture, request);
  }],
  ['workspace_confusion', 'identity_invalid', ({ fixture, request }) => {
    request.workspaceId = 'workspace-other'; rebindAll(fixture, request);
  }],
  ['source_identity_hash_mismatch', 'identity_invalid', ({ request }) => {
    request.source.identityHash = '0'.repeat(64); request.participants[0].identityHash = '0'.repeat(64);
  }],
  ['target_identity_hash_mismatch', 'identity_invalid', ({ request }) => {
    request.target.identityHash = '0'.repeat(64); request.participants[2].identityHash = '0'.repeat(64);
  }],
  ['source_target_binding_swapped', 'identity_binding_invalid', ({ request }) => {
    request.source = request.participants[1];
  }],
  ['action_tampered_after_binding', 'evidence_action_invalid', ({ request }) => {
    request.requestedAction.parametersHash = '0'.repeat(64);
  }],
  ['receipt_tampered_after_binding', 'evidence_receipt_invalid', ({ request }) => {
    request.evidence.receipt.issuedAt = '2026-08-11T11:58:00.000Z';
  }],
  ['receipt_independent_binding_mismatch', 'evidence_receipt_authority_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.source.internalReceiptHash = '0'.repeat(64);
    resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['package_tampered_after_binding', 'evidence_package_invalid', ({ request }) => {
    request.evidence.package.manifest.description = 'tampered';
  }],
  ['package_wire_invalid', 'evidence_package_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.formatVersion = '0.1'; resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['package_signature_invalid', 'evidence_package_invalid', ({ request }) => {
    const value = request.evidence.packageSignature.value;
    request.evidence.packageSignature.value = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  }],
  ['evidence_ref_bytes_invalid', 'evidence_refs_invalid', ({ fixture, request }) => {
    request.evidence.evidenceRefs[1].bytes += 1; resignRequest(fixture, request);
  }],
  ['receiver_package_allowlist_rejects_manifest', 'evidence_package_authority_invalid', ({ authority }) => {
    authority.identities.find((entry) => entry.ref === 'identity:agent-source').allowedPackageIds = ['pkg-other'];
  }],
  ['receipt_key_cannot_launder_through_agent_key', 'authority_invalid', ({ authority }) => {
    authority.receiptTrustedKeyRecords[0].keyReference = 'test-key:agent-source';
    authority.receiptTrustedKeyRecords[0].publicKeySpkiDerBase64 = authority.keys[0].publicKeySpkiDerBase64;
  }],
  ['package_envelope_binding_mismatch', 'evidence_package_binding_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.source.envelopeHash = '0'.repeat(64);
    resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['package_receipt_binding_mismatch', 'evidence_package_binding_invalid', ({ fixture, request }) => {
    request.evidence.package.manifest.source.receiptHash = '0'.repeat(64);
    resignPackage(fixture, request); resignRequest(fixture, request);
  }],
  ['exchange_signature_tampered', 'exchange_signature_invalid', ({ request }) => {
    const value = request.signature.value;
    request.signature.value = `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
  }],
  ['revoked_source_key', 'delegation_signature_invalid', ({ authority }) => {
    authority.keys.find((entry) => entry.keyReference === 'test-key:agent-source').status = 'revoked';
  }],
  ['target_identity_expiry_equal', 'identity_invalid', ({ authority, request }) => {
    const entry = authority.identities.find((item) => item.ref === 'identity:agent-target');
    entry.record.expires_at = EVALUATION_TIME;
    request.target.identityHash = canonicalHash(entry.record);
    request.participants[2].identityHash = request.target.identityHash;
  }],
  ['exchange_expiry_equal', 'exchange_expired', ({ fixture, request }) => {
    request.expiresAt = EVALUATION_TIME; resignRequest(fixture, request);
  }],
];

module.exports = Object.freeze({ NEGATIVE_CASES, mutated });
