'use strict';

/**
 * V5-C5A — the published receipt bundle specification must match the shipped
 * fixtures.
 *
 * The canonicalization and verification helpers below are implemented from
 * `specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md` alone. No producer code
 * implements any of them: reusing the producer's serializer or hasher would
 * prove only that the code agrees with itself, which is the gap the V5-C5 entry
 * audit recorded.
 *
 * There is exactly one producer import, `verifyExportedBundle`, and it is used
 * only to assert that the producer and the clean-room probe reach the same
 * verdict. It never supplies a value this file then checks against itself.
 *
 * Two evidence levels live in this file and should not be conflated:
 *
 *   - the JavaScript assertions below are a SELF-TEST. They keep the document
 *     honest against fixtures this repository produced.
 *   - the `clean-room implementation` block shells out to
 *     conformance/verify_bundle.py, a second implementation written from the
 *     specification that shares no code with the producer. That is
 *     CROSS-IMPLEMENTATION CONFORMANCE.
 *
 * Neither is third-party verification: same author, same repository. See
 * specs/axiom-trust-protocol/0.1/conformance/README.md for the four levels.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// The only producer import in this file, used solely to assert that the
// clean-room probe and the producer agree; never to implement the algorithm.
const { verifyExportedBundle } = require('../lib/receipt/receipt-export');
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const SPEC_DIR = path.join(__dirname, '..', 'specs', 'axiom-trust-protocol', '0.1');
const EXAMPLES = path.join(SPEC_DIR, 'examples');
const GENESIS = 'genesis:v4-receipt-chain';

function readJson(...parts) {
  return JSON.parse(fs.readFileSync(path.join(...parts), 'utf8'));
}

// --- primitives, per the "Primitives" section of RECEIPT-BUNDLE.md ----------

/** Sort object keys ascending at every depth; never reorder arrays. */
function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

/** RFC 8259 JSON, no insignificant whitespace, keys sorted recursively. */
function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

/** SHA-256 over UTF-8 bytes, lowercase hex. */
function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

// --- verification algorithm, per the "Verification algorithm" section -------

function expectedEnvelopeVersion(receipts) {
  return receipts.some((r) => r?.schemaVersion === 'v4-receipt-v2')
    ? 'v4-receipt-bundle-v2'
    : 'v4-receipt-bundle-v1';
}

const SEAL_VERSION = 'huqan-bundle-seal-v2';

/** The spec's sealPayload: envelope fields plus receipts, never bundleHash. */
function sealPayload(bundle) {
  return {
    sealVersion: SEAL_VERSION,
    schemaVersion: bundle.schemaVersion,
    workspaceId: bundle.workspaceId,
    exportedAt: bundle.exportedAt,
    receiptCount: bundle.receiptCount,
    receipts: bundle.receipts,
  };
}

function checkBundleSeal(bundle) {
  if (bundle.sealVersion === SEAL_VERSION) {
    return sha256Hex(canonicalJson(sealPayload(bundle))) === bundle.bundleHash;
  }
  // Earlier seal: receipts only, envelope unauthenticated.
  return sha256Hex(canonicalJson(bundle.receipts)) === bundle.bundleHash;
}

function validateChain(receipts) {
  for (let i = 0; i < receipts.length; i += 1) {
    const record = receipts[i];
    if (!record || typeof record !== 'object'
      || !record.receiptHash || !record.previousReceiptHash) {
      return { valid: false, brokenAt: i, reason: 'content_tampered' };
    }
    const { receiptHash, ...rest } = record;
    if (sha256Hex(canonicalJson(rest)) !== receiptHash) {
      return { valid: false, brokenAt: i, reason: 'content_tampered' };
    }
    if (i === 0) {
      if (record.previousReceiptHash !== GENESIS) {
        return { valid: false, brokenAt: i, reason: 'genesis_mismatch' };
      }
    } else if (record.previousReceiptHash !== receipts[i - 1].receiptHash) {
      return { valid: false, brokenAt: i, reason: 'chain_link_broken' };
    }
  }
  return { valid: true, brokenAt: null, reason: null };
}

// --- a JSON Schema subset sufficient for the shipped schema ----------------
// No validator dependency is added: the pack forbids one. This covers exactly
// the keywords the bundle schema uses.

function validateAgainstSchema(value, schema, root, at = '') {
  const errors = [];
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, '').split('/')
      .reduce((node, key) => node[key], root);
    return validateAgainstSchema(value, target, root, at);
  }
  const type = schema.type;
  const typeOk = type === undefined
    || (type === 'object' && value && typeof value === 'object' && !Array.isArray(value))
    || (type === 'array' && Array.isArray(value))
    || (type === 'string' && typeof value === 'string')
    || (type === 'number' && typeof value === 'number')
    || (type === 'integer' && Number.isInteger(value));
  if (!typeOk) return [`${at || '<root>'}: expected ${type}`];

  if (type === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match ${schema.pattern}`);
    }
    if (schema.enum && !schema.enum.includes(value)) {
      errors.push(`${at}: ${JSON.stringify(value)} not in enum`);
    }
  }
  if (type === 'integer' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: below minimum ${schema.minimum}`);
  }
  if (type === 'array' && schema.items) {
    value.forEach((item, i) => {
      errors.push(...validateAgainstSchema(item, schema.items, root, `${at}[${i}]`));
    });
  }
  if (type === 'object') {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${at}: missing required "${required}"`);
      }
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties, key)) {
          errors.push(`${at}: unexpected property "${key}"`);
        }
      }
    }
    for (const [key, sub] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateAgainstSchema(value[key], sub, root, at ? `${at}.${key}` : key));
      }
    }
  }
  return errors;
}

// --- tests -----------------------------------------------------------------

const havePythonProbe = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

const schema = readJson(SPEC_DIR, 'schemas', 'trust-receipt-bundle.schema.json');
const valid = readJson(EXAMPLES, 'receipt-bundle.valid.json');
const tamperedHash = readJson(EXAMPLES, 'receipt-bundle.tampered-bundle-hash.json');
const brokenChain = readJson(EXAMPLES, 'receipt-bundle.broken-chain.json');
const unicodeValid = readJson(EXAMPLES, 'receipt-bundle.unicode.valid.json');

describe('V5-C5A: the published spec reproduces the shipped fixtures', () => {
  it('all three fixtures match the published schema', () => {
    for (const [name, bundle] of Object.entries({ valid, unicodeValid, tamperedHash, brokenChain })) {
      assert.deepEqual(validateAgainstSchema(bundle, schema, schema), [],
        `${name} must satisfy trust-receipt-bundle.schema.json`);
    }
  });

  it('the documented algorithm reproduces the recorded bundleHash', () => {
    assert.equal(sha256Hex(canonicalJson(sealPayload(valid))), valid.bundleHash);
  });

  it('the documented algorithm reproduces every recorded receiptHash', () => {
    for (const [i, record] of valid.receipts.entries()) {
      const { receiptHash, ...rest } = record;
      assert.equal(sha256Hex(canonicalJson(rest)), receiptHash,
        `receipts[${i}] hash must recompute from its own content`);
    }
  });

  it('the valid fixture passes all four verification checks', () => {
    assert.equal(checkBundleSeal(valid), true, 'bundle seal');
    assert.equal(valid.schemaVersion, expectedEnvelopeVersion(valid.receipts), 'envelope version');
    assert.equal(valid.receiptCount, valid.receipts.length, 'receipt count');
    assert.deepEqual(validateChain(valid.receipts), { valid: true, brokenAt: null, reason: null });
  });

  it('every sealed envelope field is authenticated (#735, #767)', () => {
    // Each of these used to be outside the seal, so a bundle could be
    // relabelled with another workspace or export time and still verify.
    for (const [field, value] of Object.entries({
      workspaceId: 'someone-elses-workspace',
      exportedAt: '2030-06-01T12:00:00.000Z',
      receiptCount: valid.receipts.length + 7,
      schemaVersion: 'v4-receipt-bundle-v2',
    })) {
      const mutated = { ...valid, [field]: value };
      assert.equal(checkBundleSeal(mutated), false, `${field} must be inside the seal`);
      assert.equal(verifyExportedBundle(mutated).valid, false,
        `the producer must reject a mutated ${field} too`);
    }
  });

  it('a bundle whose receiptCount alone is wrong is rejected', () => {
    const mutated = { ...valid, receiptCount: valid.receipts.length + 7 };
    assert.equal(checkBundleSeal(mutated), false);
    const verdict = verifyExportedBundle(mutated);
    assert.equal(verdict.valid, false);
    assert.equal(verdict.receiptCountValid, false);
    // The chain itself is untouched: only the envelope claim is wrong.
    assert.deepEqual(validateChain(mutated.receipts), { valid: true, brokenAt: null, reason: null });
  });

  it('dropping sealVersion does not silently fall back to the earlier seal', () => {
    const { sealVersion: _drop, ...unsealed } = valid;
    const verdict = verifyExportedBundle(unsealed);
    assert.equal(verdict.valid, false, 'an unsealed envelope must not verify by default');
    assert.equal(verdict.envelopeAuthenticated, false);
    assert.equal(verdict.sealVersionAcceptable, false);
  });

  it('the chain links genesis through every record in order', () => {
    assert.equal(valid.receipts[0].previousReceiptHash, GENESIS);
    for (let i = 1; i < valid.receipts.length; i += 1) {
      assert.equal(valid.receipts[i].previousReceiptHash, valid.receipts[i - 1].receiptHash);
    }
  });

  it('exportedAt is inside the seal, so re-exporting changes bundleHash', () => {
    const later = { ...valid, exportedAt: '2030-06-01T12:00:00.000Z' };
    assert.notEqual(sha256Hex(canonicalJson(sealPayload(later))), valid.bundleHash);
  });

  it('an empty bundle is verifiable rather than an error', () => {
    const receipts = [];
    assert.equal(sha256Hex(canonicalJson(receipts)), sha256Hex('[]'));
    assert.deepEqual(validateChain(receipts), { valid: true, brokenAt: null, reason: null });
  });
});

describe('V5-C5A: each negative fixture fails exactly the rule it targets', () => {
  it('tampered-bundle-hash differs from valid by one leaf', () => {
    assert.deepEqual(differingLeaves(valid, tamperedHash), ['bundleHash']);
  });

  it('tampered-bundle-hash fails the bundle seal while the chain still validates', () => {
    assert.equal(checkBundleSeal(tamperedHash), false);
    assert.deepEqual(validateChain(tamperedHash.receipts),
      { valid: true, brokenAt: null, reason: null });
  });

  it('broken-chain differs from valid by one leaf', () => {
    assert.deepEqual(differingLeaves(valid, brokenChain), ['receipts.1.decision']);
  });

  it('broken-chain fails chain self-consistency at index 1, and the seal as a consequence', () => {
    assert.deepEqual(validateChain(brokenChain.receipts),
      { valid: false, brokenAt: 1, reason: 'content_tampered' });
    assert.equal(checkBundleSeal(brokenChain), false,
      'the seal covers the receipts array, so content tampering breaks it too');
  });

  it('a repaired receipt hash still breaks the following link', () => {
    // Why one mutation cannot be patched away: fixing the tampered record's own
    // hash invalidates the link its successor already committed to.
    const repaired = JSON.parse(JSON.stringify(brokenChain));
    const { receiptHash: _drop, ...rest } = repaired.receipts[1];
    repaired.receipts[1].receiptHash = sha256Hex(canonicalJson(rest));
    assert.deepEqual(validateChain(repaired.receipts),
      { valid: false, brokenAt: 2, reason: 'chain_link_broken' });
  });

  it('a genesis marker replacement is detected', () => {
    const forged = JSON.parse(JSON.stringify(valid));
    forged.receipts[0].previousReceiptHash = 'genesis:something-else';
    assert.deepEqual(validateChain(forged.receipts),
      { valid: false, brokenAt: 0, reason: 'content_tampered' });
  });
});


describe('V5-C5A: the canonicalization rules survive non-ASCII and awkward numbers', () => {
  // The ASCII fixture passes under three different WRONG canonicalizations, so
  // it cannot defend the portability claim. This one was built to break them.
  it('the unicode fixture verifies end to end', () => {
    assert.equal(checkBundleSeal(unicodeValid), true);
    assert.deepEqual(validateChain(unicodeValid.receipts),
      { valid: true, brokenAt: null, reason: null });
    assert.equal(unicodeValid.receiptCount, unicodeValid.receipts.length);
  });

  it('it actually contains the content the portability rules are about', () => {
    const text = JSON.stringify(unicodeValid);
    assert.match(text, /kullan\u0131c\u0131 onay\u0131 ge\u00e7ti|kullanıcı onayı geçti/);
    const keys = unicodeValid.receipts.flatMap((r) => Object.keys(r.metadata || {}));
    assert.ok(keys.includes('\uE000'), 'needs a BMP private-use key');
    assert.ok(keys.includes('\u{1F600}'), 'needs a supplementary-plane key');
  });

  it('non-ASCII must stay literal: escaping it changes the hash', () => {
    const escaped = JSON.stringify(sealPayload(unicodeValid))
      .replace(/[\u0080-\uFFFF]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    assert.notEqual(sha256Hex(escaped), unicodeValid.bundleHash);
  });

  it('UTF-16 key order differs from code-point order, and the spec picks UTF-16', () => {
    const keys = ['\uE000', '\u{1F600}'];
    const utf16 = [...keys].sort();
    const codePoint = [...keys].sort((a, b) => a.codePointAt(0) - b.codePointAt(0));
    assert.notDeepEqual(utf16, codePoint, 'the two orderings must actually differ');
    assert.deepEqual(utf16, ['\u{1F600}', '\uE000']);
  });

  it('numbers use ECMAScript form, not zero-padded exponents or early exponent switch', () => {
    assert.equal(JSON.stringify(1e-7), '1e-7');
    assert.equal(JSON.stringify(0.00001), '0.00001');
    assert.equal(JSON.stringify(-0), '0');
    assert.equal(JSON.stringify(1.0), '1');
  });
});

describe('V5-C5A: a clean-room implementation agrees on the bytes', () => {
  const probe = path.join(SPEC_DIR, 'conformance', 'verify_bundle.py');

  function runPython(args) {
    return spawnSync('python3', [probe, ...args], { encoding: 'utf8' });
  }

  const havePython = spawnSync('python3', ['--version'], { encoding: 'utf8' }).status === 0;

  it('the Python verifier reaches the same verdict on every fixture', { skip: !havePython && 'python3 unavailable' }, () => {
    const files = [
      'receipt-bundle.valid.json',
      'receipt-bundle.unicode.valid.json',
      'receipt-bundle.tampered-bundle-hash.json',
      'receipt-bundle.broken-chain.json',
    ].map((name) => path.join(EXAMPLES, name));

    const result = runPython(files);
    assert.equal(result.error, undefined);
    const out = result.stdout;
    assert.match(out, /receipt-bundle\.valid\.json\s+VALID/);
    assert.match(out, /receipt-bundle\.unicode\.valid\.json\s+VALID/);
    assert.match(out, /receipt-bundle\.tampered-bundle-hash\.json\s+INVALID\s+bundle_seal_mismatch/);
    assert.match(out, /receipt-bundle\.broken-chain\.json\s+INVALID.*content_tampered@1/);
    assert.equal(result.status, 1, 'exit 1 because two fixtures are invalid by design');
  });

  it('the clean-room verifier rejects a mutated receiptCount, like the producer', { skip: !havePython && 'python3 unavailable' }, () => {
    // The conformance property this file exists to protect: producer and
    // clean-room verifier must reach the same verdict. Both now reject, since
    // receiptCount is sealed and separately checked (#735, #767).
    const mutated = { ...valid, receiptCount: valid.receipts.length + 7 };
    const tmp = path.join(os.tmpdir(), `c5a-count-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(mutated, null, 2));
    try {
      const result = runPython([tmp]);
      assert.match(result.stdout, /INVALID/);
      assert.match(result.stdout, /receipt_count_mismatch/);
      assert.equal(result.status, 1);
      assert.equal(verifyExportedBundle(mutated).valid, false,
        'the producer must agree, otherwise the spec is wrong rather than the probe');
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('the clean-room verifier imports nothing but the Python standard library', () => {
    // Checked against import statements, not prose: the docstring legitimately
    // mentions HUQAN while importing none of it.
    const source = fs.readFileSync(probe, 'utf8');
    const imports = source.split('\n')
      .map((line) => line.trim())
      .filter((line) => /^(import|from)\s/.test(line));
    assert.ok(imports.length > 0, 'the probe should import something');
    const allowed = new Set(['hashlib', 'json', 'sys', 'base64']);
    for (const line of imports) {
      const moduleName = line.replace(/^(import|from)\s+/, '').split(/[\s.]/)[0];
      assert.ok(allowed.has(moduleName), `unexpected import: ${line}`);
    }
    assert.doesNotMatch(source, /\brequire\(|\.\.\/\.\.\/lib\//,
      'no producer code may be pulled in');
  });
});

describe('V5-C5A: what a VALID verdict does not prove', () => {
  // The assurance erratum, demonstrated rather than described. Nothing is
  // written to the fixture corpus: the forgery is built in memory so the
  // shipped bytes stay exactly as published.
  function forgeAndReseal(source) {
    const forged = JSON.parse(JSON.stringify(source));
    forged.receipts[1].decision = 'block';           // change the meaning
    let previous = forged.receipts[0].receiptHash;   // then redo all the work
    for (let i = 1; i < forged.receipts.length; i += 1) {
      forged.receipts[i].previousReceiptHash = previous;
      const { receiptHash: _drop, ...rest } = forged.receipts[i];
      forged.receipts[i].receiptHash = sha256Hex(canonicalJson(rest));
      previous = forged.receipts[i].receiptHash;
    }
    forged.bundleHash = sha256Hex(canonicalJson(sealPayload(forged)));
    return forged;
  }

  const forged = forgeAndReseal(valid);

  it('the forgery really did change the content', () => {
    assert.notEqual(forged.receipts[1].decision, valid.receipts[1].decision);
    assert.notEqual(forged.bundleHash, valid.bundleHash);
  });

  it('all four checks accept it, so VALID does not mean the content is original', () => {
    assert.equal(checkBundleSeal(forged), true, 'bundle seal');
    assert.equal(forged.schemaVersion, expectedEnvelopeVersion(forged.receipts), 'envelope version');
    assert.equal(forged.receiptCount, forged.receipts.length, 'receipt count');
    assert.deepEqual(validateChain(forged.receipts), { valid: true, brokenAt: null, reason: null });
  });

  it('the clean-room implementation agrees, so the limit is the format not the code', { skip: !havePythonProbe && 'python3 unavailable' }, () => {
    const tmp = path.join(os.tmpdir(), `c5a-forged-${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify(forged, null, 2));
    try {
      const result = spawnSync('python3',
        [path.join(SPEC_DIR, 'conformance', 'verify_bundle.py'), tmp], { encoding: 'utf8' });
      assert.match(result.stdout, /VALID/);
      assert.doesNotMatch(result.stdout, /INVALID/);
      assert.equal(result.status, 0);
    } finally {
      fs.rmSync(tmp, { force: true });
    }
  });

  it('what does catch it is a bundleHash obtained from outside the document', () => {
    // The one row of the assurance table that survives a capable editor.
    assert.notEqual(forged.bundleHash, valid.bundleHash,
      'comparing against a separately obtained bundleHash detects the forgery');
  });

  it('the published documents no longer claim more than that', () => {
    const spec = fs.readFileSync(path.join(SPEC_DIR, 'RECEIPT-BUNDLE.md'), 'utf8');
    const readme = fs.readFileSync(path.join(SPEC_DIR, 'conformance', 'README.md'), 'utf8');
    const probe = fs.readFileSync(path.join(SPEC_DIR, 'conformance', 'verify_bundle.py'), 'utf8');
    for (const [name, text] of Object.entries({ spec, readme })) {
      assert.doesNotMatch(text, /tamper-evident/i, `${name} must not claim tamper-evidence`);
      assert.doesNotMatch(text, /unmodified since export/i, `${name} must not claim unmodified since export`);
    }
    assert.match(probe, /does NOT prove/, 'the probe states the limit at the point of use');
    assert.match(readme, /does not establish issuer identity/i);
  });
});

describe('V5-C5A: the specification is distributed', () => {
  it('package files ship every ATP 0.1 spec file an external verifier needs', () => {
    const pkg = readJson(__dirname, '..', 'package.json');
    for (const entry of [
      'specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md',
      'specs/axiom-trust-protocol/0.1/schemas/trust-receipt-bundle.schema.json',
      'specs/axiom-trust-protocol/0.1/examples/receipt-bundle.valid.json',
      'specs/axiom-trust-protocol/0.1/examples/receipt-bundle.unicode.valid.json',
      'specs/axiom-trust-protocol/0.1/conformance/verify_bundle.py',
      'specs/axiom-trust-protocol/0.1/examples/receipt-bundle.tampered-bundle-hash.json',
      'specs/axiom-trust-protocol/0.1/examples/receipt-bundle.broken-chain.json',
      'specs/axiom-trust-protocol/0.1/conformance/README.md',
    ]) {
      assert.ok(pkg.files.includes(entry), `package files must include ${entry}`);
    }
  });

  it('the allowlist stays literal, since the facade contract checks each entry on disk', () => {
    const pkg = readJson(__dirname, '..', 'package.json');
    assert.deepEqual(pkg.files.filter((entry) => entry.includes('*')), []);
  });

  it('shipping the spec does not smuggle in the deliberately unshipped top-level schemas/', () => {
    // The bundle schema lives under specs/, so specs/** carries it. The
    // top-level schemas/ tree is V5 agent-identity and verdict material that
    // test/kernel-facade-contract.test.js forbids from the package, alongside
    // lib/v5/. Distributing the bundle spec must not quietly reverse that.
    const pkg = readJson(__dirname, '..', 'package.json');
    assert.equal(pkg.files.some((entry) => entry.startsWith('schemas/')), false);
    assert.ok(fs.existsSync(path.join(SPEC_DIR, 'schemas', 'trust-receipt-bundle.schema.json')));
  });

  it('the spec documents the algorithm without sending readers to lib/', () => {
    const spec = fs.readFileSync(path.join(SPEC_DIR, 'RECEIPT-BUNDLE.md'), 'utf8');
    for (const needed of ['canonicalJson', 'sha256Hex', GENESIS, 'bundleHash', 'previousReceiptHash']) {
      assert.ok(spec.includes(needed), `RECEIPT-BUNDLE.md must define ${needed}`);
    }
    assert.doesNotMatch(spec, /read\s+`?lib\//i,
      'the spec must not instruct readers to consult the implementation');
  });
});

/** Paths of JSON leaves whose values differ between two documents. */
function differingLeaves(a, b) {
  const flatten = (value, prefix = '', acc = {}) => {
    if (value && typeof value === 'object') {
      for (const key of Object.keys(value)) {
        flatten(value[key], prefix ? `${prefix}.${key}` : key, acc);
      }
    } else {
      acc[prefix] = value;
    }
    return acc;
  };
  const left = flatten(a);
  const right = flatten(b);
  return [...new Set([...Object.keys(left), ...Object.keys(right)])]
    .filter((key) => left[key] !== right[key]);
}
