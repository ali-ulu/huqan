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
  assert.equal(output.report.caseCount, 52);
  assert.equal(output.report.passed, 52);
  assert.equal(output.report.failed, 0);
  assert.equal(output.report.productionTransportClaimed, false);
  assert.equal(output.reportSha256, '4daca2aae640928d35bd602fa3a089aeb1ab9413bdb5feac53642dd3f7fcfd11');
});
