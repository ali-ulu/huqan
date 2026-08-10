#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const PKG_ROOT = path.dirname(require.resolve('huqan/package.json'));
const SPEC_ROOT = path.join(PKG_ROOT, 'specs', 'axiom-trust-protocol', '0.1');
const EXAMPLES = path.join(SPEC_ROOT, 'examples');
const GENESIS = 'genesis:v4-receipt-chain';

const EVIDENCE_LEVELS = Object.freeze({
  surface: 'packaged-surface-smoke',
  objects: 'self-test',
  'fail-closed': 'self-test',
  bundles: 'self-test',
  'cross-implementation': 'cross-implementation-conformance',
  gaps: 'blocked-gap',
});

const cases = [];

function record(group, name, status, detail = '') {
  cases.push({
    group,
    name,
    status,
    ok: status === 'pass',
    evidenceLevel: EVIDENCE_LEVELS[group],
    detail,
  });
}

function skipped(detail) {
  return { skipped: true, detail };
}

function check(group, name, fn) {
  try {
    const result = fn();
    if (result && result.skipped === true) {
      record(group, name, 'skip', result.detail || '');
    } else {
      record(group, name, 'pass', result || '');
    }
  } catch (error) {
    record(group, name, 'fail', error && error.message ? error.message : String(error));
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

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

const BUNDLE_FIELDS = new Set([
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
check('surface', 'producer ATP validator loads from the installed package', () => {
  atp = require('huqan/lib/atp-conformance');
  assert(typeof atp.validateATPObject === 'function', 'validateATPObject missing');
  assert(typeof atp.runATPConformance === 'function', 'runATPConformance missing');
  return Object.keys(atp.ATP_OBJECT_TYPES).length + ' object types';
});

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

check('objects', 'producer runATPConformance accepts the whole example set', () => {
  const report = atp.runATPConformance(objectFiles.map((file) => ({
    filePath: path.join(EXAMPLES, file),
    type: PREFIX_TO_TYPE[file.split('.')[0]],
  })));
  assert(report.ok, `errors: ${JSON.stringify(report.errors)}`);
  return `${report.results.length} fixtures`;
});

check('fail-closed', 'unknown object type is rejected', () => {
  const result = atp.validateATPObject('not-a-real-type', { anything: true });
  assert(!result.ok, 'unknown type was accepted');
  assert(result.errors.some((e) => e.code === 'INVALID_ATP_OBJECT'),
    `expected INVALID_ATP_OBJECT, got ${JSON.stringify(result.errors)}`);
});

for (const scalar of [null, undefined, 42, 'text', [], true]) {
  check('fail-closed',
    `trust-receipt rejects non-object input (${JSON.stringify(scalar) ?? 'undefined'})`, () => {
      assert(!atp.validateATPObject('trust-receipt', scalar).ok, 'non-object input was accepted');
    });
}

check('fail-closed', 'trust-receipt with its id removed is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'trust-receipt.github_pr.json'));
  assert(atp.validateATPObject('trust-receipt', valid).ok, 'baseline fixture is not valid');
  const broken = { ...valid };
  delete broken.receiptId;
  assert(!atp.validateATPObject('trust-receipt', broken).ok, 'missing receiptId was accepted');
});

check('fail-closed', 'trust-receipt with an unsupported status is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'trust-receipt.github_pr.json'));
  assert(!atp.validateATPObject('trust-receipt', {
    ...valid,
    status: 'definitely-not-a-status',
  }).ok, 'unsupported status was accepted');
});

check('fail-closed', 'error envelope with ok:true is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'error.provenance_required.json'));
  assert(atp.validateATPObject('error', valid).ok, 'baseline fixture is not valid');
  assert(!atp.validateATPObject('error', { ...valid, ok: true }).ok, 'ok:true error was accepted');
});

check('fail-closed', 'error envelope with an unsupported code is rejected', () => {
  const valid = readJson(path.join(EXAMPLES, 'error.provenance_required.json'));
  assert(!atp.validateATPObject('error', {
    ...valid,
    error: { ...valid.error, code: 'NOT_A_REAL_CODE' },
  }).ok, 'unsupported error code was accepted');
});

check('fail-closed', 'a fixture path that does not exist is reported, not thrown', () => {
  const result = atp.validateATPFixture('trust-receipt', path.join(EXAMPLES, 'no-such-file.json'));
  assert(!result.ok && Array.isArray(result.errors) && result.errors.length > 0,
    'missing fixture was not reported as invalid');
});

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

function emptyValidBundle() {
  return {
    schemaVersion: 'v4-receipt-bundle-v1',
    workspaceId: 'default',
    exportedAt: '2026-01-01T00:00:00.000Z',
    receiptCount: 0,
    bundleHash: sha256Hex(canonicalJson([])),
    receipts: [],
  };
}

check('bundles', 'bundle missing receipts fails closed before hash checks', () => {
  const bundle = emptyValidBundle();
  delete bundle.receipts;
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:missing:receipts']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

check('bundles', 'bundle with non-array receipts fails closed', () => {
  const bundle = { ...emptyValidBundle(), receipts: {} };
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:receipts']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

check('bundles', 'bundle missing another required envelope field fails closed', () => {
  const bundle = emptyValidBundle();
  delete bundle.workspaceId;
  assert(JSON.stringify(verifyBundle(bundle))
    === JSON.stringify(['invalid_bundle_envelope:missing:workspaceId']),
  `unexpected findings: ${JSON.stringify(verifyBundle(bundle))}`);
});

function parsePythonFindings(stdout) {
  const line = stdout.trim().split('\n').pop() || '';
  if (/\bVALID\b/.test(line) && !/\bINVALID\b/.test(line)) return [];
  const tail = line.split(/\bINVALID\b/)[1];
  if (tail === undefined) throw new Error(`unparseable verifier output: ${line}`);
  return tail.split(',').map((s) => s.trim()).filter(Boolean).sort();
}

function findPython() {
  const candidates = process.platform === 'win32'
    ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
    : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];

  for (const candidate of candidates) {
    const probe = spawnSync(candidate.command, [
      ...candidate.args,
      '-c',
      'import sys; raise SystemExit(0 if sys.version_info[0] == 3 else 1)',
    ], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return candidate;
  }
  return null;
}

check('cross-implementation', 'the shipped Python verifier reports the same findings', () => {
  const python = findPython();
  if (!python) return skipped('no supported Python interpreter available');

  const script = path.join(SPEC_ROOT, 'conformance', 'verify_bundle.py');
  const disagreements = [];
  for (const file of bundleFiles) {
    if (BUNDLE_EXPECTATIONS[file] === undefined) continue;
    const run = spawnSync(
      python.command,
      [...python.args, script, path.join(EXAMPLES, file)],
      { encoding: 'utf8' },
    );
    const pythonFindings = parsePythonFindings(run.stdout || '');
    const consumerFindings = [...verifyBundle(readJson(path.join(EXAMPLES, file)))].sort();
    if (JSON.stringify(pythonFindings) !== JSON.stringify(consumerFindings)) {
      disagreements.push(
        `${file}: python=${JSON.stringify(pythonFindings)} consumer=${JSON.stringify(consumerFindings)}`,
      );
    }
    if ((run.status === 0) !== (pythonFindings.length === 0)) {
      disagreements.push(`${file}: python exit status disagrees with its own findings`);
    }
  }
  assert(disagreements.length === 0, disagreements.join('; '));
  return `${bundleFiles.length} fixtures, findings identical in JavaScript and Python`;
});

const GAPS = [
  {
    criterion: 'package validation',
    absent: 'schemas/v5/shared-trust-package.schema.json',
    reason: 'schemas/ is excluded from the package by the facade contract.',
  },
  {
    criterion: 'HTP (V5-C3/C4) compatibility',
    absent: 'schemas/v5/public-trust-receipt.schema.json',
    reason: 'ATP v0.1 is shipped; the V5 object schemas are not on a published surface.',
  },
  {
    criterion: 'missing scope / evidence / expiry negatives',
    absent: 'schemas/v5/a2a-trust-evidence.schema.json',
    reason: 'the V5-C3 evidence schema that defines those fields is not published.',
  },
];

for (const gap of GAPS) {
  check('gaps', `BLOCKED_GAP still holds: ${gap.criterion}`, () => {
    assert(!fs.existsSync(path.join(PKG_ROOT, gap.absent)),
      `${gap.absent} is now shipped; replace this gap with real conformance cases`);
    return gap.reason;
  });
}

check('gaps', 'no schemas/ directory reached the installed package', () => {
  assert(!fs.existsSync(path.join(PKG_ROOT, 'schemas')),
    'schemas/ is present in the installed package, which the facade contract forbids');
});

const failed = cases.filter((c) => c.status === 'fail');
const skippedCases = cases.filter((c) => c.status === 'skip');
const crossImplementationCase = cases.find((c) => c.group === 'cross-implementation');
const report = {
  evidenceLevels: EVIDENCE_LEVELS,
  evidenceLevelNote:
    'Evidence is group-scoped: package reachability is a packaged-surface smoke; '
    + 'ATP object and JavaScript bundle checks are self-test; the Python comparison is '
    + 'cross-implementation conformance only when its case passes. '
    + 'This run does not establish third-party verification or interoperability.',
  crossImplementationExecuted: crossImplementationCase?.status === 'pass',
  packageRoot: PKG_ROOT,
  packageVersion: readJson(path.join(PKG_ROOT, 'package.json')).version,
  total: cases.length,
  passed: cases.length - failed.length - skippedCases.length,
  skipped: skippedCases.length,
  failed: failed.length,
  blockedGaps: GAPS.map((g) => ({ criterion: g.criterion, absent: g.absent, reason: g.reason })),
  cases,
};

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(failed.length === 0 ? 0 : 1);
