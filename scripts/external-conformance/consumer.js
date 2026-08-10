#!/usr/bin/env node
'use strict';

/**
 * External conformance consumer for HUQAN trust objects.
 *
 * This file is executed inside a throwaway npm project that has exactly one
 * dependency: a tarball built by `npm pack` from this repository. It has no
 * access to the repository working tree, to `test/`, to `schemas/`, or to any
 * dev dependency. Every path it touches is under `node_modules/huqan/`.
 *
 * That restriction is the whole point. It answers one question: is the
 * published package, on its own, enough to validate a HUQAN trust object? If
 * validation needs anything the tarball does not carry, this script fails, and
 * that failure is the finding.
 *
 * Evidence level: this is *packaged-surface conformance* -- level 2 of the four
 * levels named in specs/axiom-trust-protocol/0.1/conformance/README.md. It is
 * not third-party verification and not interoperability. The consumer is
 * written by the same authors as the producer; what it establishes is that the
 * shipped artifact is self-sufficient, not that an unrelated party succeeded
 * with it.
 *
 * Output is a JSON report on stdout. Exit status is 0 when every case passes,
 * 1 otherwise. Recorded gaps do not fail the run -- they are observations, and
 * the run asserts they are still true.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PKG_ROOT = path.dirname(require.resolve('huqan/package.json'));
const SPEC_ROOT = path.join(PKG_ROOT, 'specs', 'axiom-trust-protocol', '0.1');
const EXAMPLES = path.join(SPEC_ROOT, 'examples');
const GENESIS = 'genesis:v4-receipt-chain';

const cases = [];

function record(group, name, ok, detail) {
  cases.push({ group, name, ok, detail });
}

function check(group, name, fn) {
  let ok = false;
  let detail = '';
  try {
    detail = fn() || '';
    ok = true;
  } catch (error) {
    detail = error && error.message ? error.message : String(error);
  }
  record(group, name, ok, detail);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ---------------------------------------------------------------------------
// Canonical JSON and the three bundle checks, re-derived from the shipped
// RECEIPT-BUNDLE.md rather than imported from the package. A consumer that
// reuses the producer's serializer cannot detect a specification that only
// works because both sides share one implementation.
//
// In JavaScript the spec's canonical form falls out of the language: sorting
// keys with the default comparator is UTF-16 code-unit order, and
// JSON.stringify already emits literal non-ASCII and Number::toString.
// ---------------------------------------------------------------------------

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
  return require('node:crypto').createHash('sha256').update(text, 'utf8').digest('hex');
}

function expectedEnvelopeVersion(receipts) {
  const v2 = receipts.some((r) => r && r.schemaVersion === 'v4-receipt-v2');
  return v2 ? 'v4-receipt-bundle-v2' : 'v4-receipt-bundle-v1';
}

/** Returns the findings array; empty means the bundle verifies. */
function verifyBundle(bundle) {
  const findings = [];
  const receipts = Array.isArray(bundle.receipts) ? bundle.receipts : [];

  if (sha256Hex(canonicalJson(receipts)) !== bundle.bundleHash) {
    findings.push('bundle_seal_mismatch');
  }
  if (bundle.schemaVersion !== expectedEnvelopeVersion(receipts)) {
    findings.push('envelope_version_mismatch');
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

// ---------------------------------------------------------------------------
// Group 1 -- is the packaged surface reachable at all?
// ---------------------------------------------------------------------------

const REQUIRED_SURFACE = [
  'package.json',
  'lib/atp-conformance.js',
  'specs/axiom-trust-protocol/0.1/README.md',
  'specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md',
  'specs/axiom-trust-protocol/0.1/conformance/README.md',
  'specs/axiom-trust-protocol/0.1/conformance/verify_bundle.py',
];

for (const rel of REQUIRED_SURFACE) {
  check('surface', `installed package carries ${rel}`, () => {
    assert(fs.existsSync(path.join(PKG_ROOT, rel)), `absent from installed package: ${rel}`);
  });
}

check('surface', 'every ATP schema parses as JSON', () => {
  const dir = path.join(SPEC_ROOT, 'schemas');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert(files.length > 0, 'no schemas shipped');
  for (const file of files) readJson(path.join(dir, file));
  return `${files.length} schemas`;
});

let atp = null;
check('surface', 'lib/atp-conformance.js loads from the installed package', () => {
  atp = require('huqan/lib/atp-conformance');
  assert(typeof atp.validateATPObject === 'function', 'validateATPObject missing');
  assert(typeof atp.runATPConformance === 'function', 'runATPConformance missing');
  return Object.keys(atp.ATP_OBJECT_TYPES).length + ' object types';
});

// ---------------------------------------------------------------------------
// Group 2 -- every shipped example validates as its declared type.
//
// The type comes from the example's filename prefix, which the spec's examples
// directory uses consistently. Deriving it rather than hardcoding a table means
// a newly shipped example is covered without editing this file, and an example
// whose name does not map is reported instead of skipped.
// ---------------------------------------------------------------------------

const PREFIX_TO_TYPE = {
  audit: 'audit-event',
  candidate: 'candidate-claim',
  'causal-chain': 'causal-chain',
  conflict: 'conflict-result',
  error: 'error',
  provenance: 'provenance-record',
  simulation: 'simulation-result',
  'trust-receipt': 'trust-receipt',
  verification: 'verification-result',
};

const exampleFiles = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.json')).sort();
const bundleFiles = exampleFiles.filter((f) => f.startsWith('receipt-bundle.'));
const objectFiles = exampleFiles.filter((f) => !f.startsWith('receipt-bundle.'));

check('objects', 'every non-bundle example maps to a known ATP type', () => {
  const unmapped = objectFiles.filter((f) => !PREFIX_TO_TYPE[f.split('.')[0]]);
  assert(unmapped.length === 0, `unmapped examples: ${unmapped.join(', ')}`);
  return `${objectFiles.length} examples`;
});

for (const file of objectFiles) {
  const type = PREFIX_TO_TYPE[file.split('.')[0]];
  if (!type) continue;
  check('objects', `${file} validates as ${type}`, () => {
    const result = atp.validateATPFixture(type, path.join(EXAMPLES, file));
    assert(result.ok, `errors: ${JSON.stringify(result.errors)}`);
    return `${result.warnings.length} warnings`;
  });
}

check('objects', 'runATPConformance accepts the whole example set at once', () => {
  const fixtures = objectFiles.map((file) => ({
    filePath: path.join(EXAMPLES, file),
    type: PREFIX_TO_TYPE[file.split('.')[0]],
  }));
  const report = atp.runATPConformance(fixtures);
  assert(report.ok, `errors: ${JSON.stringify(report.errors)}`);
  return `${report.results.length} fixtures`;
});

// ---------------------------------------------------------------------------
// Group 3 -- fail-closed. Each case starts from a valid example and breaks one
// thing, so a rejection cannot be explained by the fixture being broken to
// begin with.
// ---------------------------------------------------------------------------

check('fail-closed', 'unknown object type is rejected', () => {
  const result = atp.validateATPObject('not-a-real-type', { anything: true });
  assert(!result.ok, 'unknown type was accepted');
  assert(result.errors.some((e) => e.code === 'INVALID_ATP_OBJECT'),
    `expected INVALID_ATP_OBJECT, got ${JSON.stringify(result.errors)}`);
});

for (const scalar of [null, undefined, 42, 'text', [], true]) {
  check('fail-closed', `trust-receipt rejects non-object input (${JSON.stringify(scalar) ?? 'undefined'})`, () => {
    const result = atp.validateATPObject('trust-receipt', scalar);
    assert(!result.ok, 'non-object input was accepted');
  });
}

check('fail-closed', 'trust-receipt with its id removed is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'trust-receipt.github_pr.json'));
  assert(atp.validateATPObject('trust-receipt', valid).ok, 'baseline fixture is not valid');
  const broken = { ...valid };
  delete broken.receiptId;
  const result = atp.validateATPObject('trust-receipt', broken);
  assert(!result.ok, 'missing receiptId was accepted');
  return JSON.stringify(result.errors[0]);
});

check('fail-closed', 'trust-receipt with an unsupported status is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'trust-receipt.github_pr.json'));
  const result = atp.validateATPObject('trust-receipt', { ...valid, status: 'definitely-not-a-status' });
  assert(!result.ok, 'unsupported status was accepted');
  return JSON.stringify(result.errors[0]);
});

check('fail-closed', 'error envelope with ok:true is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'error.provenance_required.json'));
  assert(atp.validateATPObject('error', valid).ok, 'baseline fixture is not valid');
  const result = atp.validateATPObject('error', { ...valid, ok: true });
  assert(!result.ok, 'ok:true error envelope was accepted');
});

check('fail-closed', 'error envelope with an unsupported code is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'error.provenance_required.json'));
  const result = atp.validateATPObject('error', {
    ...valid,
    error: { ...valid.error, code: 'NOT_A_REAL_CODE' },
  });
  assert(!result.ok, 'unsupported error code was accepted');
});

check('fail-closed', 'a fixture path that does not exist is reported, not thrown', () => {
  const result = atp.validateATPFixture('trust-receipt', path.join(EXAMPLES, 'no-such-file.json'));
  assert(!result.ok, 'missing file was accepted');
  assert(Array.isArray(result.errors) && result.errors.length > 0, 'no error recorded');
});

// ---------------------------------------------------------------------------
// Group 4 -- bundle verification, against the shipped fixtures.
// ---------------------------------------------------------------------------

// Taken from the table in RECEIPT-BUNDLE.md, not from the fixture filenames.
// `receipt-bundle.broken-chain.json` mutates receipts[1].decision, which is
// inside the hashed content, so check 3a reports content_tampered before the
// linkage check is ever reached -- and the bundle seal fails as a consequence.
// The filename suggests chain_link_broken; the specification says otherwise,
// and the specification is what a consumer implements against.
const BUNDLE_EXPECTATIONS = {
  'receipt-bundle.valid.json': [],
  'receipt-bundle.unicode.valid.json': [],
  'receipt-bundle.broken-chain.json': ['bundle_seal_mismatch', 'content_tampered@1'],
  'receipt-bundle.tampered-bundle-hash.json': ['bundle_seal_mismatch'],
};

check('bundles', 'every shipped bundle fixture has a declared expectation', () => {
  const undeclared = bundleFiles.filter((f) => BUNDLE_EXPECTATIONS[f] === undefined);
  assert(undeclared.length === 0, `undeclared bundle fixtures: ${undeclared.join(', ')}`);
  return `${bundleFiles.length} fixtures`;
});

for (const file of bundleFiles) {
  const expected = BUNDLE_EXPECTATIONS[file];
  if (expected === undefined) continue;
  check('bundles', `${file} verifies to ${expected.length ? expected.join(', ') : 'VALID'}`, () => {
    const findings = verifyBundle(readJson(path.join(EXAMPLES, file)));
    assert(JSON.stringify(findings) === JSON.stringify(expected),
      `expected ${JSON.stringify(expected)}, observed ${JSON.stringify(findings)}`);
  });
}

/**
 * Parse one output line of the shipped verify_bundle.py into findings.
 *
 *   "name.json     VALID"                          -> []
 *   "name.json     INVALID  a, b"                  -> ['a', 'b']
 *
 * Comparing only VALID/INVALID would let the two implementations disagree on
 * *why* a bundle fails while still appearing to agree, which is the half of the
 * claim that actually matters for a conformance runner.
 */
function parsePythonFindings(stdout) {
  const line = stdout.trim().split('\n').pop() || '';
  if (/\bVALID\b/.test(line) && !/\bINVALID\b/.test(line)) return [];
  const tail = line.split(/\bINVALID\b/)[1];
  if (tail === undefined) throw new Error(`unparseable verifier output: ${line}`);
  return tail.split(',').map((s) => s.trim()).filter(Boolean).sort();
}

check('bundles', 'the shipped Python verifier reports the same findings', () => {
  const probe = spawnSync('python3', ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return 'skipped: python3 unavailable';

  const script = path.join(SPEC_ROOT, 'conformance', 'verify_bundle.py');
  const disagreements = [];
  for (const file of bundleFiles) {
    const expected = BUNDLE_EXPECTATIONS[file];
    if (expected === undefined) continue;
    const run = spawnSync('python3', [script, path.join(EXAMPLES, file)], { encoding: 'utf8' });
    const pythonFindings = parsePythonFindings(run.stdout || '');
    const consumerFindings = [...verifyBundle(readJson(path.join(EXAMPLES, file)))].sort();

    if (JSON.stringify(pythonFindings) !== JSON.stringify(consumerFindings)) {
      disagreements.push(`${file}: python=${JSON.stringify(pythonFindings)} consumer=${JSON.stringify(consumerFindings)}`);
    }
    const pythonSaysValid = run.status === 0;
    if (pythonSaysValid !== (pythonFindings.length === 0)) {
      disagreements.push(`${file}: python exit status disagrees with its own findings`);
    }
  }
  assert(disagreements.length === 0, disagreements.join('; '));
  return `${bundleFiles.length} fixtures, findings identical in both implementations`;
});

// ---------------------------------------------------------------------------
// Group 5 -- recorded gaps.
//
// These acceptance criteria of V5-C5 cannot be met from the package as it is
// published. Rather than describe that in prose, each gap is asserted: if a
// future change ships the schema, the assertion fails and the gap has to be
// closed here rather than quietly outliving its cause.
// ---------------------------------------------------------------------------

const GAPS = [
  {
    criterion: 'package validation',
    absent: 'schemas/v5/shared-trust-package.schema.json',
    reason: 'schemas/ is excluded from the package by the facade contract '
      + '(test/kernel-facade-contract.test.js forbids it in both the allowlist '
      + 'check and the npm pack output check), so no consumer can reach it.',
  },
  {
    criterion: 'HTP (V5-C3/C4) compatibility',
    absent: 'schemas/v5/public-trust-receipt.schema.json',
    reason: 'same exclusion. ATP v0.1 compatibility is covered above; the V5 '
      + 'object schemas are not published anywhere a consumer can read.',
  },
  {
    criterion: 'missing scope / evidence / expiry negatives',
    absent: 'schemas/v5/a2a-trust-evidence.schema.json',
    reason: 'those fields are defined by the V5-C3 evidence schema, which is '
      + 'not in the package. The negatives cannot be written against a schema '
      + 'the consumer cannot see.',
  },
];

for (const gap of GAPS) {
  check('gaps', `BLOCKED_GAP still holds: ${gap.criterion}`, () => {
    const full = path.join(PKG_ROOT, gap.absent);
    assert(!fs.existsSync(full),
      `${gap.absent} is now in the package -- this gap is closable and must be `
      + 'replaced with real conformance cases');
    return gap.reason;
  });
}

check('gaps', 'no schemas/ directory reached the installed package', () => {
  assert(!fs.existsSync(path.join(PKG_ROOT, 'schemas')),
    'schemas/ is present in the installed package, which the facade contract forbids');
});

// ---------------------------------------------------------------------------

const failed = cases.filter((c) => !c.ok);
const report = {
  evidenceLevel: 'packaged-surface-conformance',
  evidenceLevelNote:
    'Level 2 of four (self-test, cross-implementation conformance, third-party '
    + 'verification, interoperability). This run does not establish third-party '
    + 'verification or interoperability.',
  packageRoot: PKG_ROOT,
  packageVersion: readJson(path.join(PKG_ROOT, 'package.json')).version,
  total: cases.length,
  passed: cases.length - failed.length,
  failed: failed.length,
  blockedGaps: GAPS.map((g) => ({ criterion: g.criterion, absent: g.absent, reason: g.reason })),
  cases,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
