'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { mergeJunitParts } = require('../scripts/run-test-shard');

function writeTmp(dir, name, content) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('run-test-shard mergeJunitParts (#1973)', () => {
  test('suite-less file results are wrapped, not dropped', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-junit-'));
    const suitePart = writeTmp(dir, 'part-1.xml',
      '<?xml version="1.0"?>\n<testsuites>\n<testsuite name="a" tests="1" failures="0" errors="0" skipped="0" time="0.1"><testcase name="ok" classname="a"/></testsuite>\n</testsuites>\n');
    // Suite-less: testcases directly under <testsuites>, one failing.
    const lessPart = writeTmp(dir, 'part-2.xml',
      '<?xml version="1.0"?>\n<testsuites tests="2" failures="1">\n<testcase name="t1" classname="b"/>\n<testcase name="t2" classname="b"><failure message="boom">boom</failure></testcase>\n</testsuites>\n');
    const out = path.join(dir, 'merged.xml');
    const res = mergeJunitParts([suitePart, lessPart], ['test/a.test.js', 'test/b.test.js'], out);
    assert.ok(res);
    assert.equal(res.totalTests, 3);
    assert.equal(res.totalFailures, 1);
    const merged = fs.readFileSync(out, 'utf8');
    assert.match(merged, /test\/b\.test\.js/);
    assert.match(merged, /tests="3"/);
    assert.match(merged, /failures="1"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('totals derive from testcases, not suite attributes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-junit-'));
    // Lying suite attributes: claims 10 tests, actually contains 1.
    const lying = writeTmp(dir, 'part-1.xml',
      '<?xml version="1.0"?>\n<testsuites>\n<testsuite name="x" tests="10" failures="0" errors="0" skipped="0" time="0.2"><testcase name="only" classname="x"/></testsuite>\n</testsuites>\n');
    const out = path.join(dir, 'merged.xml');
    const res = mergeJunitParts([lying], ['test/x.test.js'], out);
    assert.equal(res.totalTests, 1);
    const merged = fs.readFileSync(out, 'utf8');
    assert.match(merged, /tests="1"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
