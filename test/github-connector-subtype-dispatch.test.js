'use strict';

// #2180 (#2123): buildSourceRef and buildClaimText in lib/github-connector.js each
// dispatched on sourceSubType through a switch, so a new GitHub source type meant a
// new case in two places. This pins what every subtype produces -- with its fields
// present and with them missing -- through the public normalizeGitHubItem, so the
// move to one registry can be checked against it.

const test = require('node:test');
const assert = require('node:assert/strict');

const { GITHUB_SOURCE_TYPES, normalizeGitHubItem } = require('../lib/github-connector');

const REPO = 'owner/repo';

const FULL = { number: 42, sha: 'abc123', tag: 'v1.2.3', title: 'Some Title' };
const EMPTY = { title: '' };

const EXPECTED = [
  [GITHUB_SOURCE_TYPES.merged_pr, FULL, 'github://owner/repo/pull/42', 'PR 42 merged in owner/repo: Some Title'],
  [GITHUB_SOURCE_TYPES.merged_pr, EMPTY, 'github://owner/repo/pull/0', 'PR ? merged in owner/repo: Untitled'],
  [GITHUB_SOURCE_TYPES.open_pr, FULL, 'github://owner/repo/pull/42', 'PR 42 opened in owner/repo: Some Title'],
  [GITHUB_SOURCE_TYPES.open_pr, EMPTY, 'github://owner/repo/pull/0', 'PR ? opened in owner/repo: Untitled'],
  [GITHUB_SOURCE_TYPES.closed_issue, FULL, 'github://owner/repo/issues/42', 'Issue 42 closed in owner/repo: Some Title'],
  [GITHUB_SOURCE_TYPES.closed_issue, EMPTY, 'github://owner/repo/issues/0', 'Issue ? closed in owner/repo: Untitled'],
  [GITHUB_SOURCE_TYPES.open_issue, FULL, 'github://owner/repo/issues/42', 'Issue 42 opened in owner/repo: Some Title'],
  [GITHUB_SOURCE_TYPES.open_issue, EMPTY, 'github://owner/repo/issues/0', 'Issue ? opened in owner/repo: Untitled'],
  [GITHUB_SOURCE_TYPES.release_tag, FULL, 'github://owner/repo/releases/tag/v1.2.3', 'Release v1.2.3 published in owner/repo: Some Title'],
  [GITHUB_SOURCE_TYPES.release_tag, EMPTY, 'github://owner/repo/releases/tag/unknown', 'Release ? published in owner/repo: Untitled'],
  [GITHUB_SOURCE_TYPES.commit_message, FULL, 'github://owner/repo/commit/abc123', 'Commit abc123 in owner/repo: Some Title'],
  [GITHUB_SOURCE_TYPES.commit_message, EMPTY, 'github://owner/repo/commit/unknown', 'Commit ? in owner/repo: Untitled'],
  // Not a known type: the default branch, whose sourceRef token falls back
  // number -> sha -> tag -> slugged title -> 'item'.
  ['mystery_type', FULL, 'github://owner/repo/items/mystery_type/42', 'mystery_type item in owner/repo: Some Title'],
  ['mystery_type', { sha: 'abc123', title: 'T' }, 'github://owner/repo/items/mystery_type/abc123', 'mystery_type item in owner/repo: T'],
  ['mystery_type', { tag: 'v9', title: 'T' }, 'github://owner/repo/items/mystery_type/v9', 'mystery_type item in owner/repo: T'],
  ['mystery_type', { title: 'Two Words Here' }, 'github://owner/repo/items/mystery_type/two-words-here', 'mystery_type item in owner/repo: Two Words Here'],
  ['mystery_type', EMPTY, 'github://owner/repo/items/mystery_type/item', 'mystery_type item in owner/repo: Untitled'],
  // A subtype named after an Object.prototype member is still an unknown type.
  ['constructor', { number: 7, title: 'T' }, 'github://owner/repo/items/constructor/7', 'constructor item in owner/repo: T'],
  // The subtype is matched case-insensitively.
  ['MERGED_PR', FULL, 'github://owner/repo/pull/42', 'PR 42 merged in owner/repo: Some Title'],
];

test('every GitHub source subtype produces its sourceRef and claim (#2180)', () => {
  for (const [sourceSubType, fields, sourceRef, claim] of EXPECTED) {
    const item = normalizeGitHubItem({ repo: REPO, sourceSubType, ...fields });
    const label = `${sourceSubType} ${JSON.stringify(fields)}`;
    assert.equal(item.sourceRef, sourceRef, `sourceRef for ${label}`);
    assert.equal(item.claim, claim, `claim for ${label}`);
  }
});

test('the table covers every known subtype (#2180)', () => {
  const covered = new Set(EXPECTED.map(([subtype]) => subtype));
  for (const subtype of Object.values(GITHUB_SOURCE_TYPES)) {
    assert.ok(covered.has(subtype), `${subtype} has no expectation`);
  }
});
