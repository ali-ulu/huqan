'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { CANONICAL_SPEC_ROOT, SPEC_ROOT, EXAMPLES, record, check, assert, readJson } = require('./consumer-harness');

// External conformance cases: ATP schemas, example objects and fail-closed
// object checks. Runs on require, in the order consumer.js requires the
// sections.

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

module.exports = { bundleFiles };
