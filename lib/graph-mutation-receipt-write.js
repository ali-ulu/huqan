'use strict';

/**
 * Delegated from graph.js: chain a mutation receipt, optionally seal it, and
 * store both. Follows the #328 delegation pattern used by graph-node-write.js
 * and graph-edge-write.js -- the class method stays wiring, the decisions live
 * here where they can be read and tested on their own.
 *
 * ## Why the seal is not a column on mutation_receipts
 *
 * validateReceiptChain() recomputes a receipt's hash over every field except
 * `receiptHash`. A seal stored beside the hashed fields would therefore be
 * folded into the recompute -- and since the seal is made *from* the hash,
 * that is circular and would break every chain. Excluding it from the
 * recompute instead would carve an unhashed hole into the one function whose
 * job is to notice tampering.
 *
 * So the seal lives in its own table, keyed by receipt hash. The hashed row is
 * untouched, chain validation is untouched, and the seal points at the receipt
 * rather than the receipt carrying the seal. That is also the correct layering:
 * a signature is over a hash, never inside it.
 *
 * ## Default off
 *
 * With no issuer key configured nothing is sealed: no row, no field, and the
 * receipt written is byte-identical to what this path wrote before. A key that
 * is configured but fails to sign throws rather than committing a receipt that
 * looks sealed to nobody -- see lib/issuer-seal-config.js for the same rule at
 * configuration time.
 */

const { appendReceiptToChain } = require('./receipt/receipt-chain');
const { signIssuerSeal } = require('./receipt/issuer-seal');

const SEAL_TABLE = 'mutation_receipt_seals';

/**
 * Make the seal for an already-chained receipt. Returns null when no key is
 * configured, which is the only way a caller may legitimately end up unsealed.
 */
function sealChainedReceipt(chained, issuerKey, { issuedAt, productVersion } = {}) {
  if (!issuerKey || !issuerKey.privateKeyPem) return null;
  const seal = signIssuerSeal({
    receiptHash: chained.receiptHash,
    receiptId: chained.receiptId,
    workspaceId: chained.workspaceId,
    issuedAt: issuedAt || new Date().toISOString(),
    productVersion: productVersion || '',
  }, { privateKeyPem: issuerKey.privateKeyPem });
  if (!seal) {
    throw new Error(`issuer seal was configured but could not be produced for receipt ${chained.receiptId}`);
  }
  return seal;
}

/**
 * Create the seal table. Additive only: a new table, never an ALTER on the
 * hashed one, so an existing database is unchanged until something seals.
 */
function ensureMutationReceiptSealSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ${SEAL_TABLE} (
      receipt_hash TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      workspace_id TEXT NOT NULL,
      key_id TEXT NOT NULL,
      seal TEXT NOT NULL,
      issued_at TEXT NOT NULL
    )
  `);
}

/**
 * The SQLite write path. `store` is the small surface graph.js hands over:
 * the two prepared statements it owns, plus the clock and configuration it
 * already resolved. Nothing here reaches for a database handle of its own.
 */
function writeChainedMutationReceipt(store, { operationId, payload, receiptFamily }) {
  const previous = store.getLatestReceiptHash(payload.workspaceId, receiptFamily);
  const chained = appendReceiptToChain(payload, previous);
  const committedAt = store.now();
  store.insertReceipt(
    operationId, chained.receiptId, payload.workspaceId, receiptFamily, JSON.stringify(payload),
    chained.previousReceiptHash, chained.receiptHash, committedAt,
  );
  const seal = sealChainedReceipt(chained, store.issuerKey, {
    issuedAt: committedAt,
    productVersion: store.productVersion,
  });
  if (seal) store.insertSeal(seal.receiptHash, seal.receiptId, seal.workspaceId, seal.keyId, JSON.stringify(seal), seal.issuedAt);
  return { chained, committedAt, seal };
}

module.exports = {
  SEAL_TABLE,
  ensureMutationReceiptSealSchema,
  sealChainedReceipt,
  writeChainedMutationReceipt,
};
