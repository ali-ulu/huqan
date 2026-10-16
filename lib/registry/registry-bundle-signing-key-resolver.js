'use strict';

/**
 * Bind a portable receipt-bundle signature to an admitted registry record.
 *
 * The registry record is not itself a second key store: it names the one
 * receiver-owned trust-root reference. Every resolution re-checks that record
 * and then calls the existing trusted-key resolver, so a revocation reaches
 * bundle verification without a copied authority file or stale cache.
 */

const crypto = require('node:crypto');
const { resolveRegistryRecordForRead } = require('./registry-record-shape');
const { resolveTrustedKeyState } = require('../receipt/trusted-key-resolver');

function createRegistryBundleSigningKeyResolver({ registryRecord, trustedKeyRecords, evaluationTime } = {}) {
  const read = resolveRegistryRecordForRead({ record: registryRecord, trustedKeyRecords, evaluationTime });
  if (!read.ok) return () => null;

  return (keyReference) => {
    // A signature cannot select an arbitrary active authority key. It is bound
    // to the key the registry admitted for this exact identity.
    if (keyReference !== read.record.trustRootReference) return null;
    const resolved = resolveTrustedKeyState({ keyReference, records: trustedKeyRecords, evaluationTime });
    if (resolved.keyState !== 'active' || !Buffer.isBuffer(resolved.publicKeySpkiDer)) return null;
    try {
      return crypto.createPublicKey({ key: resolved.publicKeySpkiDer, format: 'der', type: 'spki' })
        .export({ type: 'spki', format: 'pem' }).toString();
    } catch (_) { return null; }
  };
}

module.exports = Object.freeze({ createRegistryBundleSigningKeyResolver });
