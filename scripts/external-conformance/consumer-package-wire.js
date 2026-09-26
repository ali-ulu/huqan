'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { PKG_ROOT, LEGACY_PACKAGE_ROOT, CANONICAL_PACKAGE_ROOT, check, assert, readJson } = require('./consumer-harness');

// External conformance cases: required packaged surface and the dual-format
// package reader/writer. Runs on require, in the order consumer.js requires
// the sections.

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

module.exports = { packageFormat };
