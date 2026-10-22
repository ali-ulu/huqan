'use strict';

// Shared fixtures for the evidence-pack tests (#4092): a real emergency-stop
// ledger, built with the same entry hash the ledger itself uses, so a verifier
// is judged against bytes the producer could genuinely have written.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { computeEntryHash } = require('../../lib/emergency-stop-chain');
const { signCollectorSeal, GENESIS_SEAL_HASH } = require('../../lib/receipt/collector-seal');

function ledgerEntries(count = 2) {
  const entries = [];
  let prevHash = null;
  for (let seq = 0; seq < count; seq += 1) {
    const payload = {
      action: seq % 2 === 0 ? 'stop' : 'lift',
      scope: 'workspace',
      workspaceId: 'default',
      agentId: null,
      actor: 'operator:cli',
      reason: `fixture ${seq}`,
      createdAt: `2026-01-0${seq + 1}T00:00:00.000Z`,
    };
    const hash = computeEntryHash(payload, prevHash);
    entries.push({ ...payload, seq, prevHash, hash });
    prevHash = hash;
  }
  return entries;
}

function ledgerBytes(count = 2) {
  return ledgerEntries(count).map((entry) => `${JSON.stringify(entry)}\n`).join('');
}

function generatedKeyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  };
}

/** A tenant's seal chain, signed by `key` under the name `keyId`, exactly as the collector would append it. */
function sealChain(key, keyId, count, { workspaceId = 'default', ownerActorId = 'owner-a' } = {}) {
  const seals = [];
  let previousSealHash = GENESIS_SEAL_HASH;
  for (let i = 0; i < count; i += 1) {
    const seal = signCollectorSeal({
      batchId: `${ownerActorId}-batch-${i}`,
      tenant: { workspaceId, ownerActorId },
      contentHash: `sha256:${String(i).padStart(64, '0')}`,
      count: i + 1,
      receivedAt: `2026-01-1${i}T00:00:00.000Z`,
      previousSealHash,
    }, { keyReference: keyId, privateKeyPem: key.privateKeyPem });
    seals.push({ ...seal });
    previousSealHash = seal.sealHash;
  }
  return seals;
}

/**
 * A collector store on disk (root/<workspace>/<owner>/seals.jsonl) and, apart from it,
 * the directory of public keys a verifier is given. Keys are generated at run time.
 */
function collectorStore(root, { key = generatedKeyPair(), keyId = 'collector-key-1', owners = ['owner-a'], count = 3 } = {}) {
  const store = path.join(root, 'collector-store');
  const pubkeys = path.join(root, 'collector-pubkeys');
  fs.mkdirSync(pubkeys, { recursive: true });
  fs.writeFileSync(path.join(pubkeys, `${keyId}.pem`), key.publicKeyPem);
  const chains = {};
  for (const ownerActorId of owners) {
    const dir = path.join(store, 'default', ownerActorId);
    fs.mkdirSync(dir, { recursive: true });
    chains[ownerActorId] = sealChain(key, keyId, count, { ownerActorId });
    fs.writeFileSync(path.join(dir, 'seals.jsonl'), chains[ownerActorId].map((seal) => `${JSON.stringify(seal)}
`).join(''));
  }
  return { store, pubkeys, key, keyId, chains };
}

module.exports = { ledgerEntries, ledgerBytes, generatedKeyPair, sealChain, collectorStore };
