#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');

const PKG_ROOT = path.dirname(require.resolve('huqan/package.json'));
const LEGACY_SPEC_ROOT = path.join(PKG_ROOT, 'specs', 'axiom-trust-protocol', '0.1');
const CANONICAL_SPEC_ROOT = path.join(PKG_ROOT, 'specs', 'huqan-trust-protocol', '0.2');
const LEGACY_PACKAGE_ROOT = path.join(PKG_ROOT, 'specs', 'axiom-package-format', '0.1');
const CANONICAL_PACKAGE_ROOT = path.join(PKG_ROOT, 'specs', 'huqan-package-format', '0.2');
const SPEC_ROOT = LEGACY_SPEC_ROOT;
const EXAMPLES = path.join(SPEC_ROOT, 'examples');
const GENESIS = 'genesis:v4-receipt-chain';

const EVIDENCE_LEVELS = Object.freeze({
  surface: 'packaged-surface-smoke',
  objects: 'self-test',
  'fail-closed': 'self-test',
  bundles: 'self-test',
  'package-wire': 'installed-package-self-test',
  replay: 'self-test',
  v5: 'self-test',
  'cross-implementation': 'cross-implementation-conformance',
});

const cases = [];
const pendingCases = [];

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

function checkAsync(group, name, fn) {
  pendingCases.push(Promise.resolve().then(fn).then(
    (result) => record(group, name, 'pass', result || ''),
    (error) => record(group, name, 'fail', error && error.message ? error.message : String(error)),
  ));
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
  'lib/axiom-package-format.js',
  'lib/huqan-package-format.js',
  'specs/axiom-package-format/0.1/examples/package.trust-receipt-bundle.axiom.json',
  'specs/huqan-package-format/0.2/examples/package.empty.huqan.json',
  'specs/huqan-package-format/0.2/schemas/huqan-manifest.schema.json',
  'specs/huqan-package-format/0.2/schemas/huqan-package.schema.json',
  'specs/axiom-trust-protocol/0.1/README.md',
  'specs/axiom-trust-protocol/0.1/RECEIPT-BUNDLE.md',
  'specs/axiom-trust-protocol/0.1/conformance/README.md',
  'specs/axiom-trust-protocol/0.1/conformance/verify_bundle.py',
  'specs/huqan-trust-protocol/0.2/README.md',
  'specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md',
  'specs/huqan-trust-protocol/0.2/conformance/README.md',
  'specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py',
];

for (const rel of REQUIRED_SURFACE) {
  check('surface', `installed package carries ${rel}`, () => {
    assert(fs.existsSync(path.join(PKG_ROOT, rel)), `absent from installed package: ${rel}`);
  });
}

let packageFormat = null;
check('package-wire', 'dual-format package reader and canonical writer load', () => {
  packageFormat = require('huqan/lib/huqan-package-format');
  assert(typeof packageFormat.validateHuqanPackage === 'function', 'neutral reader missing');
  assert(typeof packageFormat.createHuqanPackage === 'function', 'canonical writer missing');
});

const legacyPackagePath = path.join(
  LEGACY_PACKAGE_ROOT, 'examples', 'package.trust-receipt-bundle.axiom.json',
);
const canonicalPackagePath = path.join(
  CANONICAL_PACKAGE_ROOT, 'examples', 'package.empty.huqan.json',
);

check('package-wire', 'installed reader accepts retained legacy AXIOM package 0.1', () => {
  const result = packageFormat.validateHuqanPackage(readJson(legacyPackagePath));
  assert(result.ok, `legacy package rejected: ${JSON.stringify(result.errors)}`);
});

check('package-wire', 'installed reader accepts canonical HUQAN package 0.2', () => {
  const result = packageFormat.validateHuqanPackage(readJson(canonicalPackagePath));
  assert(result.ok, `canonical package rejected: ${JSON.stringify(result.errors)}`);
});

check('package-wire', 'installed writer emits canonical HUQAN identity and round-trips', () => {
  const written = packageFormat.createHuqanPackage(readJson(legacyPackagePath));
  assert(written.manifest.format === 'huqan-package', 'writer emitted legacy format');
  assert(written.manifest.formatVersion === '0.2', 'writer emitted wrong formatVersion');
  assert(written.manifest.protocolVersion === '0.1', 'writer omitted protocolVersion');
  assert(!Object.prototype.hasOwnProperty.call(written.manifest, 'atpVersion'),
    'writer retained atpVersion');
  assert(packageFormat.validateHuqanPackage(JSON.parse(JSON.stringify(written))).ok,
    'writer output failed JSON round-trip');
});

check('package-wire', 'installed reader rejects mixed legacy and canonical identity', () => {
  const mixed = readJson(canonicalPackagePath);
  mixed.manifest.atpVersion = '0.1';
  assert(!packageFormat.validateHuqanPackage(mixed).ok, 'mixed manifest was accepted');
});

check('package-wire', 'canonical manifest schema fixes the same strict wire identity', () => {
  const schema = readJson(path.join(
    CANONICAL_PACKAGE_ROOT, 'schemas', 'huqan-manifest.schema.json',
  ));
  for (const field of ['format', 'formatVersion', 'protocolVersion', 'source']) {
    assert(schema.required.includes(field), `schema does not require ${field}`);
  }
  assert(schema.properties.format.const === 'huqan-package', 'schema format drift');
  assert(schema.properties.formatVersion.const === '0.2', 'schema formatVersion drift');
  assert(schema.properties.protocolVersion.const === '0.1', 'schema protocolVersion drift');
  assert(JSON.stringify(schema.not) === JSON.stringify({ required: ['atpVersion'] }),
    'schema does not exclude mixed atpVersion');
});

check('surface', 'every ATP schema parses as JSON', () => {
  const dir = path.join(SPEC_ROOT, 'schemas');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  assert(files.length > 0, 'no schemas shipped');
  for (const file of files) readJson(path.join(dir, file));
  return `${files.length} schemas`;
});

const CANONICAL_JSON = [
  'a2a-trust-evidence.schema.json',
  'public-trust-receipt.schema.json',
  'public-receipt-redaction-policy.json',
  'shared-trust-package.schema.json',
  'agent-identity.schema.json',
];

check('surface', 'canonical HTP 0.2 carries exactly the RFC-002 JSON manifest', () => {
  const dir = path.join(CANONICAL_SPEC_ROOT, 'schemas');
  const files = fs.readdirSync(dir).filter((file) => file.endsWith('.json')).sort();
  assert(JSON.stringify(files) === JSON.stringify([...CANONICAL_JSON].sort()),
    `unexpected canonical JSON manifest: ${files.join(', ')}`);
  for (const file of files) readJson(path.join(dir, file));
  return `${files.length} canonical artifacts`;
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

  const disagreements = [];
  for (const [surface, root] of [
    ['legacy ATP 0.1', LEGACY_SPEC_ROOT],
    ['canonical HTP 0.2', CANONICAL_SPEC_ROOT],
  ]) {
    const script = path.join(root, 'conformance', 'verify_bundle.py');
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
          `${surface}/${file}: python=${JSON.stringify(pythonFindings)} consumer=${JSON.stringify(consumerFindings)}`,
        );
      }
      if ((run.status === 0) !== (pythonFindings.length === 0)) {
        disagreements.push(`${surface}/${file}: python exit status disagrees with its own findings`);
      }
    }
  }
  assert(disagreements.length === 0, disagreements.join('; '));
  return `${bundleFiles.length} fixtures across canonical and legacy verifiers, findings identical`;
});

function resolveLocalRef(root, ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], root);
}

function validateSchema(value, schema, root = schema, at = '<root>') {
  if (schema.$ref) return validateSchema(value, resolveLocalRef(root, schema.$ref), root, at);
  const errors = [];
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  const actual = value === null ? 'null'
    : Array.isArray(value) ? 'array'
      : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(actual)
      && !(actual === 'integer' && types.includes('number'))) {
    return [`${at}: expected ${types.join('|')}`];
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match ${schema.pattern}`);
    }
    if (schema.format === 'date-time'
        && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
      errors.push(`${at}: invalid date-time`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: below minimum ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: fewer than ${schema.minItems} items`);
    }
    if (schema.items) value.forEach((item, index) => {
      errors.push(...validateSchema(item, schema.items, root, `${at}[${index}]`));
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${at}: missing required ${required}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          errors.push(`${at}: unexpected property ${key}`);
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          errors.push(...validateSchema(item, schema.additionalProperties, root, `${at}.${key}`));
        }
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateSchema(value[key], subschema, root, `${at}.${key}`));
      }
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => (
      validateSchema(value, candidate, root, at).length === 0
    )).length;
    if (matches !== 1) errors.push(`${at}: expected exactly one oneOf match`);
  }
  return errors;
}

const V5_SCHEMAS = Object.fromEntries([
  'shared-trust-package.schema.json',
  'a2a-trust-evidence.schema.json',
  'public-trust-receipt.schema.json',
].map((file) => [file, readJson(path.join(CANONICAL_SPEC_ROOT, 'schemas', file))]));

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', 'title', 'description', 'type', 'const',
  'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'minimum',
  'minLength', 'pattern', 'format', 'oneOf',
]);

function unsupportedSchemaKeywords(node, container = '', at = '<root>') {
  if (Array.isArray(node)) return node.flatMap((item, index) => (
    unsupportedSchemaKeywords(item, '', `${at}[${index}]`)
  ));
  if (!node || typeof node !== 'object') return [];
  const errors = [];
  for (const [key, value] of Object.entries(node)) {
    const isSchemaName = container === 'properties' || container === '$defs';
    if (!isSchemaName && !SUPPORTED_SCHEMA_KEYWORDS.has(key)) errors.push(`${at}.${key}`);
    errors.push(...unsupportedSchemaKeywords(value, key, `${at}.${key}`));
  }
  return errors;
}

check('v5', 'packaged V5 schemas use only consumer-supported validation keywords', () => {
  for (const [file, schema] of Object.entries(V5_SCHEMAS)) {
    const unsupported = unsupportedSchemaKeywords(schema);
    assert(unsupported.length === 0, `${file}: unsupported keywords ${unsupported.join(', ')}`);
  }
});

const HEX = 'a'.repeat(64);
const sharedPackage = {
  schemaVersion: 'v5-shared-trust-package/v0.1',
  packageId: 'package-1',
  issuer: { agentId: 'agent-a', workspaceId: 'workspace-1' },
  subject: { type: 'change', id: 'change-1' },
  verdict: { status: 'allow' },
  receipt: { receiptId: 'receipt-1', issuedAt: '2026-01-01T00:00:00Z' },
  evidence: [{ type: 'test', ref: 'sha256:test' }],
  nonClaims: ['No runtime enforcement claim.'],
};

function evidenceEnvelope() {
  const agent = (id) => ({ agentId: id, identityRef: `identity:${id}` });
  return {
    schemaVersion: 'v5-a2a-trust-evidence-v1', envelopeId: 'envelope-1',
    delegation: {
      sourceAgent: agent('source'), targetAgent: agent('target'), workspaceId: 'workspace-1',
      delegationScope: ['repo:read'],
      requestedAction: { capability: 'repo:read', target: 'repo-1' },
      requestedOutput: { kind: 'report', expectedOutcome: 'read completed' },
      constraints: {}, expiresAt: '2026-12-31T00:00:00Z', delegationChain: ['source', 'target'],
    },
    observation: {
      observedAction: { capability: 'repo:read', target: 'repo-1' },
      observedOutcome: { status: 'observed_completed', detail: 'read completed' },
      effectSummary: 'repository read', observedAt: '2026-01-01T00:00:00Z',
      observedBy: { observerRef: 'source', observerRelation: 'delegator_observed' },
    },
    evidence: { evidenceRefs: [{ ref: 'log-1', hash: HEX }], trustReceipt: {
      receiptId: 'receipt-1', receiptHash: HEX,
    } },
    reconciliation: {
      scopeMatch: 'pass', requestedVsObservedMatch: 'pass', delegationChainValid: 'pass',
      withinExpiry: 'pass', evidenceSufficient: 'pass', verdict: 'allow', reasonCodes: ['ok'],
    },
  };
}

function reconcileEvidence(envelope) {
  const reasonCodes = [];
  const { delegation, observation, evidence } = envelope;
  if (!delegation.delegationScope.includes(observation.observedAction.capability)) {
    reasonCodes.push('scope_exceeded');
  }
  if (!evidence.evidenceRefs.length || !evidence.trustReceipt) reasonCodes.push('evidence_missing');
  if (delegation.expiresAt !== null
      && Date.parse(observation.observedAt) > Date.parse(delegation.expiresAt)) {
    reasonCodes.push('delegation_expired');
  }
  return { verdict: reasonCodes.length ? 'block' : 'allow', reasonCodes: reasonCodes.length
    ? reasonCodes : ['ok'] };
}

check('v5', 'packaged Shared Trust Package schema accepts a conforming package', () => {
  assert(validateSchema(sharedPackage, V5_SCHEMAS['shared-trust-package.schema.json']).length === 0,
    'conforming shared package was rejected');
});

check('v5', 'packaged Shared Trust Package schema rejects a missing packageId', () => {
  const invalid = { ...sharedPackage };
  delete invalid.packageId;
  assert(validateSchema(invalid, V5_SCHEMAS['shared-trust-package.schema.json'])
    .some((error) => /packageId/.test(error)), 'missing packageId was accepted');
});

check('v5', 'packaged Shared Trust Package schema rejects unknown, type, and enum violations', () => {
  for (const [name, invalid] of [
    ['unknown', { ...sharedPackage, surprise: true }],
    ['type', { ...sharedPackage, evidence: {} }],
    ['enum', { ...sharedPackage, verdict: { status: 'maybe' } }],
  ]) {
    assert(validateSchema(invalid, V5_SCHEMAS['shared-trust-package.schema.json']).length > 0,
      `${name} violation was accepted`);
  }
});

check('v5', 'packaged Shared Trust Package schema enforces metadata scalar values', () => {
  const invalid = {
    ...sharedPackage,
    receipt: { ...sharedPackage.receipt, routeReceipt: {
      routeId: 'route-1', hopCount: 1, metadata: { nested: { forbidden: true } },
    } },
  };
  assert(validateSchema(invalid, V5_SCHEMAS['shared-trust-package.schema.json'])
    .some((error) => error.includes('metadata.nested')), 'nested metadata was accepted');
});

check('v5', 'packaged C3 and C4 schemas remain distinct and accept their own artifacts', () => {
  const evidence = evidenceEnvelope();
  const publicReceipt = {
    schemaVersion: 'v5-public-trust-receipt-v1', publicReceiptId: HEX,
    issuedAt: '2026-01-01T00:00:00Z',
    disclosure: { receiptKind: 'action', decision: 'allow', verdict: 'allow', status: 'complete',
      riskScore: 0, trustPolicyVersion: 'v1', createdAt: '2026-01-01T00:00:00Z' },
    binding: { internalReceiptHash: HEX },
    integrity: { checksumAlgorithm: 'sha256-canonical-json-v1', checksum: HEX,
      signed: false, signature: null },
  };
  const c3 = V5_SCHEMAS['a2a-trust-evidence.schema.json'];
  const c4 = V5_SCHEMAS['public-trust-receipt.schema.json'];
  assert(validateSchema(evidence, c3).length === 0, 'C3 artifact rejected');
  assert(validateSchema(publicReceipt, c4).length === 0, 'C4 artifact rejected');
  assert(validateSchema(evidence, c4).length > 0, 'C3 artifact accepted as C4');
  assert(validateSchema(publicReceipt, c3).length > 0, 'C4 artifact accepted as C3');
});

for (const [name, requiredField, mutate, expected] of [
  ['scope', 'delegationScope', (value) => {
    value.observation.observedAction.capability = 'repo:write';
  }, 'scope_exceeded'],
  ['evidence', 'evidence', (value) => {
    value.evidence.evidenceRefs = []; value.evidence.trustReceipt = null;
  },
    'evidence_missing'],
  ['expiry', 'expiresAt', (value) => {
    value.delegation.expiresAt = '2025-12-31T00:00:00Z';
  },
    'delegation_expired'],
]) {
  check('v5', `C3 ${name} absence is structurally recordable and semantically fails closed`, () => {
    const invalid = evidenceEnvelope();
    mutate(invalid);
    assert(validateSchema(invalid, V5_SCHEMAS['a2a-trust-evidence.schema.json']).length === 0,
      `${name} negative is not structurally recordable`);
    const derived = reconcileEvidence(invalid);
    assert(derived.verdict === 'block', `${name} did not derive block`);
    assert(derived.reasonCodes.includes(expected),
      `${expected} not derived: ${derived.reasonCodes.join(',')}`);
  });
  check('v5', `C3 missing required ${requiredField} is structurally rejected`, () => {
    const invalid = evidenceEnvelope();
    if (name === 'evidence') delete invalid.evidence;
    else delete invalid.delegation[requiredField];
    assert(validateSchema(invalid, V5_SCHEMAS['a2a-trust-evidence.schema.json'])
      .some((error) => error.includes(`required ${requiredField}`)),
    `missing ${requiredField} was accepted`);
  });
}

check('v5', 'C3 derivation ignores stale reconciliation fields and identity-governed expiry', () => {
  const value = evidenceEnvelope();
  value.delegation.expiresAt = null;
  value.reconciliation = {
    scopeMatch: 'fail', requestedVsObservedMatch: 'fail', delegationChainValid: 'fail',
    withinExpiry: 'fail', evidenceSufficient: 'fail', verdict: 'block',
    reasonCodes: ['scope_exceeded'],
  };
  assert(JSON.stringify(reconcileEvidence(value))
    === JSON.stringify({ verdict: 'allow', reasonCodes: ['ok'] }),
  'derivation trusted stale reconciliation or rejected identity-governed expiry');
});

check('v5', 'no schemas/ directory reached the installed package', () => {
  assert(!fs.existsSync(path.join(PKG_ROOT, 'schemas')),
    'schemas/ is present in the installed package, which the facade contract forbids');
});

function replayPackage(createdAt) {
  const collections = ['provenanceRecords', 'auditEvents', 'candidateClaims', 'conflictResults',
    'verificationResults', 'trustReceipts', 'causalChains', 'simulationResults'];
  const objectCounts = {}; const objects = {};
  for (const name of collections) { objectCounts[name] = 0; objects[name] = []; }
  const legacy = {
    manifest: {
      packageId: 'pkg.external.conformance', format: 'axiom-package', formatVersion: '0.1',
      createdAt, createdBy: 'connector:external-conformance', workspaceId: 'workspace-conformance',
      source: { type: 'test', sourceRef: 'huqan://external-conformance/replay' },
      description: 'Installed-package replay fixture', atpVersion: '0.1', objectCounts,
    },
    objects,
    index: { byId: {}, bySourceRef: {}, byWorkspaceId: {}, byType: {} },
    metadata: { warnings: [] },
  };
  return packageFormat.createHuqanPackage(legacy);
}

checkAsync('replay', 'installed authority accepts once and rejects the identical signed package replay', async () => {
  const { stableStringify } = require('huqan/lib/receipt/canonical-receipt');
  const {
    EXTERNAL_CLIENT_ADMISSION_PERMISSION,
    EXTERNAL_CLIENT_AUTHORITY_ERRORS,
    enforceExternalClientAuthority,
    snapshotExternalClientAuthority,
  } = require('huqan/lib/external-client-authority');
  const now = Date.parse('2026-08-02T12:00:00.000Z');
  const createdAt = '2026-08-02T11:59:00.000Z';
  const pkg = replayPackage(createdAt);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const signature = {
    algorithm: 'ed25519',
    keyId: 'external-conformance-key',
    value: crypto.sign(null, Buffer.from(stableStringify(pkg), 'utf8'), privateKey).toString('base64'),
  };
  const seen = new Set();
  const replayStore = {
    reserve(record) {
      if (seen.has(record.replayKey)) return { reserved: false, existing: { replayKey: record.replayKey } };
      seen.add(record.replayKey);
      return { reserved: true };
    },
  };
  const authority = snapshotExternalClientAuthority({
    expectedIdentitySubject: 'connector:external-conformance',
    expectedIdentityKind: 'connector',
    expectedWorkspaceId: 'workspace-conformance',
    expectedPackageId: 'pkg.external.conformance',
    permissions: [EXTERNAL_CLIENT_ADMISSION_PERMISSION],
    trustedKeys: {
      'external-conformance-key': {
        publicKey,
        workspaceId: 'workspace-conformance',
        packageIds: ['pkg.external.conformance'],
        identitySubjects: ['connector:external-conformance'],
        identityKinds: ['connector'],
        notBefore: '2026-08-02T11:00:00.000Z',
        notAfter: '2026-08-02T13:00:00.000Z',
        revoked: false,
      },
    },
    clock: () => now,
    replayStore,
  });
  const input = {
    identity: { subject: 'connector:external-conformance', kind: 'connector' },
    workspaceId: 'workspace-conformance',
    package: pkg,
    signature,
  };
  const first = await enforceExternalClientAuthority(input, authority);
  assert(first.ok === true && first.decision === 'allow', 'first admission did not pass');
  assert(first.gate.gateVersion === 'tb-a6-v2', 'canonical gate version mismatch');
  assert(first.gate.receipt.packageFormat === 'huqan-package', 'gate receipt lost format');
  assert(first.gate.receipt.packageFormatVersion === '0.2', 'gate receipt lost formatVersion');
  assert(first.gate.receipt.packageProtocolVersion === '0.1',
    'gate receipt lost protocolVersion');
  assert(first.gate.receipt.atpVersion === null, 'canonical gate receipt exposed atpVersion');
  let replayError = null;
  try { await enforceExternalClientAuthority(input, authority); } catch (error) { replayError = error; }
  assert(replayError && replayError.code === EXTERNAL_CLIENT_AUTHORITY_ERRORS.REPLAY_DETECTED,
    `identical replay was not rejected with REPLAY_DETECTED: ${replayError && replayError.code}`);
});

async function finish() {
  await Promise.all(pendingCases);
  const failed = cases.filter((c) => c.status === 'fail');
  const skippedCases = cases.filter((c) => c.status === 'skip');
  const crossImplementationCase = cases.find((c) => c.group === 'cross-implementation');
  const report = {
    evidenceLevels: EVIDENCE_LEVELS,
    evidenceLevelNote:
      'Evidence is group-scoped: package reachability is a packaged-surface smoke; '
      + 'ATP object, package-wire, replay, and JavaScript bundle checks are self-test; the Python comparison is '
      + 'cross-implementation conformance only when its case passes. '
      + 'This run does not establish third-party verification or interoperability.',
    crossImplementationExecuted: crossImplementationCase?.status === 'pass',
    packageRoot: PKG_ROOT,
    packageVersion: readJson(path.join(PKG_ROOT, 'package.json')).version,
    total: cases.length,
    passed: cases.length - failed.length - skippedCases.length,
    skipped: skippedCases.length,
    failed: failed.length,
    blockedGaps: [],
    cases,
  };

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exit(failed.length === 0 ? 0 : 1);
}

finish();
