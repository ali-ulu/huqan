'use strict';

/**
 * The receiving half of #1781: take receipt batches from the machines that
 * produced them, keep tenants apart, and answer the questions the person who
 * reads receipts actually has -- which agent, when, what was blocked.
 *
 * Self-hosted first, so the store is a directory of append-only JSONL files
 * rather than a service dependency: agent action logs are among the least
 * exportable data an enterprise has, and a collector they cannot run
 * themselves is a collector they will not use. The same shape also makes the
 * store inspectable with the tools they already trust -- `grep`, `wc`, backup.
 *
 * What this module does not do is transport. It validates and stores a batch,
 * and answers queries; an HTTP route is path matching and status mapping on
 * top, the same split the Workbench routes use.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { resolvePathWithinRoot } = require('./path-safety');
const { RECEIPT_BATCH_SCHEMA } = require('./external-action-receipt-shipper');
const {
  parseExternalActionReceiptLines,
  externalActionReceiptIdentity,
} = require('./external-action-identity-log');
const { verifyReceiptBatchSignature } = require('./receipt/signed-receipt-batch');

const MAX_BATCH_RECEIPTS = 1000;
const MAX_QUERY_LINES = 50000;
const DEFAULT_FLEET_LIMIT = 100;

function failure(status, code, message) {
  return Object.freeze({ ok: false, status, error: { code, message } });
}

/**
 * Tenant identifiers arrive from a remote host, so they name a directory only
 * after being reduced to a conservative slug -- and the resolved path is
 * checked against the root anyway. Neither alone is enough: the slug stops
 * `../` from ever forming, the containment check stops anything the slug
 * missed from landing outside the store.
 */
function slug(value) {
  const cleaned = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return cleaned.slice(0, 64) || 'unknown';
}

function tenantDirectory(root, tenant) {
  const target = path.join(path.resolve(root), slug(tenant.workspaceId), slug(tenant.ownerActorId));
  return resolvePathWithinRoot(path.resolve(root), target, { allowMissing: true });
}

function contentHashOf(receipts) {
  return `sha256:${crypto.createHash('sha256').update(JSON.stringify(receipts)).digest('hex')}`;
}

function validateBatch(batch) {
  if (!batch || typeof batch !== 'object' || Array.isArray(batch)) return failure('invalid_request', 'batch_not_an_object', 'batch must be an object');
  if (batch.schemaVersion !== RECEIPT_BATCH_SCHEMA) return failure('invalid_request', 'unsupported_schema', `expected ${RECEIPT_BATCH_SCHEMA}`);
  if (typeof batch.batchId !== 'string' || !batch.batchId.trim()) return failure('invalid_request', 'batch_id_required', 'batchId is required');
  const tenant = batch.tenant;
  if (!tenant || typeof tenant.workspaceId !== 'string' || typeof tenant.ownerActorId !== 'string') {
    return failure('invalid_request', 'tenant_required', 'tenant.workspaceId and tenant.ownerActorId are required');
  }
  if (!Array.isArray(batch.receipts) || !batch.receipts.length) return failure('invalid_request', 'receipts_required', 'receipts must be a non-empty array');
  if (batch.receipts.length > MAX_BATCH_RECEIPTS) return failure('limit_exceeded', 'too_many_receipts', `at most ${MAX_BATCH_RECEIPTS} receipts per batch`);
  // The hash is a transport check, not a signature, and it is treated as
  // exactly that: a mismatch means the batch arrived damaged or rewritten in
  // flight, which is a reason to refuse it, not evidence about its origin.
  if (typeof batch.contentHash === 'string' && batch.contentHash !== contentHashOf(batch.receipts)) {
    return failure('invalid_request', 'content_hash_mismatch', 'contentHash does not match the receipts');
  }
  // A batch is one tenant's, decided by the sender and re-checked here: a
  // collector that accepted a mixed batch would file another tenant's evidence
  // under the wrong owner, which is worse than losing it.
  const foreign = batch.receipts.find(receipt => {
    const identity = externalActionReceiptIdentity(receipt) || {};
    const workspaceId = String(receipt.workspaceId || identity.workspaceId || 'default');
    const ownerActorId = String(identity.ownerActorId || 'unattested');
    return workspaceId !== tenant.workspaceId || ownerActorId !== tenant.ownerActorId;
  });
  if (foreign) return failure('invalid_request', 'mixed_tenant_batch', `receipt ${foreign.receiptId || ''} does not belong to the batch tenant`);
  return { ok: true };
}

function readIndex(target) {
  try { return new Set(JSON.parse(fs.readFileSync(target, 'utf8')).batchIds || []); } catch (_) { return new Set(); }
}

/**
 * What this store can say about a batch's signature, in its own voice.
 *
 * Four answers, and the difference between the middle two is the point:
 * `unsigned` means the sender offered nothing, `unverified` means it offered a
 * signature from a key this deployment was never told to trust. Both are
 * storable; only `verified` is evidence. `invalid` is a signature that failed
 * against the very key it named, which is not a gap but a contradiction.
 *
 * Key distribution stays the deployment's business: the caller passes the
 * public keys it trusts, exactly as the identity-card path does.
 */
function classifyBatchSignature(batch, trustedKeys = {}) {
  const envelope = batch && batch.bundleSignature;
  const keyId = String(envelope?.keyId || '');
  if (!envelope || envelope.status !== 'signed') return { status: 'unsigned', keyId: '' };
  const publicKeyPem = keyId && Object.prototype.hasOwnProperty.call(trustedKeys, keyId) ? trustedKeys[keyId] : '';
  if (!publicKeyPem) return { status: 'unverified', keyId };
  return { status: verifyReceiptBatchSignature(batch, publicKeyPem) ? 'verified' : 'invalid', keyId };
}

/**
 * Load the public keys a deployment has decided to trust: one PEM file per
 * key, the file name without its extension being the `keyId` the sender puts
 * in its signature. A directory rather than a config blob because that is how
 * an operator already handles keys -- copy a file in, remove it to revoke.
 *
 * An unreadable directory yields no keys rather than throwing: a collector
 * with no trusted keys still stores batches, marked `unverified`, which is a
 * truthful state. Failing to boot over it would trade evidence for silence.
 */
function readTrustedBatchKeys(directory) {
  const base = String(directory || '').trim();
  if (!base) return {};
  const keys = {};
  try {
    for (const entry of fs.readdirSync(path.resolve(base), { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      const keyId = entry.name.replace(/\.(pem|pub|key)$/i, '');
      if (!keyId) continue;
      try { keys[keyId] = fs.readFileSync(path.join(path.resolve(base), entry.name), 'utf8'); } catch (_) { /* skip */ }
    }
  } catch (_) {
    return keys;
  }
  return keys;
}

/**
 * Accept a batch into the store.
 *
 * Re-delivery is expected, not exceptional: the shipper re-sends anything a
 * collector did not acknowledge, so a batch already stored is answered
 * `duplicate` and nothing is written twice.
 */
function ingestReceiptBatch({
  batch,
  root,
  receivedAt = new Date().toISOString(),
  trustedKeys = {},
  requireSignature = false,
} = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('ingestReceiptBatch requires a store root');
  const validation = validateBatch(batch);
  if (!validation.ok) return validation;

  const signature = classifyBatchSignature(batch, trustedKeys);
  // An invalid signature is refused whatever the deployment asked for. Absent
  // evidence is a state a collector can honestly record; evidence that fails
  // its own check has already contradicted itself, and storing it would put a
  // line in the trail that reads as sent-and-accepted.
  if (signature.status === 'invalid') {
    return failure('invalid_request', 'batch_signature_invalid', 'batch signature did not verify against its named key');
  }
  if (requireSignature && signature.status !== 'verified') {
    return failure('invalid_request', 'batch_signature_required', `collector requires a verified batch signature, got ${signature.status}`);
  }

  const directory = tenantDirectory(root, batch.tenant);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const indexPath = path.join(directory, 'batches.json');
  const seen = readIndex(indexPath);
  if (seen.has(batch.batchId)) {
    return Object.freeze({ ok: true, status: 'duplicate', batchId: batch.batchId, stored: 0, tenant: batch.tenant });
  }

  const trail = path.join(directory, 'receipts.jsonl');
  const lines = batch.receipts.map(receipt => JSON.stringify({
    ...receipt,
    collector: {
      batchId: batch.batchId,
      receivedAt,
      source: batch.source || {},
      // The collector's own finding, not the sender's claim: `verified` means
      // this store checked the signature against a key it was told to trust,
      // `unverified` that the batch was signed by a key it does not know, and
      // `unsigned` that no signature was offered. A reader can tell which
      // lines are evidence and which are merely records.
      bundleSignature: signature.status,
      signatureKeyId: signature.keyId,
    },
  })).join('\n');
  fs.appendFileSync(trail, `${lines}\n`, { mode: 0o600 });
  fs.writeFileSync(indexPath, `${JSON.stringify({ batchIds: [...seen, batch.batchId] }, null, 2)}\n`, { mode: 0o600 });

  return Object.freeze({
    ok: true,
    status: 'stored',
    batchId: batch.batchId,
    stored: batch.receipts.length,
    tenant: batch.tenant,
    trail,
    signature: Object.freeze({ status: signature.status, keyId: signature.keyId }),
  });
}

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
function queryFleet({ root, workspaceId, ownerActorId, since, until, limit = DEFAULT_FLEET_LIMIT } = {}) {
  if (typeof root !== 'string' || !root.trim()) throw new Error('queryFleet requires a store root');
  const base = path.resolve(root);
  if (!fs.existsSync(base)) return Object.freeze({ ok: true, agents: [], scanned: 0, tenants: [] });

  const tenants = [];
  for (const workspace of fs.readdirSync(base, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
    if (workspaceId && slug(workspaceId) !== workspace.name) continue;
    const workspacePath = path.join(base, workspace.name);
    for (const owner of fs.readdirSync(workspacePath, { withFileTypes: true }).filter(entry => entry.isDirectory())) {
      if (ownerActorId && slug(ownerActorId) !== owner.name) continue;
      tenants.push({ workspaceId: workspace.name, ownerActorId: owner.name, trail: path.join(workspacePath, owner.name, 'receipts.jsonl') });
    }
  }

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
          firstAt: '',
          lastAt: '',
          lastBlocked: null,
        });
      }
      const agent = agents.get(key);
      agent.total += 1;
      bump(agent.byDecision, receipt.decision);
      bump(agent.byBatchSignature, String(receipt.collector?.bundleSignature || 'unsigned'));
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

module.exports = Object.freeze({
  MAX_BATCH_RECEIPTS,
  ingestReceiptBatch,
  queryFleet,
  readTrustedBatchKeys,
});
