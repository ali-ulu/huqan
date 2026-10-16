const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const {
  validateAxiomPackage,
  validateAxiomPackageFile,
  AXIOM_PACKAGE_FORMAT_VERSION,
  HUQAN_PACKAGE_FORMAT_VERSION,
  validateHuqanPackage,
  createHuqanPackage,
  writeHuqanPackageFile,
} = require('./huqan-package-format');

const fixtureDir = path.join(__dirname, '..', 'specs', 'axiom-package-format', '0.1', 'examples');
const huqanFixture = path.join(
  __dirname, '..', 'specs', 'huqan-package-format', '0.2', 'examples',
  'package.empty.huqan.json',
);

function readFixture(name) {
  return JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8'));
}

function validateFixture(name) {
  return validateAxiomPackageFile(path.join(fixtureDir, name));
}

test('axiom package format version is 0.1', () => {
  assert.equal(AXIOM_PACKAGE_FORMAT_VERSION, '0.1');
  assert.equal(HUQAN_PACKAGE_FORMAT_VERSION, '0.2');
});

test('canonical HUQAN fixture passes the dual-format reader', () => {
  const pkg = JSON.parse(fs.readFileSync(huqanFixture, 'utf8'));
  const result = validateHuqanPackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
});

test('reader rejects mixed and crossed wire discriminator tuples', () => {
  const legacy = readFixture('package.trust-receipt-bundle.axiom.json');
  const canonical = JSON.parse(fs.readFileSync(huqanFixture, 'utf8'));
  const mutants = [
    { ...legacy, manifest: { ...legacy.manifest, protocolVersion: '0.1' } },
    { ...canonical, manifest: { ...canonical.manifest, atpVersion: '0.1' } },
    { ...legacy, manifest: { ...legacy.manifest, format: 'huqan-package' } },
    { ...canonical, manifest: { ...canonical.manifest, formatVersion: '0.1' } },
  ];
  for (const mutant of mutants) assert.equal(validateHuqanPackage(mutant).ok, false);

  const missingSource = JSON.parse(fs.readFileSync(huqanFixture, 'utf8'));
  delete missingSource.manifest.source;
  assert.equal(validateHuqanPackage(missingSource).ok, false);
});

test('canonical writer removes legacy identity and round-trips through a .huqan file', () => {
  const legacy = readFixture('package.candidate-claims.axiom.json');
  const canonical = createHuqanPackage(legacy);
  assert.equal(canonical.manifest.format, 'huqan-package');
  assert.equal(canonical.manifest.formatVersion, '0.2');
  assert.equal(canonical.manifest.protocolVersion, '0.1');
  assert.equal(Object.hasOwn(canonical.manifest, 'atpVersion'), false);
  assert.equal(legacy.manifest.format, 'axiom-package');
  assert.notEqual(canonical.objects, legacy.objects);
  const originalStatus = legacy.objects.candidateClaims[0].status;
  legacy.objects.candidateClaims[0].status = 'rejected';
  assert.notEqual(canonical.objects.candidateClaims[0].status, 'rejected');
  legacy.objects.candidateClaims[0].status = originalStatus;

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-package-'));
  const output = path.join(tempDir, 'round-trip.huqan');
  writeHuqanPackageFile(output, legacy);
  assert.equal(validateHuqanPackage(JSON.parse(fs.readFileSync(output, 'utf8'))).ok, true);
  assert.throws(() => writeHuqanPackageFile(output, legacy), { code: 'EEXIST' });
  assert.throws(() => writeHuqanPackageFile(path.join(tempDir, 'wrong.axiom'), legacy));
});

test('canonical writer rejects non-deterministic JSON without invoking accessors', () => {
  const base = readFixture('package.candidate-claims.axiom.json');
  let invoked = 0;
  const accessor = { ...base, manifest: { ...base.manifest } };
  Object.defineProperty(accessor.manifest, 'description', {
    enumerable: true,
    get() { invoked += 1; return 'hostile'; },
  });
  assert.throws(() => createHuqanPackage(accessor), /data properties/);
  assert.equal(invoked, 0);

  const inherited = Object.create({ surprise: true });
  Object.assign(inherited, base);
  assert.throws(() => createHuqanPackage(inherited), /plain/);

  const cyclic = readFixture('package.candidate-claims.axiom.json');
  cyclic.metadata.loop = cyclic;
  assert.throws(() => createHuqanPackage(cyclic), /circular/);
});

test('valid package fixtures pass', () => {
  for (const name of [
    'package.trust-receipt-bundle.axiom.json',
    'package.github-pr-review.axiom.json',
    'package.causal-simulation.axiom.json',
    'package.candidate-claims.axiom.json',
  ]) {
    const result = validateFixture(name);
    assert.equal(result.ok, true, `${name} should pass`);
    assert.equal(result.errors.length, 0, `${name} should not have errors`);
  }
});

test('manifest validation fails on required field violations', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  delete pkg.manifest.packageId;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => err.field === 'manifest.packageId'));

  const wrongFormat = readFixture('package.trust-receipt-bundle.axiom.json');
  wrongFormat.manifest.format = 'wrong';
  assert.equal(validateAxiomPackage(wrongFormat).ok, false);

  const wrongFormatVersion = readFixture('package.trust-receipt-bundle.axiom.json');
  wrongFormatVersion.manifest.formatVersion = '0.2';
  assert.equal(validateAxiomPackage(wrongFormatVersion).ok, false);

  const wrongAtpVersion = readFixture('package.trust-receipt-bundle.axiom.json');
  wrongAtpVersion.manifest.atpVersion = '0.2';
  assert.equal(validateAxiomPackage(wrongAtpVersion).ok, false);

  const missingWorkspace = readFixture('package.trust-receipt-bundle.axiom.json');
  delete missingWorkspace.manifest.workspaceId;
  assert.equal(validateAxiomPackage(missingWorkspace).ok, false);
});

test('object validation rejects invalid embedded ATP data', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  pkg.objects.provenanceRecords[0].provenanceId = '';
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => String(err.field).includes('objects.provenanceRecords[0].provenanceId')));
});

test('trust receipt canonical state is enforced', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  pkg.objects.trustReceipts[0].canonical = false;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => String(err.field).includes('objects.trustReceipts[0].canonical')));
});

test('pending candidate remains non-canonical and valid', () => {
  const pkg = readFixture('package.github-pr-review.axiom.json');
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, true);
  assert.equal(pkg.objects.candidateClaims[0].status, 'pending');
  assert.equal(pkg.objects.candidateClaims[0].recommendation, 'flag');
});

test('object count mismatch is an integrity error (#1119)', () => {
  const pkg = readFixture('package.candidate-claims.axiom.json');
  pkg.manifest.objectCounts.candidateClaims = 99;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((error) => (
    error.code === 'PACKAGE_OBJECT_COUNT_MISMATCH'
      && error.field === 'manifest.objectCounts.candidateClaims'
      && /declares 99 but package embeds/.test(error.message)
  )));
});

test('HUQAN manifest cannot attest to objects the package does not embed (#1119)', () => {
  const pkg = JSON.parse(fs.readFileSync(huqanFixture, 'utf8'));
  pkg.manifest.objectCounts.trustReceipts = 100;
  pkg.manifest.objectCounts.auditEvents = 57;

  const result = validateHuqanPackage(pkg);
  assert.equal(result.ok, false);
  assert.deepEqual(
    result.errors
      .filter(error => error.code === 'PACKAGE_OBJECT_COUNT_MISMATCH')
      .map(error => error.field),
    ['manifest.objectCounts.auditEvents', 'manifest.objectCounts.trustReceipts'],
  );
});

test('object count integrity checks still run if manifest has other errors', () => {
  const pkg = readFixture('package.candidate-claims.axiom.json');
  pkg.manifest.atpVersion = '0.2';
  pkg.manifest.objectCounts.candidateClaims = 99;
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => err.field === 'manifest.atpVersion'));
  assert.ok(result.errors.some((error) => error.field === 'manifest.objectCounts.candidateClaims'));
});

test('x-* extension fields are tolerated and do not override core fields', () => {
  const pkg = readFixture('package.causal-simulation.axiom.json');
  pkg['x-axiom-experimental'] = { enabled: true };
  pkg.manifest['x-axiom-experimental'] = { note: 'ok' };
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, true);
});

test('x-* extension fields can be rejected when extensions are disabled', () => {
  const pkg = readFixture('package.causal-simulation.axiom.json');
  pkg['x-axiom-experimental'] = { enabled: true };
  const result = validateAxiomPackage(pkg, { allowExtensions: false });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => err.field === 'x-axiom-experimental'));
});

test('index validation rejects unknown ids and mismatched references', () => {
  const pkg = readFixture('package.trust-receipt-bundle.axiom.json');
  pkg.index.byType['trust-receipt'] = ['missing-id'];
  const result = validateAxiomPackage(pkg);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((err) => String(err.field).includes('index.byType.trust-receipt')));
});

test('validateAxiomPackageFile handles temp files', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-package-'));
  const tempFile = path.join(tempDir, 'temp.axiom.json');
  fs.writeFileSync(tempFile, JSON.stringify(readFixture('package.trust-receipt-bundle.axiom.json'), null, 2));
  const result = validateAxiomPackageFile(tempFile);
  assert.equal(result.ok, true);
});
