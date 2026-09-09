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

  // #2038: the merged report has to be readable by a JUnit consumer, which
  // means well-formed first. A skipped orphan testcase used to lose its closing
  // tag, and one unclosed element makes the whole document unparseable — not
  // merely inaccurate. In the nightly shard 5 artifact that was 35 open
  // <testcase> against 6 closes.
  //
  // The repo carries no XML dependency and adding one for a single test is not
  // worth it, so this is a minimal well-formedness check: it tracks open and
  // close tags on a stack and is quote-aware, which is exactly the class of
  // defect at issue. It is not a general XML implementation.
  function assertWellFormed(xml, label) {
    const stack = [];
    for (let index = 0; index < xml.length; index += 1) {
      if (xml[index] !== '<') continue;
      if (xml.startsWith('<?', index) || xml.startsWith('<!', index)) {
        const close = xml.indexOf('>', index);
        assert.notEqual(close, -1, `${label}: unterminated declaration`);
        index = close;
        continue;
      }
      // Find this tag's own '>', ignoring any that sits inside an attribute.
      let cursor = index + 1;
      let quote = '';
      while (cursor < xml.length) {
        const character = xml[cursor];
        if (quote) {
          if (character === quote) quote = '';
        } else if (character === '"' || character === "'") {
          quote = character;
        } else if (character === '>') {
          break;
        }
        cursor += 1;
      }
      assert.ok(cursor < xml.length, `${label}: unterminated tag`);

      const tag = xml.slice(index + 1, cursor);
      index = cursor;
      if (tag.endsWith('/')) continue;
      if (tag.startsWith('/')) {
        const name = tag.slice(1).trim();
        const open = stack.pop();
        assert.equal(open, name, `${label}: </${name}> closes <${open ?? 'nothing'}>`);
        continue;
      }
      stack.push(tag.split(/[\s/>]/)[0]);
    }
    assert.deepEqual(stack, [], `${label}: unclosed elements ${stack.join(', ')}`);
  }

  test('a skipped orphan testcase keeps its closing tag and the report parses', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-junit-'));
    // Exactly the shape Node's JUnit reporter emits for a suite-less file whose
    // cases skip, e.g. test/rustGraph-workspace-isolation.test.js with no
    // huqan-core binary built. Verified against real reporter output.
    const part = writeTmp(dir, 'part-1.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
      + '\t<testcase name="skips" time="0.001" classname="test">\n'
      + '\t\t<skipped type="skipped" message="huqan-core binary not built in this environment"/>\n'
      + '\t</testcase>\n'
      + '\t<testcase name="fails" time="0.002" classname="test">\n'
      + '\t\t<failure type="testCodeFailure" message="boom">boom</failure>\n'
      + '\t</testcase>\n'
      + '\t<testcase name="passes" time="0.003" classname="test"/>\n'
      + '</testsuites>\n');

    const out = path.join(dir, 'merged.xml');
    const res = mergeJunitParts([part], ['test/skips.test.js'], out);
    assert.ok(res);

    const merged = fs.readFileSync(out, 'utf8');
    assertWellFormed(merged, 'merged report');

    // Each case survives exactly once, with its status intact.
    assert.equal(res.totalTests, 3);
    assert.equal(res.totalSkipped, 1);
    assert.equal(res.totalFailures, 1);
    assert.equal((merged.match(/<testcase\b/g) || []).length, 3);
    assert.match(merged, /tests="3"/);
    assert.match(merged, /skipped="1"/);
    assert.match(merged, /failures="1"/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // #2038, second half: a nested describe emits a nested <testsuite>, and the
  // lazy suite regex ended the outer block at the inner close, orphaning the
  // outer </testsuite>. The skipped-testcase test above stayed green through
  // this — only a full shard run surfaced it, which is why it has its own case.
  test('a nested suite does not truncate the suite that contains it', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-junit-'));
    const part = writeTmp(dir, 'part-1.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
      + '<testsuite name="outer" time="0.007" errors="0" tests="2" failures="0" skipped="0">\n'
      + '\t<testsuite name="inner" time="0.001" errors="0" tests="1" failures="0" skipped="0">\n'
      + '\t\t<testcase name="inner case" time="0.001" classname="test"/>\n'
      + '\t</testsuite>\n'
      + '\t<testcase name="outer case" time="0.006" classname="test"/>\n'
      + '</testsuite>\n'
      + '</testsuites>\n');

    const out = path.join(dir, 'merged.xml');
    const res = mergeJunitParts([part], ['test/nested.test.js'], out);
    assert.ok(res);

    const merged = fs.readFileSync(out, 'utf8');
    assertWellFormed(merged, 'merged report');
    assert.equal((merged.match(/<testsuite\b/g) || []).length, 2, 'the nested suite was dropped or duplicated');
    assert.equal((merged.match(/<\/testsuite>/g) || []).length, 2);
    assert.equal(res.totalTests, 2);
    // The inner suite's time is already part of the outer one's.
    assert.equal(Number(res.totalTime.toFixed(3)), 0.007);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // An attribute may legitimately contain '>', and test names in this repo do:
  // "learn -> review -> approve" is one. A scanner that stops at the first '>'
  // splits the tag and corrupts everything after it.
  test('a > inside a test name does not split the tag', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-junit-'));
    const part = writeTmp(dir, 'part-1.xml',
      '<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n'
      + '<testcase name="CLI executes learn -> review -> approve" time="0.07" classname="test"/>\n'
      + '<testcase name="plain" time="0.01" classname="test">\n'
      + '\t<skipped type="skipped" message="no binary"/>\n'
      + '</testcase>\n'
      + '</testsuites>\n');

    const out = path.join(dir, 'merged.xml');
    const res = mergeJunitParts([part], ['test/arrow.test.js'], out);
    const merged = fs.readFileSync(out, 'utf8');
    assertWellFormed(merged, 'merged report');
    assert.equal(res.totalTests, 2);
    assert.equal(res.totalSkipped, 1);
    assert.match(merged, /learn -&gt; review -&gt; approve|learn -> review -> approve/);
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
