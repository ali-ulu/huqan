'use strict';

const crypto = require('node:crypto');

const GENESIS = 'genesis:v4-receipt-chain';

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function expectedEnvelopeVersion(receipts) {
  return receipts.some((r) => r && r.schemaVersion === 'v4-receipt-v2')
    ? 'v4-receipt-bundle-v2'
    : 'v4-receipt-bundle-v1';
}

const BUNDLE_SEAL_VERSION = 'huqan-bundle-seal-v2';

const BUNDLE_FIELDS = new Set([
  'sealVersion',
  'schemaVersion',
  'workspaceId',
  'exportedAt',
  'receiptCount',
  'bundleHash',
  'receipts',
]);

function validateBundleEnvelope(bundle) {
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) {
    return 'invalid_bundle_envelope:object';
  }

  for (const field of BUNDLE_FIELDS) {
    if (!Object.prototype.hasOwnProperty.call(bundle, field)) {
      return `invalid_bundle_envelope:missing:${field}`;
    }
  }

  if (bundle.sealVersion !== BUNDLE_SEAL_VERSION) {
    return 'invalid_bundle_envelope:sealVersion';
  }

  const unknown = Object.keys(bundle).filter((field) => !BUNDLE_FIELDS.has(field));
  if (unknown.length > 0) return `invalid_bundle_envelope:unknown:${unknown[0]}`;

  if (!['v4-receipt-bundle-v1', 'v4-receipt-bundle-v2'].includes(bundle.schemaVersion)) {
    return 'invalid_bundle_envelope:schemaVersion';
  }
  if (typeof bundle.workspaceId !== 'string' || !bundle.workspaceId.trim()) {
    return 'invalid_bundle_envelope:workspaceId';
  }
  if (typeof bundle.exportedAt !== 'string' || !bundle.exportedAt.trim()) {
    return 'invalid_bundle_envelope:exportedAt';
  }
  if (!Number.isInteger(bundle.receiptCount) || bundle.receiptCount < 0) {
    return 'invalid_bundle_envelope:receiptCount';
  }
  if (typeof bundle.bundleHash !== 'string' || !/^[0-9a-f]{64}$/.test(bundle.bundleHash)) {
    return 'invalid_bundle_envelope:bundleHash';
  }
  if (!Array.isArray(bundle.receipts)) {
    return 'invalid_bundle_envelope:receipts';
  }
  return null;
}

function verifyBundle(bundle) {
  const envelopeFinding = validateBundleEnvelope(bundle);
  if (envelopeFinding) return [envelopeFinding];

  const findings = [];
  const { receipts } = bundle;

  // The seal covers the envelope, not just the receipts (#735, #767), so a
  // relabelled workspaceId/exportedAt/receiptCount is caught here.
  const sealPayload = {
    sealVersion: BUNDLE_SEAL_VERSION,
    schemaVersion: bundle.schemaVersion,
    workspaceId: bundle.workspaceId,
    exportedAt: bundle.exportedAt,
    receiptCount: bundle.receiptCount,
    receipts,
  };
  if (sha256Hex(canonicalJson(sealPayload)) !== bundle.bundleHash) {
    findings.push('bundle_seal_mismatch');
  }
  if (bundle.schemaVersion !== expectedEnvelopeVersion(receipts)) {
    findings.push('envelope_version_mismatch');
  }
  if (bundle.receiptCount !== receipts.length) {
    findings.push('receipt_count_mismatch');
  }

  for (let i = 0; i < receipts.length; i += 1) {
    const record_ = receipts[i];
    if (!record_ || typeof record_ !== 'object'
        || !record_.receiptHash || !record_.previousReceiptHash) {
      findings.push(`content_tampered@${i}`);
      break;
    }
    const rest = { ...record_ };
    delete rest.receiptHash;
    if (sha256Hex(canonicalJson(rest)) !== record_.receiptHash) {
      findings.push(`content_tampered@${i}`);
      break;
    }
    if (i === 0) {
      if (record_.previousReceiptHash !== GENESIS) {
        findings.push(`genesis_mismatch@${i}`);
        break;
      }
    } else if (record_.previousReceiptHash !== receipts[i - 1].receiptHash) {
      findings.push(`chain_link_broken@${i}`);
      break;
    }
  }

  return findings;
}

function emptyValidBundle() {
  const envelope = {
    sealVersion: BUNDLE_SEAL_VERSION,
    schemaVersion: 'v4-receipt-bundle-v1',
    workspaceId: 'default',
    exportedAt: '2026-01-01T00:00:00.000Z',
    receiptCount: 0,
    receipts: [],
  };
  return { ...envelope, bundleHash: sha256Hex(canonicalJson(envelope)) };
}

module.exports = {
  GENESIS,
  BUNDLE_SEAL_VERSION,
  BUNDLE_FIELDS,
  canonicalize,
  canonicalJson,
  sha256Hex,
  expectedEnvelopeVersion,
  validateBundleEnvelope,
  verifyBundle,
  emptyValidBundle,
};
