'use strict';

/**
 * V5-C4 — Public-safe trust receipt: schema, redaction policy and fixtures.
 *
 * Controlling pack:
 * docs/task-packs/v5-c4-public-safe-receipt-authorization.md
 *
 * The shaping decision under test: a public receipt REFERENCES an internal
 * receipt, it is not a redacted copy of one. Canonical receipt content
 * including metadata participates in the internal hash semantics, so a subset
 * of an internal receipt would fail internal chain validation. The
 * falsification block below proves that rather than assuming it.
 *
 * Evidence level: self-test. Same repository, same author.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { CANONICAL_VERDICTS } = require('../lib/verdict/action-verdict');
// Used only to prove the public format is NOT accepted as internal, and to
// recompute an internal hash for the falsification check.
const { hashCanonicalReceiptPayload, REQUIRED_RECEIPT_FIELDS } = require('../lib/receipt/canonical-receipt');

const V5 = path.join(__dirname, '..', 'schemas', 'v5');
const FIXTURES = path.join(__dirname, 'fixtures', 'v5', 'public-trust-receipt');
const BUNDLE = path.join(__dirname, '..', 'specs', 'axiom-trust-protocol', '0.1',
  'examples', 'receipt-bundle.valid.json');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const schema = readJson(path.join(V5, 'public-trust-receipt.schema.json'));
const internalSchemaPath = path.join(V5, 'agent-identity.schema.json');
const policy = readJson(path.join(V5, 'public-receipt-redaction-policy.json'));
const fixture = (name) => readJson(path.join(FIXTURES, name));
const bundle = readJson(BUNDLE);
const internalReceipt = bundle.receipts[0];

// --- canonicalization reused from RECEIPT-BUNDLE.md, never redefined --------

function canonicalJson(value) {
  const sort = (v) => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      const out = {};
      for (const k of Object.keys(v).sort()) out[k] = sort(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}
const sha256Hex = (t) => crypto.createHash('sha256').update(t, 'utf8').digest('hex');

function computeChecksum(receipt) {
  const { checksum, ...integrityWithout } = receipt.integrity;
  return sha256Hex(canonicalJson({ ...receipt, integrity: integrityWithout }));
}

// --- JSON Schema subset covering what this schema uses ----------------------

function validate(value, node, root, at = '') {
  const errors = [];
  if (node.$ref) {
    const target = node.$ref.replace(/^#\//, '').split('/').reduce((n, k) => n[k], root);
    return validate(value, target, root, at);
  }
  if (node.oneOf) {
    const passed = node.oneOf.filter((sub) => validate(value, sub, root, at).length === 0);
    return passed.length === 1 ? [] : [`${at}: matched ${passed.length} of oneOf`];
  }
  const types = Array.isArray(node.type) ? node.type : (node.type ? [node.type] : []);
  const matches = (t) => (
    (t === 'object' && value && typeof value === 'object' && !Array.isArray(value))
    || (t === 'array' && Array.isArray(value))
    || (t === 'string' && typeof value === 'string')
    || (t === 'number' && typeof value === 'number')
    || (t === 'boolean' && typeof value === 'boolean')
    || (t === 'null' && value === null)
  );
  if (types.length && !types.some(matches)) return [`${at || '<root>'}: expected ${types.join('|')}`];
  if (node.const !== undefined && value !== node.const) errors.push(`${at}: must equal ${node.const}`);
  if (node.enum && !node.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${at}: too short`);
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${at}: pattern mismatch`);
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const req of node.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push(`${at}: missing "${req}"`);
    }
    if (node.additionalProperties === false && node.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(node.properties, key)) errors.push(`${at}: unexpected "${key}"`);
      }
    }
    for (const [key, sub] of Object.entries(node.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validate(value[key], sub, root, at ? `${at}.${key}` : key));
      }
    }
  }
  return errors;
}
const validatePublic = (r) => validate(r, schema, schema);

describe('V5-C4: the public/internal boundary holds in both directions', () => {
  const valid = fixture('valid.public-receipt.json');

  it('the public schemaVersion is distinct from every internal one', () => {
    assert.equal(schema.properties.schemaVersion.const, 'v5-public-trust-receipt-v1');
    for (const internalVersion of policy.appliesTo.internalSchemaVersions) {
      assert.notEqual(schema.properties.schemaVersion.const, internalVersion);
    }
  });

  it('a public receipt is not a valid internal canonical receipt', () => {
    for (const required of REQUIRED_RECEIPT_FIELDS) {
      assert.equal(valid[required], undefined,
        `public receipt must not carry internal required field ${required}`);
    }
  });

  it('an internal receipt is not a valid public receipt', () => {
    assert.notDeepEqual(validatePublic(internalReceipt), []);
  });
});

describe('V5-C4: the redaction policy is machine-readable and default-deny', () => {
  it('the policy is an allowlist the test reads rather than prose', () => {
    assert.ok(Array.isArray(policy.disclosableFields));
    assert.ok(policy.disclosableFields.length > 0);
    assert.deepEqual(
      Object.keys(schema.properties.disclosure.properties).sort(),
      [...policy.disclosableFields].sort(),
      'schema disclosure fields must equal the policy allowlist exactly',
    );
    assert.equal(schema.properties.disclosure.additionalProperties, false,
      'default-deny: an internal field added later cannot leak');
  });

  it('every leak-surface field is withheld with a stated reason', () => {
    for (const field of ['workspaceId', 'actor', 'agentId', 'admissionId', 'memoryDraftId',
      'provenanceId', 'approvalId', 'reason', 'metadata']) {
      assert.ok(policy.withheldFields[field], `${field} must be withheld with a reason`);
      assert.equal(policy.disclosableFields.includes(field), false);
      assert.equal(schema.properties.disclosure.properties[field], undefined);
    }
  });

  it('the receiptId decision is recorded with a justification, not made silently', () => {
    assert.ok(policy.receiptIdDecision.decision);
    assert.ok(policy.receiptIdDecision.rule);
    assert.ok(policy.receiptIdDecision.justification.length > 200,
      'the pack required a written justification, not a label');
    assert.equal(policy.receiptIdDecision.notUnlinkable, true,
      'the format must not imply unlinkability while binding is mandatory');
  });

  it('the disclosed verdict reuses the canonical vocabulary', () => {
    assert.deepEqual(schema.properties.disclosure.properties.verdict.enum, CANONICAL_VERDICTS);
  });
});

describe('V5-C4: integrity — checksum mandatory, signature contracted but absent', () => {
  const valid = fixture('valid.public-receipt.json');

  it('the checksum is mandatory and recomputes', () => {
    assert.ok(schema.properties.integrity.required.includes('checksum'));
    assert.equal(computeChecksum(valid), valid.integrity.checksum);
  });

  it('the checksum uses the RECEIPT-BUNDLE canonicalization, not a second rule', () => {
    assert.equal(policy.integrity.canonicalizationSource,
      'specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md');
    assert.equal(valid.integrity.checksumAlgorithm, 'sha256-canonical-json-v1');
  });

  it('unsigned is structural, not inferred from absence', () => {
    assert.ok(schema.properties.integrity.required.includes('signed'));
    assert.ok(schema.properties.integrity.required.includes('signature'));
    const unsigned = fixture('valid.unsigned-marked.json');
    assert.equal(unsigned.integrity.signed, false);
    assert.equal(unsigned.integrity.signature, null);
    assert.deepEqual(validatePublic(unsigned), []);
  });

  it('signed and signature are coupled by the schema, not by convention', () => {
    // Review finding: declaring both fields required left signed:true with a
    // null signature, and signed:false with a signature object, both
    // expressible. "Structurally distinguishable" was a claim the schema did
    // not enforce until this oneOf existed.
    const branches = schema.properties.integrity.oneOf;
    assert.equal(branches.length, 2);
    const unsignedBranch = branches.find((b) => b.properties.signed.const === false);
    const signedBranch = branches.find((b) => b.properties.signed.const === true);
    assert.equal(unsignedBranch.properties.signature.type, 'null');
    assert.equal(signedBranch.properties.signature.type, 'object');
    assert.equal(signedBranch.properties.signature.properties.profileId.const, 'ed25519-v1');
  });

  it('signed:true with a null signature is rejected', () => {
    const r = fixture('invalid.signed-true-null-signature.json');
    assert.equal(computeChecksum(r), r.integrity.checksum,
      'the checksum is intact, so only the coupling can reject this');
    assert.notDeepEqual(validatePublic(r), []);
  });

  it('signed:false with a signature object is rejected', () => {
    const r = fixture('invalid.signed-false-object-signature.json');
    assert.equal(computeChecksum(r), r.integrity.checksum,
      'the checksum is intact, so only the coupling can reject this');
    assert.notDeepEqual(validatePublic(r), []);
  });

  it('no fixture presents a placeholder as a real signature', () => {
    for (const name of fs.readdirSync(FIXTURES)) {
      const text = fs.readFileSync(path.join(FIXTURES, name), 'utf8');
      assert.doesNotMatch(text, /synthetic-signature-placeholder|test-structural-v1/,
        `${name} must not present placeholder signing as evidence`);
    }
  });

  it('the signature profile is contracted to ed25519-v1 and never satisfied by a placeholder', () => {
    const signatureObject = schema.properties.integrity.properties.signature.oneOf
      .find((s) => s.type === 'object');
    assert.equal(signatureObject.properties.profileId.const, 'ed25519-v1');
    assert.equal(policy.integrity.signatureRequired, false);
    assert.match(policy.integrity.signatureNote, /#435/);
  });
});

describe('V5-C4: the assurance claims match what a keyless checksum can do', () => {
  it('nothing claims the checksum proves the document was not altered', () => {
    const text = fs.readFileSync(path.join(V5, 'public-trust-receipt.schema.json'), 'utf8')
      + fs.readFileSync(path.join(V5, 'public-receipt-redaction-policy.json'), 'utf8');
    assert.doesNotMatch(text, /proves the document was not altered/i);
    assert.doesNotMatch(text, /tamper-evidence/i);
  });

  it('a capable editor can rewrite the document and reseal it, and the policy says so', () => {
    // The concrete reason the claim had to come down.
    const forged = JSON.parse(JSON.stringify(fixture('valid.public-receipt.json')));
    forged.disclosure.decision = 'block';
    const { checksum, ...rest } = forged.integrity;
    forged.integrity.checksum = sha256Hex(canonicalJson({ ...forged, integrity: rest }));
    assert.deepEqual(validatePublic(forged), [], 'a resealed forgery is schema-valid');
    assert.equal(computeChecksum(forged), forged.integrity.checksum, 'and its checksum verifies');
    assert.notEqual(forged.disclosure.decision, fixture('valid.public-receipt.json').disclosure.decision);
    assert.match(policy.integrity.assuranceLevels.checksum, /does not prove the document was not altered/i);
  });

  it('the three assurance levels are recorded separately', () => {
    const levels = policy.integrity.assuranceLevels;
    assert.match(levels.checksum, /corruption and self-consistency/i);
    assert.match(levels.signature, /issuer and authorship/i);
    assert.match(levels.externalHashComparison, /obtained separately/i);
  });

  it('binding claims correspondence rather than proving it', () => {
    const description = schema.properties.binding.description;
    assert.doesNotMatch(description, /proving this summarizes a real/i);
    assert.match(description, /CLAIMS/);
    assert.match(description, /obtained separately/i);
  });
});

describe('V5-C4: every negative fixture fails closed', () => {
  const cases = [
    ['invalid.checksum-mismatch.json', 'checksum'],
    ['invalid.signed-true-null-signature.json', 'coupling'],
    ['invalid.signed-false-object-signature.json', 'coupling'],
    ['invalid.leak-workspace-id.json', 'workspaceId'],
    ['invalid.leak-metadata.json', 'metadata'],
    ['invalid.leak-reason.json', 'reason'],
    ['invalid.unknown-field.json', 'futureInternalField'],
    ['invalid.binding-wrong-receipt-hash.json', 'binding'],
  ];

  for (const [name, marker] of cases) {
    it(`${name} is rejected (${marker})`, () => {
      const r = fixture(name);
      const schemaErrors = validatePublic(r);
      const checksumOk = computeChecksum(r) === r.integrity.checksum;
      const bindingOk = r.binding.internalReceiptHash === internalReceipt.receiptHash;
      const rejected = schemaErrors.length > 0 || !checksumOk || !bindingOk;
      assert.ok(rejected, `${name} must fail closed`);
    });
  }

  it('leaked and unknown fields are rejected by the schema itself, not by a later check', () => {
    for (const name of ['invalid.leak-workspace-id.json', 'invalid.leak-metadata.json',
      'invalid.leak-reason.json', 'invalid.unknown-field.json']) {
      const errors = validatePublic(fixture(name));
      assert.ok(errors.some((e) => e.includes('unexpected')),
        `${name} should be rejected as an unexpected disclosure field`);
    }
  });

  it('no negative fixture merely warns', () => {
    for (const [name] of cases) {
      const r = fixture(name);
      const passes = validatePublic(r).length === 0
        && computeChecksum(r) === r.integrity.checksum
        && r.binding.internalReceiptHash === internalReceipt.receiptHash;
      assert.equal(passes, false, `${name} must not be accepted`);
    }
  });
});

describe('V5-C4: round-trip', () => {
  it('export then import reproduces the same document and checksum', () => {
    const exported = fixture('valid.public-receipt.json');
    const reimported = JSON.parse(JSON.stringify(exported));
    assert.deepEqual(reimported, exported);
    assert.equal(computeChecksum(reimported), exported.integrity.checksum);
    assert.equal(canonicalJson(reimported), canonicalJson(exported));
    assert.deepEqual(fixture('valid.round-trip.json'), exported);
  });

  it('the binding matches a bundle a recipient could already hold', () => {
    const valid = fixture('valid.public-receipt.json');
    assert.equal(valid.binding.internalReceiptHash, internalReceipt.receiptHash);
    assert.equal(valid.binding.bundleHash, bundle.bundleHash);
  });
});

describe('V5-C4: falsification — is the public format a subset of the internal one?', () => {
  it('redacting an internal receipt does not reproduce its internal receiptHash', () => {
    // Apply the policy as a subtraction, which is exactly what C4 refuses to do,
    // and hash the result with the INTERNAL rule.
    const redacted = {};
    for (const field of policy.disclosableFields) redacted[field] = internalReceipt[field];
    redacted.previousReceiptHash = internalReceipt.previousReceiptHash;

    const redactedHash = hashCanonicalReceiptPayload(redacted);
    assert.notEqual(redactedHash, internalReceipt.receiptHash,
      'if these were equal the public format would be a subset, and the correct '
      + 'outcome would be V5_C4_PUBLIC_SAFE_RECEIPT_BLOCKED_GAP');
  });

  it('which is why the public receipt binds by hash instead of carrying a subset', () => {
    const valid = fixture('valid.public-receipt.json');
    assert.ok(schema.properties.binding.required.includes('internalReceiptHash'));
    assert.equal(valid.binding.internalReceiptHash, internalReceipt.receiptHash);
    // The internal hash is referenced, and the internal payload is not present.
    assert.equal(valid.disclosure.metadata, undefined);
    assert.equal(valid.disclosure.reason, undefined);
  });

  it('the internal receipt and its chain are untouched by this gate', () => {
    assert.equal(internalReceipt.schemaVersion, 'v4-receipt-v1');
    assert.equal(hashCanonicalReceiptPayload(
      Object.fromEntries(Object.entries(internalReceipt).filter(([k]) => k !== 'receiptHash')),
    ), internalReceipt.receiptHash);
  });
});
