'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// The runner is a script, not a module: it executes its whole case list on
// require. Lift the parser out by source so it can be tested in isolation,
// which is what the original lack of a unit test cost here.
const RUNNER = path.resolve(__dirname, '..', 'scripts', 'external-conformance', 'consumer.js');
const source = fs.readFileSync(RUNNER, 'utf8');
const extracted = source.match(/function parsePythonReport\([\s\S]*?\n}/);
assert.ok(extracted, 'parsePythonReport must exist in the external conformance runner');
// eslint-disable-next-line no-new-func
const parsePythonReport = new Function(`${extracted[0]}; return parsePythonReport;`)();

// Exactly the lines specs/*/conformance/verify_bundle.py prints, whose format
// string is "%-46s %s (%s)%s" -- filename, VALID/INVALID, signature status,
// then two spaces and the comma-joined findings.
const INVALID_UNSIGNED = 'receipt-bundle.broken-chain.json               INVALID (unsigned)  bundle_seal_mismatch, content_tampered@1';
const INVALID_SIGNED = 'b.json                                         INVALID (signed by key-1)  content_tampered@2';
const VALID_UNSIGNED = 'receipt-bundle.valid.json                      VALID (unsigned)';
const VALID_SIGNED = 'c.json                                         VALID (signed by key-1)';

test('the signature status is not read as a finding', () => {
  // The regression itself. #1810 added the signature status to the reference
  // verifier's output; this parser predates it and split everything after
  // INVALID on commas, so it reported
  //   ["(unsigned)  bundle_seal_mismatch", "content_tampered@1"]
  // against the consumer's
  //   ["bundle_seal_mismatch", "content_tampered@1"]
  // -- two implementations that agree exactly, reported as a disagreement.
  const report = parsePythonReport(INVALID_UNSIGNED);
  assert.deepEqual(report.findings, ['bundle_seal_mismatch', 'content_tampered@1']);
  for (const finding of report.findings) {
    assert.ok(!finding.includes('('), `finding carries the signature status: ${finding}`);
  }
});

test('the signature status is kept rather than discarded', () => {
  // Stripping it into the void would trade one blind spot for another: whether
  // a bundle was signed is the claim #1788 will need to assert on.
  assert.equal(parsePythonReport(INVALID_UNSIGNED).signatureStatus, 'unsigned');
  assert.equal(parsePythonReport(INVALID_SIGNED).signatureStatus, 'signed by key-1');
  assert.equal(parsePythonReport(VALID_UNSIGNED).signatureStatus, 'unsigned');
  assert.equal(parsePythonReport(VALID_SIGNED).signatureStatus, 'signed by key-1');
});

test('a signature status containing spaces does not split into findings', () => {
  // "signed by <ref>" has spaces and could be mistaken for prose; only the
  // comma-separated tail after the parenthetical is a finding list.
  assert.deepEqual(parsePythonReport(INVALID_SIGNED).findings, ['content_tampered@2']);
});

test('a valid bundle reports no findings in either signature state', () => {
  assert.deepEqual(parsePythonReport(VALID_UNSIGNED).findings, []);
  assert.deepEqual(parsePythonReport(VALID_SIGNED).findings, []);
});

test('findings come back sorted, so the comparison is order-independent', () => {
  const shuffled = 'x.json  INVALID (unsigned)  content_tampered@1, bundle_seal_mismatch';
  assert.deepEqual(parsePythonReport(shuffled).findings, ['bundle_seal_mismatch', 'content_tampered@1']);
});

test('output that matches no known shape fails loudly', () => {
  // A silent [] here would read as "the reference verifier found nothing wrong",
  // which is the worst possible failure mode for a conformance comparison.
  assert.throws(() => parsePythonReport('Traceback (most recent call last):'), /unparseable verifier output/);
});

test('a 0.2-shaped line with no signature status parses too', () => {
  // The two shipped verifiers do not print the same thing. ATP 0.1 gained the
  // signature parenthetical in #1810; huqan-trust-protocol 0.2 still prints
  // "%-46s %s%s" with no status at all. The parser has to read both, so the
  // parenthetical is optional rather than assumed.
  const line = 'receipt-bundle.broken-chain.json               INVALID  bundle_seal_mismatch, content_tampered@1';
  const report = parsePythonReport(line);
  assert.deepEqual(report.findings, ['bundle_seal_mismatch', 'content_tampered@1']);
  assert.equal(report.signatureStatus, '');
});

test('the reference verifiers still print the formats this parses', () => {
  // The parser broke because it was pinned to a format string nobody was
  // watching, in a file the parser does not import. If either verify_bundle.py
  // changes its output again, it fails here -- naming the file and the format
  // -- rather than surfacing as an unexplained cross-implementation
  // disagreement two layers away.
  const root = path.resolve(__dirname, '..');
  const formats = {
    'specs/axiom-trust-protocol/0.1/conformance/verify_bundle.py': '"%-46s %s (%s)%s"',
    'specs/huqan-trust-protocol/0.2/conformance/verify_bundle.py': '"%-46s %s%s"',
  };
  for (const [verifier, format] of Object.entries(formats)) {
    const text = fs.readFileSync(path.join(root, verifier), 'utf8');
    assert.ok(text.includes(format),
      `${verifier} no longer prints ${format}, which scripts/external-conformance/consumer.js parses`);
  }
});
