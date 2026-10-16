const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const axiomVerify = require('./index');
const huqanVerify = require('../huqan-verify');

const trustSpecDir = path.join(__dirname, '..', '..', 'specs', 'axiom-trust-protocol', '0.1', 'examples');
const packageSpecDir = path.join(__dirname, '..', '..', 'specs', 'axiom-package-format', '0.1', 'examples');
const huqanPackageFixture = path.join(
  __dirname, '..', '..', 'specs', 'huqan-package-format', '0.2', 'examples',
  'package.empty.huqan.json',
);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('legacy path re-exports canonical supported protocol metadata', () => {
  const protocols = axiomVerify.getSupportedProtocols();
  assert.strictEqual(axiomVerify, huqanVerify);
  assert.equal(axiomVerify.packageName, 'huqan-verify');
  assert.equal(axiomVerify.packageVersion, '0.1.0');
  assert.equal(axiomVerify.status, 'skeleton');
  assert.equal(protocols.atp, '0.1');
  assert.equal(protocols.avp, '0.1');
  assert.equal(protocols.axiomPackageFormat, '0.1');
  assert.equal(protocols.huqanPackageFormat, '0.2');
});

test('valid provenance fixture passes', () => {
  const provenance = readJson(path.join(trustSpecDir, 'provenance.github.merged_pr.json'));
  const result = axiomVerify.verifyATPObject(axiomVerify.ATP_OBJECT_TYPES.provenanceRecord, provenance);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('invalid provenance confidence fails', () => {
  const provenance = readJson(path.join(trustSpecDir, 'provenance.github.merged_pr.json'));
  provenance.confidence = 1.25;
  const result = axiomVerify.verifyATPObject(axiomVerify.ATP_OBJECT_TYPES.provenanceRecord, provenance);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'confidence'));
});

test('valid trust receipt passes', () => {
  const receipt = readJson(path.join(trustSpecDir, 'trust-receipt.github_pr.json'));
  const result = axiomVerify.verifyTrustReceipt(receipt);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('unsupported verification result cannot be treated as verified', () => {
  const resultInput = readJson(path.join(trustSpecDir, 'verification.unsupported.json'));
  resultInput.ok = true;
  const result = axiomVerify.verifyVerificationResult(resultInput);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'status'));
});

test('contradicted verification result cannot be treated as verified', () => {
  const resultInput = readJson(path.join(trustSpecDir, 'verification.contradicted.json'));
  resultInput.ok = true;
  const result = axiomVerify.verifyVerificationResult(resultInput);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => error.field === 'status'));
});

test('valid axiom package passes', () => {
  const pkg = readJson(path.join(packageSpecDir, 'package.trust-receipt-bundle.axiom.json'));
  const result = axiomVerify.verifyAxiomPackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('axiom package file validation passes', () => {
  const filePath = path.join(packageSpecDir, 'package.github-pr-review.axiom.json');
  const result = axiomVerify.verifyAxiomPackageFile(filePath);
  assert.equal(result.ok, true);
});

test('canonical HUQAN package validation and writer are available through the legacy alias', () => {
  const canonical = readJson(huqanPackageFixture);
  assert.equal(axiomVerify.verifyHuqanPackage(canonical).ok, true);
  assert.equal(axiomVerify.verifyAxiomPackage(canonical).ok, true);

  const legacy = readJson(path.join(packageSpecDir, 'package.trust-receipt-bundle.axiom.json'));
  const written = axiomVerify.createHuqanPackage(legacy);
  assert.equal(written.manifest.format, 'huqan-package');
  assert.equal(written.manifest.protocolVersion, '0.1');
  assert.equal(Object.hasOwn(written.manifest, 'atpVersion'), false);
});

test('createVerifier binds helpers', () => {
  const verifier = axiomVerify.createVerifier({ strict: true });
  assert.equal(verifier.packageName, 'huqan-verify');
  assert.equal(verifier.packageVersion, '0.1.0');
  assert.equal(verifier.status, 'skeleton');
  assert.equal(verifier.supportedProtocols.atp, '0.1');
  assert.equal(typeof verifier.verifyATPObject, 'function');
  assert.equal(typeof verifier.verifyAxiomPackage, 'function');
  assert.equal(verifier.options.strict, true);
});
