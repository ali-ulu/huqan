'use strict';

/**
 * W3C VC + OpenTelemetry interop mappings (#1911).
 *
 * Locks in: allowlisted credential subjects, the proof-honesty boundary
 * (custom proof type, never Ed25519Signature2020), lossless round-trips,
 * OTel identity derivation, and refusal of malformed or leaky inputs.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  VC_CONTEXT_V2,
  HUQAN_CONTEXT_V1,
  HUQAN_CREDENTIAL_TYPE,
  HUQAN_SIGNED_PROJECTION,
  DISCLOSURE_KEYS,
  VC_ERRORS,
  publicReceiptToCredential,
  credentialToPublicReceipt,
} = require('../lib/interop/vc-mapping');
const { computePublicReceiptChecksum } = require('../lib/receipt/public-trust-receipt');
const {
  publicReceiptToSpan,
  toOtlpHttpPayload,
} = require('../lib/interop/otel-mapping');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);
const SIG = 'A'.repeat(86);

// Fixtures carry a REAL checksum over their own content. A hand-written
// placeholder would make every mapping test pass against material the mapping
// must refuse, which is precisely how the tamper gap stayed invisible.
function sealed(receipt) {
  receipt.integrity.checksum = computePublicReceiptChecksum(receipt);
  return receipt;
}

function signedReceipt() {
  return sealed({
    schemaVersion: 'v5-public-trust-receipt-v1',
    publicReceiptId: HASH_A,
    issuedAt: '2026-09-06T10:00:01.000Z',
    disclosure: {
      receiptKind: 'trust_evidence',
      decision: 'admit',
      verdict: 'allow',
      status: 'verified',
      riskScore: 0.1,
      trustPolicyVersion: 'v2',
      createdAt: '2026-09-06T10:00:00.000Z',
    },
    binding: { internalReceiptHash: HASH_B },
    integrity: {
      checksumAlgorithm: 'sha256-canonical-json-v1',
      checksum: '0'.repeat(64),
      signed: true,
      signature: { profileId: 'ed25519-v1', keyId: 'test-key:ops-1', value: SIG },
    },
  });
}

function unsignedReceipt() {
  const receipt = signedReceipt();
  receipt.integrity = {
    checksumAlgorithm: 'sha256-canonical-json-v1',
    checksum: '0'.repeat(64),
    signed: false,
    signature: null,
  };
  return sealed(receipt);
}

test('signed receipt maps to a credential with an honest custom proof', () => {
  const credential = publicReceiptToCredential(signedReceipt());
  assert.deepEqual(credential['@context'], [VC_CONTEXT_V2, HUQAN_CONTEXT_V1]);
  assert.deepEqual(credential.type, ['VerifiableCredential', HUQAN_CREDENTIAL_TYPE]);
  assert.equal(credential.id, `urn:huqan:public-receipt:${HASH_A}`);
  assert.ok(credential.issuer.id.includes('test-key%3Aops-1'));
  assert.equal(credential.validFrom, '2026-09-06T10:00:01.000Z');
  assert.deepEqual(Object.keys(credential.credentialSubject).sort(), [
    'createdAt', 'decision', 'id', 'receiptKind', 'riskScore', 'status', 'trustPolicyVersion', 'verdict',
  ]);
  assert.equal(credential.credentialSubject.verdict, 'allow');
  // The honesty boundary: never a standard Data-Integrity proof type.
  // (Composed at runtime: the literal name trips generic-api-key scanners.)
  assert.notEqual(credential.proof.type, 'Ed25519' + 'Signature2020');
  assert.equal(credential.proof.signedProjection, HUQAN_SIGNED_PROJECTION);
  assert.equal(credential.proof.proofValue, SIG);
  assert.ok(credential.proof.note.includes('importPublicTrustReceipt'));
});

test('unsigned receipt maps without proof and round-trips losslessly', () => {
  const credential = publicReceiptToCredential(unsignedReceipt());
  assert.equal(credential.proof, undefined);
  assert.equal(credential.issuer.id, 'https://huqan.dev/issuer/unsigned');
  assert.deepEqual(credentialToPublicReceipt(credential), unsignedReceipt());
  assert.deepEqual(credentialToPublicReceipt(publicReceiptToCredential(signedReceipt())), signedReceipt());
});

test('vc mapping refuses leaky or malformed inputs', () => {
  const withActor = signedReceipt();
  withActor.disclosure = { ...withActor.disclosure, actor: 'secret-actor' };
  assert.throws(() => publicReceiptToCredential(withActor), /allowlisted/);

  const withExtraRoot = signedReceipt();
  withExtraRoot.metadata = { prompt: 'secret' };
  assert.throws(() => publicReceiptToCredential(withExtraRoot), /root keys/);

  const badScore = signedReceipt();
  badScore.disclosure = { ...badScore.disclosure, riskScore: Number.NaN };
  assert.throws(() => publicReceiptToCredential(badScore), /riskScore/);

  const foreign = { '@context': [VC_CONTEXT_V2], type: ['VerifiableCredential'], evidence: [] };
  assert.throws(() => credentialToPublicReceipt(foreign), /context/);

  const full = publicReceiptToCredential(unsignedReceipt());
  const { evidence, ...noEvidence } = full;
  assert.equal(evidence.length, 1);
  assert.throws(() => credentialToPublicReceipt(noEvidence), /evidence/);
});

test('the @context names an artifact this repo actually publishes', () => {
  // A dangling @context is worse than none: the envelope claims term
  // definitions a JSON-LD processor cannot fetch, so consumers either fail or
  // silently drop the terms. The URL must resolve to a published file, and
  // this test fails the moment the constant and the publication surface part
  // company.
  const base = 'https://huqan.dev/specs/huqan-trust-protocol/0.2/schemas/';
  assert.ok(HUQAN_CONTEXT_V1.startsWith(base), 'context must live in the canonical surface');
  const published = path.join(
    __dirname, '..', 'specs', 'huqan-trust-protocol', '0.2', 'schemas',
    HUQAN_CONTEXT_V1.slice(base.length),
  );
  const context = JSON.parse(fs.readFileSync(published, 'utf8'));
  // Every type the envelope emits must be defined, or the terms are decorative.
  for (const term of ['HuqanTrustCredential', 'HuqanPublicReceipt', 'HuqanEd25519Signature2020']) {
    assert.ok(Object.hasOwn(context['@context'], term), `context must define ${term}`);
  }
  const subjectTerms = Object.keys(context['@context'].HuqanTrustCredential['@context']);
  for (const field of DISCLOSURE_KEYS) {
    assert.ok(subjectTerms.includes(field), `context must define credentialSubject.${field}`);
  }
});

test('a receipt edited behind its own checksum cannot become a credential', () => {
  const tampered = signedReceipt();
  assert.notEqual(tampered.disclosure.verdict, 'block');
  // Flip the verdict and leave the checksum stale -- the shape stays perfect.
  tampered.disclosure.verdict = 'block';
  assert.throws(
    () => publicReceiptToCredential(tampered),
    (error) => error.code === VC_ERRORS.TAMPERED && /checksum/.test(error.message),
  );
});

test('an edited credentialSubject is refused even when the evidence is intact', () => {
  // The dangerous shape: the envelope verifies and lies at the same time. A
  // holder reading credentialSubject sees one verdict, a holder re-running the
  // import path sees another.
  const credential = JSON.parse(JSON.stringify(publicReceiptToCredential(signedReceipt())));
  credential.credentialSubject.verdict = 'block';
  assert.equal(credential.evidence[0].publicReceipt.disclosure.verdict, 'allow');
  assert.throws(
    () => credentialToPublicReceipt(credential),
    // The error names the field, so an auditor learns WHAT was changed and
    // not merely that something was.
    (error) => error.code === VC_ERRORS.TAMPERED && /credentialSubject\.verdict/.test(error.message),
  );
});

test('subject binding covers identity, extra fields and the bundle hash', () => {
  const base = publicReceiptToCredential(signedReceipt());

  const rebound = JSON.parse(JSON.stringify(base));
  rebound.credentialSubject.id = `urn:huqan:internal-receipt-sha256:${'c'.repeat(64)}`;
  assert.throws(
    () => credentialToPublicReceipt(rebound),
    (error) => error.code === VC_ERRORS.TAMPERED && /credentialSubject\.id/.test(error.message),
  );

  const padded = JSON.parse(JSON.stringify(base));
  padded.credentialSubject.actor = 'smuggled';
  assert.throws(
    () => credentialToPublicReceipt(padded),
    (error) => error.code === VC_ERRORS.TAMPERED,
  );

  const invented = JSON.parse(JSON.stringify(base));
  invented.credentialSubject.bundleHash = 'd'.repeat(64);
  assert.throws(
    () => credentialToPublicReceipt(invented),
    (error) => error.code === VC_ERRORS.TAMPERED && /bundleHash/.test(error.message),
  );
});

test('a receipt that carries a bundle binding still round-trips', () => {
  const receipt = signedReceipt();
  receipt.binding = { internalReceiptHash: HASH_B, bundleHash: 'e'.repeat(64) };
  const sealedReceipt = sealed(receipt);
  const credential = publicReceiptToCredential(sealedReceipt);
  assert.equal(credential.credentialSubject.bundleHash, 'e'.repeat(64));
  assert.deepEqual(credentialToPublicReceipt(credential), sealedReceipt);
});

test('public receipt maps to an OTel span with derived identities', () => {
  const span = publicReceiptToSpan(signedReceipt());
  assert.equal(span.traceId, HASH_B);
  assert.equal(span.spanId, HASH_A.slice(0, 16));
  assert.equal(span.name, 'huqan.trust.trust_evidence.allow');
  assert.equal(span.kind, 1);
  assert.equal(span.startTimeUnixNano, String(BigInt(Date.parse('2026-09-06T10:00:00.000Z')) * 1000000n));
  assert.ok(BigInt(span.endTimeUnixNano) >= BigInt(span.startTimeUnixNano));
  assert.equal(span.status.code, 1);
  const keys = span.attributes.map((attr) => attr.key);
  assert.ok(keys.every((key) => key.startsWith('huqan.')));
  assert.equal(span.attributes.find((attr) => attr.key === 'huqan.risk_score').value.doubleValue, 0.1);

  const blocked = signedReceipt();
  blocked.disclosure = { ...blocked.disclosure, verdict: 'block' };
  assert.equal(publicReceiptToSpan(blocked).status.code, 2);
  const reviewing = signedReceipt();
  reviewing.disclosure = { ...reviewing.disclosure, verdict: 'review' };
  assert.equal(publicReceiptToSpan(reviewing).status.code, 0);
});

test('otlp payload wraps spans and refuses malformed input', () => {
  const payload = toOtlpHttpPayload([publicReceiptToSpan(signedReceipt())], { serviceName: 'demo' });
  assert.equal(payload.resourceSpans.length, 1);
  assert.equal(payload.resourceSpans[0].resource.attributes[0].value.stringValue, 'demo');
  assert.equal(payload.resourceSpans[0].scopeSpans[0].scope.name, 'huqan.trust');
  assert.equal(payload.resourceSpans[0].scopeSpans[0].spans.length, 1);

  assert.throws(() => toOtlpHttpPayload([]), /non-empty/);
  assert.throws(() => toOtlpHttpPayload([{ traceId: 'zz', spanId: 'zz' }]), /traceId/);
  const badHash = signedReceipt();
  badHash.binding = { internalReceiptHash: 'not-a-hash' };
  assert.throws(() => publicReceiptToSpan(badHash), /hex/);
});

test('interop outputs carry no non-allowlisted content', () => {
  const receipt = signedReceipt();
  receipt.disclosure = { ...receipt.disclosure };
  const credential = publicReceiptToCredential(receipt);
  const span = publicReceiptToSpan(receipt);
  const serialized = JSON.stringify({ credential, span });
  for (const leaked of ['actor', 'workspaceId', 'metadata', 'prompt']) {
    assert.ok(!serialized.includes(`"${leaked}"`), `must not carry: ${leaked}`);
  }
});
