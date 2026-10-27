// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * The collector counter-seal chain inside an evidence pack (#4092, PR-A5).
 *
 * No chain rule lives here: seals are read with the collector store's reader and
 * judged by `verifyCollectorSealChain`, the same functions the collector uses.
 * What this module decides is only how a pack carries them:
 *
 *  - a seal chain cannot be cut by period (verifying it needs the genesis), so a
 *    tenant's chain is packed whole, like the emergency-stop ledger;
 *  - the pack holds one chain per tenant, concatenated; the verifier regroups
 *    them by (workspaceId, ownerActorId), which every seal states;
 *  - collector public keys are never packed. They reach the verifier by a
 *    separate channel, because a key shipped with the evidence would let
 *    whoever forged the evidence vouch for it (issue #4092 section 3.6).
 */

const { listTenants } = require('../external-action-receipt-collector-fleet');
const { readSeals, readTrustedBatchKeys, verifyCollectorSealChain } = require('../external-action-receipt-collector-store');
const { issuerKeyFingerprint } = require('../receipt/issuer-seal');

const COLLECTOR_SEALS_RELATIVE_PATH = 'external-actions/collector-seals.jsonl';

const UNVERIFIED_WARNING = 'collector seals present, not verified: no collector public key supplied';
const COLLECTOR_NON_CLAIM = 'collector seals are third-party evidence only if the collector is administered by someone other than the operator; a seal chain whose last seals were removed cannot be told from a quiet period';

const text = (value) => (typeof value === 'string' ? value : '');
const tenantKey = (seal) => `${text(seal?.workspaceId)}\u0000${text(seal?.ownerActorId)}`;

/** Verified tenant chains of the default workspace, as the pack's file text; null when the store holds none. */
function readCollectorSealText(collectorStore, collectorPubkeys) {
  const trustedKeys = readTrustedBatchKeys(collectorPubkeys);
  const rows = [];
  for (const tenant of listTenants({ root: collectorStore, workspaceId: 'default' })) {
    const seals = readSeals(tenant.directory);
    if (seals.length === 0) continue;
    const chain = verifyCollectorSealChain(seals, trustedKeys);
    if (!chain.ok) return { error: `collector seal chain of ${tenant.ownerActorId} does not verify: ${chain.reason} at seal ${chain.index}` };
    rows.push(...seals);
  }
  return rows.length === 0 ? { sealText: null } : { sealText: rows.map((row) => `${JSON.stringify(row)}\n`).join('') };
}

function parseSealRows(sealText) {
  const rows = [];
  for (const line of sealText.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let parsed = null;
    try { parsed = JSON.parse(trimmed); } catch { parsed = null; }
    rows.push(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { __corrupt: true });
  }
  return rows;
}

/**
 * @param {string} sealText the packed collector-seals.jsonl
 * @param {Record<string, string>|null} trustedKeys keyId -> public key PEM from the separate channel; null when none was supplied
 * @param {string|null} issuerKeyId the pack's sealed issuer key id, when it has one
 * @returns {{findings: string[], warnings: string[]}}
 */
function checkCollectorSeals(sealText, trustedKeys, issuerKeyId) {
  if (!trustedKeys) return { findings: [], warnings: [UNVERIFIED_WARNING] };
  const chains = new Map();
  for (const row of parseSealRows(sealText)) {
    const key = tenantKey(row);
    chains.set(key, [...(chains.get(key) || []), row]);
  }
  const findings = [];
  const usedKeyIds = new Set();
  for (const seals of chains.values()) {
    const chain = verifyCollectorSealChain(seals, trustedKeys);
    if (!chain.ok) findings.push(`collector_seal_chain_invalid:${chain.reason}`);
    for (const seal of seals) if (typeof seal.keyId === 'string' && Object.prototype.hasOwnProperty.call(trustedKeys, seal.keyId)) usedKeyIds.add(seal.keyId);
  }
  const warnings = [];
  if (issuerKeyId && [...usedKeyIds].some((id) => issuerKeyFingerprint(trustedKeys[id]) === issuerKeyId)) {
    warnings.push(`collector_not_independent: the collector key and the issuer key (${issuerKeyId}) are the same key, so the counter-seal adds no independence`);
  }
  return { findings, warnings };
}

module.exports = { COLLECTOR_SEALS_RELATIVE_PATH, COLLECTOR_NON_CLAIM, UNVERIFIED_WARNING, readCollectorSealText, checkCollectorSeals };
