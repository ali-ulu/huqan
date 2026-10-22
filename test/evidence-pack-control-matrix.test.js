'use strict';

/**
 * #4092 PR-A3 -- the SOC 2 control matrix and README-AUDITOR.
 *
 * The matrix is a claim about what a pack contains, so the tests pin the three
 * ways it could mislead: naming a file the pack never carries, using wording
 * that reads as a verdict, and dropping the non-claims. The pack layout is read
 * from the spec README rather than copied here, so the spec stays the one place
 * that defines which files exist.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  buildControlMatrix,
  renderControlMatrixJson,
  renderAuditorReadme,
} = require('../lib/evidence-pack/control-matrix');
const {
  INTEGRITY_CLASS_VALUES,
  PACK_NON_CLAIMS,
  buildManifest,
} = require('../lib/evidence-pack/manifest');

const ROOT = path.join(__dirname, '..');
const SPEC_README = fs.readFileSync(path.join(ROOT, 'specs/huqan-evidence-pack/0.1/README.md'), 'utf8');

// Verdict wording, English and Turkish stems. Case-insensitive.
const VERDICT_WORDING = /certif|complian|satisf|audit[- ]ready|sertifika|uyumlu|kar[sş]ıla(nd|r)/i;

function packLayoutPaths() {
  const block = SPEC_README.match(/## Directory layout\s+```\r?\n([\s\S]*?)```/);
  assert.ok(block, 'spec README has a layout block');
  return block[1].split('\n').slice(1)
    .map(line => line.replace(/#.*/, '').trim())
    .filter(Boolean);
}

function sampleManifest() {
  return buildManifest({
    period: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.999Z' },
    generatedAt: '2026-02-01T00:00:00.000Z',
    workspaceId: 'default',
    producer: { product: 'huqan', version: '1.1.1', issuerKeyId: null },
    files: [],
  });
}

test('every control row names at least one evidence file present in pack schema', () => {
  const layout = new Set(packLayoutPaths());
  assert.ok(layout.has('manifest.json'));
  for (const control of buildControlMatrix().controls) {
    assert.ok(control.evidenceFiles.length > 0, `${control.tsc} names no evidence file`);
    for (const file of control.evidenceFiles) {
      assert.ok(layout.has(file), `${control.tsc} names ${file}, which the pack layout does not carry`);
    }
  }
});

test('every control source points at a real file and a line range inside it', () => {
  for (const control of buildControlMatrix().controls) {
    assert.ok(control.sources.length > 0, `${control.tsc} names no source`);
    for (const source of control.sources) {
      const [file, range] = source.split(':');
      const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split('\n').length;
      const [start, end = start] = range.split('-').map(Number);
      assert.ok(start >= 1 && start <= end && end <= lines, `${source} is outside ${file} (${lines} lines)`);
    }
  }
});

test('no control row uses satisfies or certified wording', () => {
  const matrix = buildControlMatrix();
  for (const control of matrix.controls) {
    assert.equal(control.relevance, 'supporting_evidence');
    // Every field of a row, nonClaim included: a row has no reason to need the words.
    assert.doesNotMatch(JSON.stringify(control), VERDICT_WORDING, `${control.tsc} uses verdict wording`);
  }
  assert.doesNotMatch(JSON.stringify(matrix.outOfScope), VERDICT_WORDING);
  // The pack-level nonClaims are the one place the words appear, and only negated.
  assert.ok(matrix.nonClaims.every(claim => /\b(not|does not)\b/.test(claim)));
});

test('README-AUDITOR avoids verdict wording outside the verbatim non-claims', () => {
  const readme = renderAuditorReadme({ manifest: sampleManifest() });
  const outsideNonClaims = PACK_NON_CLAIMS.reduce((text, claim) => text.replace(claim, ''), readme);
  assert.doesNotMatch(outsideNonClaims, VERDICT_WORDING);
});

test('nonClaims include soc2-certification', () => {
  const matrix = buildControlMatrix();
  for (const claims of [matrix.nonClaims, sampleManifest().nonClaims]) {
    assert.ok(claims.some(c => /SOC 2/.test(c) && /does not certify/.test(c)));
  }
});

test('out-of-scope criteria are listed as no evidence produced', () => {
  const { outOfScope } = buildControlMatrix();
  assert.deepEqual(outOfScope.map(o => o.tsc), ['CC1.x', 'CC2.x', 'CC3.x', 'CC9.x', 'C1', 'P']);
  assert.ok(outOfScope.every(o => /does not produce evidence/.test(o.note)));
});

test('README-AUDITOR carries the manifest non-claims verbatim and both verify commands', () => {
  const readme = renderAuditorReadme({ manifest: sampleManifest() });
  for (const claim of PACK_NON_CLAIMS) assert.ok(readme.includes(claim), claim);
  for (const cls of INTEGRITY_CLASS_VALUES) assert.ok(readme.includes(`\`${cls}\``), cls);
  assert.ok(readme.includes('huqan evidence verify <dir>'));
  assert.ok(readme.includes('python3 verify_pack.py <dir>'));
  const flat = readme.replace(/\s+/g, ' ');
  assert.match(flat, /does not show that the issuer is independent/);
  assert.match(flat, /checked for its shape only/);
});

test('renderAuditorReadme rejects a manifest without nonClaims', () => {
  assert.throws(() => renderAuditorReadme({}), TypeError);
  assert.throws(() => renderAuditorReadme({ manifest: { period: {} } }), TypeError);
});

test('matrix and README render byte-identically on every call', () => {
  assert.equal(renderControlMatrixJson(), renderControlMatrixJson());
  assert.deepEqual(JSON.parse(renderControlMatrixJson()), JSON.parse(JSON.stringify(buildControlMatrix())));
  const manifest = sampleManifest();
  assert.equal(renderAuditorReadme({ manifest }), renderAuditorReadme({ manifest }));
});

test('the matrix table cannot be edited by a caller', () => {
  const matrix = buildControlMatrix();
  assert.throws(() => { 'use strict'; matrix.controls[0].evidenceFiles.push('x'); }, TypeError);
  assert.throws(() => { 'use strict'; matrix.controls.push({}); }, TypeError);
});
