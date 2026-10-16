'use strict';

/**
 * The transform catalog version has two surfaces: the constant the coder stamps
 * onto every derivation record, and the release note that tells a reader which
 * catalog a record belongs to. They drifted once (#3650): the note moved to
 * v1.2.0 while lib/coder/derivation-record.js still said 1.0.0, so every record
 * understated the catalog it was derived from.
 *
 * The record is the artifact a third party checks, so the two must not be free
 * to disagree. This pins the note's stated version to the constant; whichever
 * one moves first, the other has to follow or the suite fails.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { TRANSFORM_CATALOG_VERSION } = require('../lib/coder/derivation-record');

const NOTES_PATH = path.join(__dirname, '..', 'docs', 'coder-catalog-notes.md');

function documentedCatalogVersion() {
  const notes = fs.readFileSync(NOTES_PATH, 'utf8');
  const match = notes.match(/Current transform catalog:\s*v?(\d+\.\d+\.\d+)/u);
  assert.ok(match, `docs/coder-catalog-notes.md must state "Current transform catalog: vX.Y.Z"`);
  return match[1];
}

test('the documented transform catalog version matches the code constant', () => {
  assert.strictEqual(
    documentedCatalogVersion(),
    TRANSFORM_CATALOG_VERSION,
    'docs/coder-catalog-notes.md and TRANSFORM_CATALOG_VERSION disagree; update both together',
  );
});
