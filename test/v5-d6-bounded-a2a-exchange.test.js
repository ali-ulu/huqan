'use strict';

const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');

test('V5-D6 bounded A2A conformance is reproducible from the declared command', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.scripts['conformance:a2a'], 'node scripts/a2a-conformance/run.js');
  assert.deepEqual(pkg.files.filter((file) => file.startsWith('scripts/a2a-conformance/')), [],
    'the local conformance harness must not ship as a production transport');

  const result = childProcess.spawnSync(process.execPath, ['scripts/a2a-conformance/run.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, result.stderr || 'D6 conformance runner failed');
  const output = JSON.parse(result.stdout);
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
