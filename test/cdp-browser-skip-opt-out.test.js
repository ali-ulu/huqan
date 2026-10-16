'use strict';

/**
 * Browser smokes can be opted out per runner (#2450).
 *
 * The windows-latest CI runner renders empty panels for browser smokes that pass
 * on a local Windows machine, so benchmark.yml sets HUQAN_SKIP_BROWSER_SMOKE there
 * and stops requiring the smokes. Every browser smoke asks the same helper whether
 * to skip, so the opt-out lives in browserSmokeSkipReason and nowhere else.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { browserSmokeSkipReason } = require('./helpers/cdp-browser');

function withOptOut(t, value) {
  const previous = process.env.HUQAN_SKIP_BROWSER_SMOKE;
  if (value === undefined) delete process.env.HUQAN_SKIP_BROWSER_SMOKE;
  else process.env.HUQAN_SKIP_BROWSER_SMOKE = value;
  t.after(() => {
    if (previous === undefined) delete process.env.HUQAN_SKIP_BROWSER_SMOKE;
    else process.env.HUQAN_SKIP_BROWSER_SMOKE = previous;
  });
}

test('a set HUQAN_SKIP_BROWSER_SMOKE skips and carries its reason', (t) => {
  withOptOut(t, 'not required on the windows-latest runner (#2450)');
  assert.equal(
    browserSmokeSkipReason(),
    'browser smoke skipped by HUQAN_SKIP_BROWSER_SMOKE: not required on the windows-latest runner (#2450)',
  );
});

test('an empty, blank or "0" HUQAN_SKIP_BROWSER_SMOKE does not opt out', (t) => {
  for (const value of [undefined, '', '   ', '0']) {
    withOptOut(t, value);
    const reason = browserSmokeSkipReason();
    assert.ok(reason === null || !reason.includes('HUQAN_SKIP_BROWSER_SMOKE'),
      `value ${JSON.stringify(value)} must not opt out, got ${JSON.stringify(reason)}`);
  }
});

test('benchmark.yml opts out on windows-latest only and keeps other runners required', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml'), 'utf8');
  assert.match(workflow, /HUQAN_REQUIRE_BROWSER_SMOKE: \$\{\{ matrix\.os == 'windows-latest' && '0' \|\| '1' \}\}/);
  assert.match(workflow, /HUQAN_SKIP_BROWSER_SMOKE: \$\{\{ matrix\.os == 'windows-latest' && '[^']+' \|\| '' \}\}/);
});
