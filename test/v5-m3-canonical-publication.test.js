'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const CANONICAL = path.join(ROOT, 'specs', 'huqan-trust-protocol', '0.2');
const MIRROR = path.join(ROOT, 'schemas', 'v5');
const LEGACY = path.join(ROOT, 'specs', 'axiom-trust-protocol', '0.1');
const PUBLISHED_JSON = Object.freeze([
  'a2a-trust-evidence.schema.json',
  'public-trust-receipt.schema.json',
  'public-receipt-redaction-policy.json',
  'shared-trust-package.schema.json',
  'agent-identity.schema.json',
]);

function packageFiles() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).files;
}

test('M3 canonical publication has the exact literal JSON manifest', () => {
  const actual = fs.readdirSync(path.join(CANONICAL, 'schemas'))
    .filter((name) => name.endsWith('.json')).sort();
  assert.deepStrictEqual(actual, [...PUBLISHED_JSON].sort());
});

test('M3 canonical JSON and working mirrors are byte-identical', () => {
  for (const name of PUBLISHED_JSON) {
    assert.deepStrictEqual(
      fs.readFileSync(path.join(CANONICAL, 'schemas', name)),
      fs.readFileSync(path.join(MIRROR, name)),
      `${name} drifted from its working mirror`,
    );
  }
});

test('M3 canonical identifiers and canonicalization source use HTP 0.2', () => {
  const prefix = 'https://huqan.dev/specs/huqan-trust-protocol/0.2/schemas/';
  for (const name of PUBLISHED_JSON.filter((item) => item.endsWith('.schema.json'))) {
    const schema = JSON.parse(fs.readFileSync(path.join(CANONICAL, 'schemas', name), 'utf8'));
    assert.equal(schema.$id, `${prefix}${name}`);
  }
  const policy = JSON.parse(fs.readFileSync(
    path.join(CANONICAL, 'schemas', 'public-receipt-redaction-policy.json'), 'utf8',
  ));
  assert.equal(policy.integrity.canonicalizationSource,
    'specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md');
});

test('M3 package allowlist publishes only the literal canonical surface', () => {
  const files = packageFiles();
  const expected = [
    'specs/huqan-trust-protocol/0.2/README.md',
    'specs/huqan-trust-protocol/0.2/RECEIPT-BUNDLE.md',
    'specs/huqan-trust-protocol/0.2/conformance/README.md',
    'specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py',
    ...PUBLISHED_JSON.map((name) => `specs/huqan-trust-protocol/0.2/schemas/${name}`),
  ];
  for (const entry of expected) assert.ok(files.includes(entry), `missing package entry: ${entry}`);
  assert.deepStrictEqual(files.filter((entry) => entry.includes('*')), []);
  assert.equal(files.some((entry) => entry.startsWith('schemas/')), false);
  assert.equal(files.some((entry) => /huqan-trust-protocol\/0\.2\/.*\.js$/.test(entry)), false);
  assert.equal(files.some((entry) => entry.endsWith('shared-trust-package-conformance-matrix.json')), false);
});

test('M3 packed package contains exactly the canonical JSON manifest', () => {
  const result = cp.spawnSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: ROOT, encoding: 'utf8', shell: true, timeout: 60000,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const packed = JSON.parse(result.stdout)[0].files.map((item) => item.path);
  const actual = packed.filter((entry) => entry.startsWith(
    'specs/huqan-trust-protocol/0.2/schemas/',
  )).sort();
  assert.deepStrictEqual(actual,
    PUBLISHED_JSON.map((name) => `specs/huqan-trust-protocol/0.2/schemas/${name}`).sort());
  assert.equal(packed.some((entry) => entry.startsWith('schemas/')), false);
});

test('M3 preserves the legacy verifier at its ATP 0.1 path', () => {
  const verifier = path.join(LEGACY, 'conformance', 'verify_bundle.py');
  const fixture = path.join(LEGACY, 'examples', 'receipt-bundle.valid.json');
  assert.ok(fs.existsSync(verifier));
  const candidates = process.platform === 'win32'
    ? [['py', '-3'], ['python']]
    : [['python3'], ['python']];
  const python = candidates.find(([command, ...args]) => {
    const probe = cp.spawnSync(command, [...args, '-c', 'import sys'], { encoding: 'utf8' });
    return !probe.error && probe.status === 0;
  });
  if (!python) return;
  const [command, ...args] = python;
  const result = cp.spawnSync(command, [...args, verifier, fixture], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /VALID/);
});
