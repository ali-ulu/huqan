'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { verifyBundle } = require('./verify-bundle');
const { LEGACY_SPEC_ROOT, CANONICAL_SPEC_ROOT, skipped, check, assert, readJson } = require('./consumer-harness');
const { bundleFiles } = require('./consumer-objects');
const { BUNDLE_EXPECTATIONS } = require('./consumer-bundles');

// External conformance cases: the cross-implementation comparison against the
// shipped Python verifier. Runs on require, in the order consumer.js requires
// the sections.

/**
 * Read the reference verifier's findings out of its report line, which reads
 * `<file>  INVALID (<signature status>)  <finding>, <finding>`.
 *
 * The parenthetical is the signature status, not a finding. #1810 added it;
 * this parser predated it and split everything after INVALID on commas, so the
 * status was glued to the first finding and the comparison could never agree --
 * `["(unsigned)  bundle_seal_mismatch", ...]` against
 * `["bundle_seal_mismatch", ...]`, two implementations agreeing exactly and
 * reported as a disagreement. Optional, since ATP 0.1 prints it and 0.2 does
 * not. The status is returned rather than dropped: #1788 will need it.
 *
 * Lives in a sibling of consumer.js, which run.js copies into the throwaway
 * consumer project together with consumer.js and verify-bundle.js, so the
 * package is still proved to run without the repository.
 */
function parsePythonReport(stdout) {
  const line = stdout.trim().split('\n').pop() || '';
  if (/\bVALID\b/.test(line) && !/\bINVALID\b/.test(line)) {
    const valid = line.match(/\(([^)]*)\)/);
    return { findings: [], signatureStatus: valid ? valid[1] : '' };
  }
  const tail = line.split(/\bINVALID\b/)[1];
  if (tail === undefined) throw new Error(`unparseable verifier output: ${line}`);
  const status = tail.match(/^\s*\(([^)]*)\)/);
  const findingsText = status ? tail.slice(status[0].length) : tail;
  return {
    findings: findingsText.split(',').map((s) => s.trim()).filter(Boolean).sort(),
    signatureStatus: status ? status[1] : '',
  };
}

const parsePythonFindings = (stdout) => parsePythonReport(stdout).findings;

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
    // Each surface against its OWN vectors: before #1820 both verifiers ran on
    // 0.1's, so the canonical version was tested through its predecessor.
    const script = path.join(root, 'conformance', 'verify_bundle.py');
    const examples = path.join(root, 'examples');
    for (const file of fs.readdirSync(examples).filter((f) => f.startsWith('receipt-bundle.'))) {
      if (BUNDLE_EXPECTATIONS[file] === undefined) continue;
      const run = spawnSync(
        python.command,
        [...python.args, script, path.join(examples, file)],
        { encoding: 'utf8' },
      );
      const pythonFindings = parsePythonFindings(run.stdout || '');
      const consumerFindings = [...verifyBundle(readJson(path.join(examples, file)))].sort();
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
