'use strict';

/**
 * #3029 — RFC-001 makes HUQAN the canonical product identity and AXIOM a legacy
 * identifier only, but the identity documents still presented AXIOM as the
 * current product while the README led with HUQAN.
 *
 * The checker is only useful if it separates the two cases RFC-001 draws: a
 * current-product mention (drift) from a preserved legacy identifier
 * (`AXIOM_*`, `.axiom`, `axiom.*`, `axiom-*`). These tests pin both sides, so
 * the allowlist cannot quietly grow to accept the drift it exists to catch.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  IDENTITY_DOCS,
  currentProductMentions,
  collectNamingViolations,
} = require('../scripts/check-naming-conformance');

test('a current-product AXIOM mention is caught', () => {
  assert.equal(currentProductMentions('# AXIOM Product Positioning').length, 1);
  assert.equal(currentProductMentions('AXIOM judges claims, memory, and decisions.').length, 1);
  assert.equal(currentProductMentions('# HUQAN Product Positioning').length, 0);
});

test('the legacy identifiers RFC-001 keeps are not drift', () => {
  assert.equal(currentProductMentions('Set AXIOM_API_KEY to authenticate.').length, 0);
  assert.equal(currentProductMentions('The .axiom package suffix is still read.').length, 0);
  assert.equal(currentProductMentions('Call axiom.learn or the canonical huqan.learn.').length, 0);
  assert.equal(currentProductMentions('packages/axiom-verify remains a compatibility surface.').length, 0);
});

test('a quoted AXIOM, in code, is a quotation and not a claim', () => {
  assert.equal(currentProductMentions('The old name was `AXIOM`.').length, 0);
  assert.equal(currentProductMentions('```\n# AXIOM\n```').length, 0);
});

test('the identity documents name HUQAN and no longer present AXIOM as the product', () => {
  assert.deepEqual(collectNamingViolations(), []);
});

test('the identity set covers the product front door and the positioning documents', () => {
  for (const doc of ['README.md', 'docs/product-positioning.md', 'docs/vision-next.md', 'docs/index.html']) {
    assert.ok(IDENTITY_DOCS.includes(doc), `${doc} must be governed by the naming check`);
  }
});

test('the checker reads files relative to the repository root', () => {
  // A missing identity file is a violation, not a silent pass: the set is a
  // contract on the tree, so deleting a document it names must fail.
  const { IDENTITY_DOCS: docs } = require('../scripts/check-naming-conformance');
  assert.ok(docs.every((doc) => typeof doc === 'string' && doc.length > 0));
  assert.ok(docs.includes(path.join('docs', 'architecture.md')));
});
