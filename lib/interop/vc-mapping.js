'use strict';

/**
 * W3C Verifiable Credentials envelope for public trust receipts (#1911).
 *
 * Maps a `v5-public-trust-receipt-v1` artifact
 * (specs/huqan-trust-protocol/0.2/schemas/public-trust-receipt.schema.json)
 * onto the W3C Verifiable Credentials Data Model v2.0 shape so that
 * "Huqan-compatible" verifiers (LangChain, CrewAI, Vercel AI SDK adapters)
 * can carry HUQAN evidence inside standard credential tooling.
 *
 * ## Honesty boundary (read before retyping `proof.type`)
 *
 * The Ed25519 signature inside a public receipt covers the HUQAN
 * domain-separated canonical projection
 * (`HUQAN/V5/PUBLIC-TRUST-RECEIPT/v1`, see
 * lib/receipt/public-trust-receipt.js) — it does NOT sign this credential
 * document. Emitting a standard `Ed25519Signature2020` proof here would
 * assert a verification relationship that does not exist, so the proof
 * carries its own type (`HuqanEd25519Signature2020`) plus the signed
 * projection identifier and an explicit note. A verifier MUST re-run the
 * HUQAN import path (checksum, independent receipt/bundle binding, trusted
 * key resolution, cryptographic verification) against the `evidence`-carried
 * public receipt; the envelope is transport, the HUQAN rules are the proof.
 *
 * ## Redaction boundary
 *
 * `credentialSubject` carries exactly the 7 allowlisted disclosure fields —
 * the same allowlist as public-receipt-redaction-policy.json. Input with
 * more, fewer, or mistyped disclosure keys is refused rather than
 * "cleaned", so a future internal field can never slip into a credential.
 *
 * ## Integrity boundary
 *
 * Shape is not integrity, and the two failures that follow from confusing
 * them are both refused here:
 *
 * 1. A receipt whose disclosure was edited while its stale checksum was left
 *    in place is structurally perfect. Mapping it would launder a tampered
 *    receipt into standard credential tooling, so the checksum is verified
 *    on the way in and on the way out.
 * 2. `credentialSubject` is a projection of the receipt in `evidence`, and
 *    nothing in the VC envelope binds them. An edited subject beside an
 *    untouched evidence receipt produces a credential that verifies and lies
 *    at the same time. The evidence receipt is authoritative and divergence
 *    is refused, naming the field that diverged.
 *
 * Both raise `VC_TAMPERED`, kept distinct from the `VC_INVALID_*` codes: the
 * document is well formed, which is exactly what makes it dangerous.
 *
 * The checksum is keyless — it catches corruption and casual edits, not a
 * capable editor who recomputes it. Authenticity still requires the
 * signature check in importPublicTrustReceipt.
 */

const { computePublicReceiptChecksum } = require('../receipt/public-trust-receipt');
// The shared predicate, not a local copy: it is the one the repo's
// single-definition rule points at, and it rejects a hostile proxy instead of
// throwing on it -- which matters on a boundary whose job is refusing input.
const { isPlainObject } = require('../is-plain-object');

const VC_CONTEXT_V2 = 'https://www.w3.org/ns/credentials/v2';
const HUQAN_CONTEXT_V1 = 'https://huqan.dev/ns/trust/v1';
const HUQAN_CREDENTIAL_TYPE = 'HuqanTrustCredential';
const HUQAN_EVIDENCE_TYPE = 'HuqanPublicReceipt';
const HUQAN_PROOF_TYPE = 'HuqanEd25519Signature2020';
const HUQAN_SIGNED_PROJECTION = 'HUQAN/V5/PUBLIC-TRUST-RECEIPT/v1';
const HUQAN_ISSUER_BASE = 'https://huqan.dev/keys/';
const HUQAN_UNSIGNED_ISSUER = 'https://huqan.dev/issuer/unsigned';

const DISCLOSURE_KEYS = Object.freeze([
  'receiptKind',
  'decision',
  'verdict',
  'status',
  'riskScore',
  'trustPolicyVersion',
  'createdAt',
]);

const VC_ERRORS = Object.freeze({
  INVALID_RECEIPT: 'VC_INVALID_PUBLIC_RECEIPT',
  INVALID_CREDENTIAL: 'VC_INVALID_CREDENTIAL',
  UNSIGNED: 'VC_UNSIGNED_RECEIPT',
  // Distinct from INVALID_*: the document is well-formed, and that is exactly
  // what makes it dangerous. A caller may want to alert on this separately.
  TAMPERED: 'VC_TAMPERED',
});

function vcError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const names = Object.keys(value);
  return names.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function assertPublicReceiptShape(receipt) {
  if (!isPlainObject(receipt)) throw vcError(VC_ERRORS.INVALID_RECEIPT, 'public receipt must be an object');
  for (const key of ['schemaVersion', 'publicReceiptId', 'issuedAt', 'disclosure', 'binding', 'integrity']) {
    if (!Object.hasOwn(receipt, key)) throw vcError(VC_ERRORS.INVALID_RECEIPT, `public receipt is missing ${key}`);
  }
  if (receipt.schemaVersion !== 'v5-public-trust-receipt-v1') {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'unsupported public receipt schema version');
  }
  if (!exactKeys(receipt, ['schemaVersion', 'publicReceiptId', 'issuedAt', 'disclosure', 'binding', 'integrity'])) {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'public receipt must carry exactly the schema root keys');
  }
  if (!exactKeys(receipt.disclosure, DISCLOSURE_KEYS)) {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'disclosure must carry exactly the allowlisted fields');
  }
  if (typeof receipt.disclosure.riskScore !== 'number' || !Number.isFinite(receipt.disclosure.riskScore)) {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'disclosure.riskScore must be a finite number');
  }
  const binding = receipt.binding;
  if (!isPlainObject(binding) || typeof binding.internalReceiptHash !== 'string' || !binding.internalReceiptHash) {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'binding.internalReceiptHash is required');
  }
  if (!exactKeys(binding, Object.hasOwn(binding, 'bundleHash')
    ? ['internalReceiptHash', 'bundleHash']
    : ['internalReceiptHash'])) {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'binding must carry only internalReceiptHash and optional bundleHash');
  }
  const integrity = receipt.integrity;
  if (!isPlainObject(integrity) || typeof integrity.signed !== 'boolean') {
    throw vcError(VC_ERRORS.INVALID_RECEIPT, 'integrity.signed must be a boolean');
  }
  if (integrity.signed) {
    const signature = integrity.signature;
    if (!isPlainObject(signature) || signature.profileId !== 'ed25519-v1'
      || typeof signature.keyId !== 'string' || !signature.keyId
      || typeof signature.value !== 'string' || !signature.value) {
      throw vcError(VC_ERRORS.INVALID_RECEIPT, 'signed receipts require an ed25519-v1 signature object');
    }
  }
  // Shape is not integrity. Without this, a receipt whose disclosure was
  // edited while its stale checksum was left in place maps into a well-formed
  // credential asserting the edited values -- the envelope would launder a
  // tampered receipt into standard tooling. The checksum is keyless, so this
  // catches corruption and casual edits; it does not replace the signature
  // check in importPublicTrustReceipt.
  if (typeof integrity.checksum !== 'string'
    || computePublicReceiptChecksum(receipt) !== integrity.checksum) {
    throw vcError(VC_ERRORS.TAMPERED, 'public receipt checksum does not match its content');
  }
  return true;
}

/**
 * credentialSubject is a convenience projection of the receipt carried in
 * `evidence`. Nothing in the envelope binds the two, so an edited subject
 * beside an untouched evidence receipt yields a credential that verifies and
 * lies at once: a holder reading credentialSubject sees one verdict, a holder
 * re-running the import path sees another.
 *
 * The evidence receipt is authoritative. Divergence is refused rather than
 * silently resolved in its favour, and the error names the field that
 * diverged, so an auditor learns what was changed and not merely that
 * something was.
 */
function assertSubjectMatchesEvidence(subject, receipt) {
  if (!isPlainObject(subject)) {
    throw vcError(VC_ERRORS.INVALID_CREDENTIAL, 'credentialSubject must be an object');
  }
  const expectedId = `urn:huqan:internal-receipt-sha256:${receipt.binding.internalReceiptHash}`;
  if (subject.id !== expectedId) {
    throw vcError(VC_ERRORS.TAMPERED, 'credentialSubject.id does not match the evidence receipt binding');
  }
  for (const key of DISCLOSURE_KEYS) {
    if (subject[key] !== receipt.disclosure[key]) {
      throw vcError(VC_ERRORS.TAMPERED, `credentialSubject.${key} does not match the evidence receipt`);
    }
  }
  const expectedBundleHash = receipt.binding.bundleHash;
  if (Object.hasOwn(subject, 'bundleHash') !== (expectedBundleHash !== undefined)
    || (expectedBundleHash !== undefined && subject.bundleHash !== expectedBundleHash)) {
    throw vcError(VC_ERRORS.TAMPERED, 'credentialSubject.bundleHash does not match the evidence receipt');
  }
  if (!exactKeys(subject, expectedBundleHash === undefined
    ? ['id', ...DISCLOSURE_KEYS]
    : ['id', ...DISCLOSURE_KEYS, 'bundleHash'])) {
    throw vcError(VC_ERRORS.TAMPERED, 'credentialSubject carries fields the evidence receipt does not');
  }
}

function issuerFor(receipt) {
  if (receipt.integrity.signed) {
    return { id: `${HUQAN_ISSUER_BASE}${encodeURIComponent(receipt.integrity.signature.keyId)}` };
  }
  return { id: HUQAN_UNSIGNED_ISSUER };
}

function proofFor(receipt) {
  if (!receipt.integrity.signed) return null;
  const keyUrl = `${HUQAN_ISSUER_BASE}${encodeURIComponent(receipt.integrity.signature.keyId)}`;
  return {
    type: HUQAN_PROOF_TYPE,
    cryptosuite: 'huqan-ed25519-v1',
    proofPurpose: 'assertionMethod',
    verificationMethod: `${keyUrl}#ed25519-v1`,
    created: receipt.issuedAt,
    signedProjection: HUQAN_SIGNED_PROJECTION,
    proofValue: receipt.integrity.signature.value,
    note: 'Verifies only against the HUQAN canonical projection via importPublicTrustReceipt (checksum, independent receipt/bundle binding, trusted key resolution). Not a Data-Integrity proof over this document.',
  };
}

function snapshot(value) {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Wraps a canonical public receipt in a W3C VC v2 envelope. The original
 * receipt travels losslessly inside `evidence` so any holder can re-verify
 * it with the HUQAN import path.
 */
function publicReceiptToCredential(receipt) {
  assertPublicReceiptShape(receipt);
  const credential = {
    '@context': [VC_CONTEXT_V2, HUQAN_CONTEXT_V1],
    id: `urn:huqan:public-receipt:${receipt.publicReceiptId}`,
    type: ['VerifiableCredential', HUQAN_CREDENTIAL_TYPE],
    issuer: issuerFor(receipt),
    validFrom: receipt.issuedAt,
    credentialSubject: {
      id: `urn:huqan:internal-receipt-sha256:${receipt.binding.internalReceiptHash}`,
      ...snapshot(receipt.disclosure),
      ...(receipt.binding.bundleHash ? { bundleHash: receipt.binding.bundleHash } : {}),
    },
    evidence: [{ type: HUQAN_EVIDENCE_TYPE, publicReceipt: snapshot(receipt) }],
  };
  const proof = proofFor(receipt);
  if (proof) credential.proof = proof;
  return Object.freeze(credential);
}

/**
 * Extracts and re-validates the HUQAN public receipt carried by a
 * credential produced above. Unknown envelopes are refused.
 */
function credentialToPublicReceipt(credential) {
  if (!isPlainObject(credential)) throw vcError(VC_ERRORS.INVALID_CREDENTIAL, 'credential must be an object');
  const contexts = credential['@context'];
  if (!Array.isArray(contexts) || !contexts.includes(VC_CONTEXT_V2) || !contexts.includes(HUQAN_CONTEXT_V1)) {
    throw vcError(VC_ERRORS.INVALID_CREDENTIAL, 'credential context must include the W3C v2 and HUQAN trust contexts');
  }
  const types = credential.type;
  if (!Array.isArray(types) || !types.includes('VerifiableCredential') || !types.includes(HUQAN_CREDENTIAL_TYPE)) {
    throw vcError(VC_ERRORS.INVALID_CREDENTIAL, 'credential type must include VerifiableCredential and HuqanTrustCredential');
  }
  const evidence = Array.isArray(credential.evidence)
    ? credential.evidence.find((entry) => isPlainObject(entry) && entry.type === HUQAN_EVIDENCE_TYPE)
    : null;
  if (!evidence) throw vcError(VC_ERRORS.INVALID_CREDENTIAL, 'credential carries no HuqanPublicReceipt evidence');
  assertPublicReceiptShape(evidence.publicReceipt);
  assertSubjectMatchesEvidence(credential.credentialSubject, evidence.publicReceipt);
  return snapshot(evidence.publicReceipt);
}

module.exports = {
  VC_CONTEXT_V2,
  HUQAN_CONTEXT_V1,
  HUQAN_CREDENTIAL_TYPE,
  HUQAN_EVIDENCE_TYPE,
  HUQAN_PROOF_TYPE,
  HUQAN_SIGNED_PROJECTION,
  DISCLOSURE_KEYS,
  VC_ERRORS,
  publicReceiptToCredential,
  credentialToPublicReceipt,
};
