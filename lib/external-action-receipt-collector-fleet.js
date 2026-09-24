'use strict';

// #2195: the read-only fleet view over the collector store: tenant listing,
// seal chain verification and the windowed fleet query.

const fs = require('node:fs');
const path = require('node:path');
const { parseExternalActionReceiptLines, externalActionReceiptIdentity } = require('./external-action-identity-log');
const { DEFAULT_FLEET_LIMIT, MAX_QUERY_LINES, readSeals, slug, verifyCollectorSealChain } = require('./external-action-receipt-collector-store');

function withinWindow(receipt, since, until) {
  const at = String(receipt.createdAt || '');
  if (since && at < since) return false;
  if (until && at > until) return false;
  return true;
}

function bump(counter, key) {
  if (!key) return;
  counter[key] = (counter[key] || 0) + 1;
}

/**
 * The fleet view: one row per agent identity, not per receipt.
 *
 * "What has this fleet been doing" is a question about agents, so the answer
 * is grouped by identity and says whether that identity was attested -- an
 * unattested row is a name the host asserted, and reading it as a verified
 * one is the mistake this layer exists to prevent.
 */
function listTenants({ root, workspaceId, ownerActorId }) {
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return [];
  const tenants = [];
  for (const workspace of fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    if (workspaceId && slug(workspaceId) !== workspace.name) continue;
    const workspacePath = path.join(base, workspace.name);
    for (const owner of fs.readdirSync(workspacePath, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      if (ownerActorId && slug(ownerActorId) !== owner.name) continue;
      const directory = path.join(workspacePath, owner.name);
      tenants.push({
        workspaceId: workspace.name,
        ownerActorId: owner.name,
        directory,
        trail: path.join(directory, 'receipts.jsonl'),
      });
    }
  }
  return tenants;
}

/**
 * Audit the counter-seal chain, tenant by tenant.
 *
 * This is the question a seal exists to answer and a stored batch cannot: was
 * anything removed from this store after it was received? A break is reported
 * with its position and reason, because "seal 4 of 9 does not follow seal 3"
 * is actionable where a bare `false` is not.
 *
 * A tenant with no seals is reported as `unsealed` rather than as passing:
 * "nobody sealed this" and "the seals check out" must never read alike.
 */
function verifyCollectorSeals({ root, workspaceId, ownerActorId, trustedKeys = {} } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('verifyCollectorSeals requires a store root');
  const tenants = listTenants({ root, workspaceId, ownerActorId }).map(tenant => {
    const seals = readSeals(tenant.directory);
    if (!seals.length) {
      return { workspaceId: tenant.workspaceId, ownerActorId: tenant.ownerActorId, status: 'unsealed', sealed: 0 };
    }
    const chain = verifyCollectorSealChain(seals, trustedKeys);
    return {
      workspaceId: tenant.workspaceId,
      ownerActorId: tenant.ownerActorId,
      status: chain.ok ? 'verified' : 'broken',
      sealed: seals.length,
      ...(chain.ok
        ? { headSealHash: chain.headSealHash, lastReceivedAt: String(seals.at(-1).receivedAt || '') }
        : { reason: chain.reason, index: chain.index, batchId: chain.batchId }),
    };
  });
  return Object.freeze({
    ok: tenants.every(tenant => tenant.status !== 'broken'),
    tenants,
  });
}

function queryFleet({ root, workspaceId, ownerActorId, since, until, limit = DEFAULT_FLEET_LIMIT } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('queryFleet requires a store root');
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return Object.freeze({ ok: true, agents: [], scanned: 0, tenants: [] });

  const tenants = listTenants({ root, workspaceId, ownerActorId });

  const agents = new Map();
  let scanned = 0;
  let truncated = false;
  for (const tenant of tenants) {
    if (!fs.existsSync(tenant.trail)) continue;
    const { receipts } = parseExternalActionReceiptLines(fs.readFileSync(tenant.trail, 'utf8'));
    for (const receipt of receipts) {
      if (scanned >= MAX_QUERY_LINES) { truncated = true; break; }
      scanned += 1;
      if (!withinWindow(receipt, since, until)) continue;
      const identity = externalActionReceiptIdentity(receipt) || {};
      const key = `${tenant.workspaceId}/${tenant.ownerActorId}/${identity.identityRef || receipt.actor || 'unknown'}`;
      if (!agents.has(key)) {
        agents.set(key, {
          workspaceId: tenant.workspaceId,
          ownerActorId: tenant.ownerActorId,
          identityRef: identity.identityRef || '',
          agentId: identity.agentId || receipt.actor || '',
          attested: Boolean(identity.attested),
          signatureVerified: Boolean(identity.signatureVerified),
          autonomyTier: '',
          total: 0,
          byDecision: {},
          // The collector's finding per receipt, kept separate from
          // `signatureVerified` above: that one is the sending host's claim
          // about its own identity card, this one is what this store checked.
          byBatchSignature: {},
          byIdentitySignature: {},
          firstAt: '',
          lastAt: '',
          lastBlocked: null,
        });
      }
      const agent = agents.get(key);
      agent.total += 1;
      bump(agent.byDecision, receipt.decision);
      bump(agent.byBatchSignature, String(receipt.collector?.bundleSignature || 'unsigned'));
      bump(agent.byIdentitySignature, String(receipt.collector?.identitySignature || 'unattested'));
      // Attestation is per action, so a fleet row claims it only when every
      // action under that identity carried it.
      agent.attested = agent.attested && Boolean(identity.attested);
      agent.signatureVerified = agent.signatureVerified && Boolean(identity.signatureVerified);
      const tier = receipt.metadata?.autonomy?.tier;
      if (tier) agent.autonomyTier = String(tier);
      const at = String(receipt.createdAt || '');
      if (at && (!agent.firstAt || at < agent.firstAt)) agent.firstAt = at;
      if (at && (!agent.lastAt || at > agent.lastAt)) agent.lastAt = at;
      if (receipt.decision === 'block') {
        agent.lastBlocked = { receiptId: receipt.receiptId || '', reason: receipt.reason || '', createdAt: at };
      }
    }
  }

  const rows = [...agents.values()].sort((left, right) => String(right.lastAt).localeCompare(String(left.lastAt)));
  return Object.freeze({
    ok: true,
    scanned,
    truncated,
    tenants: tenants.map(tenant => ({ workspaceId: tenant.workspaceId, ownerActorId: tenant.ownerActorId })),
    agents: rows.slice(0, Math.max(1, Math.min(limit, 1000))),
  });
}

module.exports = {
  queryFleet,
  verifyCollectorSeals,
};
