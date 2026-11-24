'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

// The runner is spawned once per file: the doc-pin test below reads the same
// report, and a second spawn would double the cost of an already slow suite.
let cachedRun = null;
function runConformance() {
  if (cachedRun) return cachedRun;
  const result = childProcess.spawnSync(process.execPath, ['scripts/a2a-conformance/run.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || 'D6 conformance runner failed');
  cachedRun = JSON.parse(result.stdout);
  return cachedRun;
}

test('V5-D6 bounded A2A conformance is reproducible from the declared command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['conformance:a2a'], 'node scripts/a2a-conformance/run.js');
  assert.deepEqual(pkg.files.filter((file) => file.startsWith('scripts/a2a-conformance/')), [],
    'the local conformance harness must not ship as a production transport');

  const output = runConformance();
  // 54 since #1814 added the two clean-room interoperability cases. The count
  // and the digest are pinned together on purpose: the count alone would not
  // notice a case that changed its verdict, and the digest alone would not say
  // which way the suite moved.
  assert.equal(output.report.caseCount, 54);
  assert.equal(output.report.passed, 54);
  assert.equal(output.report.failed, 0);
  assert.equal(output.report.productionTransportClaimed, false);
  assert.equal(output.reportSha256, '76536d75d87e44e0fc0956110dc19d5fb56ce43772067cccd3511425f69c5c4b');
});

test('the documented A2A conformance count, digest and non-claims match the measured report', () => {
  const { report, reportSha256 } = runConformance();
  const count = `${report.caseCount}/${report.passed}`;
  const docs = {
    'docs/a2a-deployment.md': fs.readFileSync(path.join(ROOT, 'docs/a2a-deployment.md'), 'utf8'),
    'docs/current-operating-roadmap.md': fs.readFileSync(path.join(ROOT, 'docs/current-operating-roadmap.md'), 'utf8'),
  };

  for (const [name, text] of Object.entries(docs)) {
    assert.ok(text.includes(count), `${name} must report ${count}, the measured count`);
    assert.ok(text.includes(reportSha256), `${name} must carry reportSha256 ${reportSha256}`);
    assert.ok(text.includes(report.verdict), `${name} must carry verdict ${report.verdict}`);
  }

  const checkpoint = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs/current-agent-checkpoint.json'), 'utf8'));
  const evidence = checkpoint.completedEvidence.filter((entry) => entry.includes('conformance:a2a'));
  assert.equal(evidence.length, 1, 'exactly one checkpoint entry records the A2A conformance result');
  assert.ok(evidence[0].includes(count), `checkpoint entry must report ${count}`);
  assert.ok(evidence[0].includes(reportSha256), 'checkpoint entry must carry the report digest');
  assert.ok(evidence[0].includes(`productionTransportClaimed=${report.productionTransportClaimed}`),
    'the checkpoint must keep the artifact local-only claim next to the count');

  // 54/54 is a bounded-exchange result, not a transport claim, so the three
  // non-claims the artifact carries must stay visible to the operator.
  for (const nonClaim of [
    'Not externally interoperable',
    'No network discovery or routing',
    'Effect payload bytes are not exchanged',
  ]) {
    assert.ok(docs['docs/a2a-deployment.md'].includes(nonClaim),
      `docs/a2a-deployment.md must keep the non-claim "${nonClaim}"`);
  }

  // A file cannot track a live tracker, so the open-issue line must label
  // itself a snapshot instead of presenting itself as current state.
  assert.match(checkpoint.program, /snapshot/i);
  assert.match(checkpoint.program, /live GitHub/i);
});
