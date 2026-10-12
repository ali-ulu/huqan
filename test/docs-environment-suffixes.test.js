'use strict';

// The migration doc's "Supported suffixes" block drifted behind the runtime
// inventory (#3855: 37 documented versus 67 supported), so the doc now pins
// itself to the source: this test fails when the two lists diverge again.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { ENVIRONMENT_SUFFIXES } = require('../lib/environment-compat');

const MIGRATION_DOC = path.join(__dirname, '..', 'docs', 'environment-variable-migration.md');

function documentedSuffixes() {
  const markdown = fs.readFileSync(MIGRATION_DOC, 'utf8');
  const heading = markdown.indexOf('## Supported suffixes');
  assert.notEqual(heading, -1, 'the migration doc must keep its Supported suffixes section');
  const blockStart = markdown.indexOf('```text', heading);
  const blockEnd = markdown.indexOf('```', blockStart + '```text'.length);
  assert.ok(blockStart !== -1 && blockEnd !== -1, 'the suffix list must stay a fenced text block');
  return markdown
    .slice(blockStart + '```text'.length, blockEnd)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
}

test('migration doc lists every supported environment suffix exactly once', () => {
  const documented = documentedSuffixes();
  const supported = [...new Set(ENVIRONMENT_SUFFIXES)].sort();
  assert.deepEqual([...documented].sort(), supported);
  assert.equal(new Set(documented).size, documented.length, 'the documented list must not repeat a suffix');
});
