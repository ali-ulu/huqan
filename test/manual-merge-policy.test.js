'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workflow = fs.readFileSync(
  path.join(__dirname, '..', '.github', 'workflows', 'benchmark.yml'),
  'utf8',
);

test('benchmark workflow observes auto-merge state changes', () => {
  assert.match(workflow, /auto_merge_enabled/);
  assert.match(workflow, /auto_merge_disabled/);
});

test('required npm test gate blocks pull requests with auto-merge enabled', () => {
  assert.match(workflow, /AUTO_MERGE_ENABLED:/);
  assert.match(
    workflow,
    /Auto-merge is forbidden by repository policy; pull requests must be merged manually\./,
  );
  assert.match(
    workflow,
    /\[ "\$\{AUTO_MERGE_ENABLED\}" = "true" \]/,
  );
});
