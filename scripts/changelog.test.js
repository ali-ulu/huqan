'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const test = require('node:test');

const {
  classify,
  groupCommits,
  insertUnderUnreleased,
  parseRecord,
  refsIn,
  renderEntry,
} = require('./changelog');

const repoRoot = path.join(__dirname, '..');

const commit = (subject, body = '') => ({ hash: 'a'.repeat(40), subject, body });

test('classify maps each conventional type to its section', () => {
  const cases = [
    ['feat(cli): add doctor command', 'Added'],
    ['fix(guard): stop the double write', 'Fixed'],
    ['security(deps): pin the action', 'Security'],
    ['deprecate(api): retire the v1 route', 'Deprecated'],
    ['chore(ci): bump the runner image', 'Internal'],
    ['refactor(kernel): split the facade', 'Internal'],
    ['test(verify): cover the timed-out stage', 'Internal'],
    ['docs(readme): fix the quickstart', 'Internal'],
  ];
  for (const [subject, expected] of cases) {
    assert.equal(classify(commit(subject)).section, expected, subject);
  }
});

test('classify treats a breaking marker as its own section', () => {
  assert.equal(classify(commit('feat(api)!: drop the v1 route')).section, 'Breaking Changes');
  assert.equal(classify(commit('fix(gate)!: fail closed again')).section, 'Breaking Changes');
  assert.equal(
    classify(commit('feat(api): reshape the payload', 'BREAKING CHANGE: callers must send an object')).section,
    'Breaking Changes',
  );
});

test('classify keeps a non-conventional subject instead of dropping it', () => {
  const entry = classify(commit('Merge branch main into the spike'));
  assert.equal(entry.section, 'Other');
  assert.equal(entry.description, 'Merge branch main into the spike');
  assert.equal(entry.type, null);
});

test('classify strips the trailing reference list and records it as links', () => {
  const entry = classify(commit('feat(2650): generate the changelog (#2699, #2701)'));
  assert.equal(entry.section, 'Added');
  assert.equal(entry.scope, '2650');
  assert.equal(entry.description, 'generate the changelog');
  assert.deepEqual(entry.refs, ['2699', '2701']);
});

test('refsIn de-duplicates and preserves order', () => {
  assert.deepEqual(refsIn('a #3 then #1 then #3 again'), ['3', '1']);
  assert.deepEqual(refsIn('no references here'), []);
});

test('parseRecord splits the git log record on the field separator', () => {
  const record = `deadbeef\x1ffeat(x): a thing (#12)\x1fa body line\nBREAKING CHANGE: nope\x1e`;
  const parsed = parseRecord(record);
  assert.equal(parsed.hash, 'deadbeef');
  assert.equal(parsed.subject, 'feat(x): a thing (#12)');
  assert.match(parsed.body, /BREAKING CHANGE: nope/);
  assert.equal(parseRecord('   '), null);
});

test('groupCommits buckets by section, oldest first inside a bucket', () => {
  const groups = groupCommits([
    commit('feat(third): newest'),
    commit('fix(first): oldest'),
    commit('feat(second): middle'),
  ]);
  assert.deepEqual([...groups.keys()].sort(), ['Added', 'Fixed']);
  assert.deepEqual(
    groups.get('Added').map((entry) => entry.description),
    ['middle', 'newest'],
  );
});

test('renderEntry emits sections in order and skips empty ones', () => {
  const groups = groupCommits([
    commit('fix(x): a fix (#7)'),
    commit('feat(x): a feature'),
    commit('not conventional at all'),
  ]);
  const rendered = renderEntry(groups, { repoUrl: 'https://github.com/ali-ulu/huqan' });

  assert.match(rendered, /### Added\n- \*\*x:\*\* a feature/);
  assert.match(rendered, /### Fixed\n- \*\*x:\*\* a fix \(\[#7\]\(https:\/\/github\.com\/ali-ulu\/huqan\/issues\/7\)\)/);
  assert.match(rendered, /### Other\n- not conventional at all/);
  assert.doesNotMatch(rendered, /### Security/);
  assert.ok(rendered.indexOf('### Added') < rendered.indexOf('### Fixed'), 'Added comes before Fixed');
  assert.ok(rendered.indexOf('### Fixed') < rendered.indexOf('### Other'), 'Other comes last');
  assert.equal(rendered.endsWith('\n'), false, 'no trailing newline');
});

test('insertUnderUnreleased puts the entry under the existing Unreleased heading', () => {
  const existing = '# Changelog\n\n## Unreleased\n\n## v0.12.0\n\nReleased 2026-09-08.\n';
  const updated = insertUnderUnreleased(existing, '### Added\n- a thing');

  assert.match(updated, /# Changelog\n\n## Unreleased\n\n### Added\n- a thing\n\n## v0\.12\.0/);
  assert.match(updated, /Released 2026-09-08\./, 'the existing release text survives');
  assert.ok(updated.indexOf('## Unreleased') < updated.indexOf('## v0.12.0'));
});

test('insertUnderUnreleased adds the heading when the file lacks it', () => {
  const updated = insertUnderUnreleased('# Changelog\n\n## v0.12.0\n', '### Added\n- a thing');
  assert.match(updated, /# Changelog\n\n## Unreleased\n\n### Added\n- a thing\n\n## v0\.12\.0/);
});

test('insertUnderUnreleased creates a changelog from nothing', () => {
  assert.equal(insertUnderUnreleased('', '### Added\n- a thing'), '# Changelog\n\n## Unreleased\n\n### Added\n- a thing\n');
});

test('insertUnderUnreleased normalizes CRLF so the diff stays a diff', () => {
  const updated = insertUnderUnreleased('# Changelog\r\n\r\n## Unreleased\r\n', '### Fixed\n- a fix');
  assert.doesNotMatch(updated, /\r/);
});

test('renderEntry omits the reference parenthesis when a commit names none', () => {
  const rendered = renderEntry(groupCommits([commit('chore: tidy the workflow')]), { repoUrl: 'https://x' });
  assert.equal(rendered, '### Internal\n- tidy the workflow');
});
test('the cli previews an entry from the repository history', () => {
  const result = spawnSync(process.execPath, ['scripts/changelog.js', '--since-tag=v0.12.0'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, `changelog preview failed\nstderr:\n${result.stderr}`);
  assert.match(result.stdout, /^## Unreleased \(since v0\.12\.0\)/);
  assert.match(result.stdout, /^### /m, 'the preview has at least one section');
});

test('the cli defaults to a preview and leaves CHANGELOG.md untouched', () => {
  const before = require('node:fs').readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  const result = spawnSync(process.execPath, ['scripts/changelog.js'], { cwd: repoRoot, encoding: 'utf8' });

  assert.equal(result.status, 0, `changelog preview failed\nstderr:\n${result.stderr}`);
  const after = require('node:fs').readFileSync(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
  assert.equal(after, before, 'a preview must not write the file');
});

test('classify strips a long comma-separated reference list', () => {
  const refs = Array.from({ length: 40 }, (_, i) => `#${i + 1}`).join(', ');
  const entry = classify(commit(`feat(x): a thing (${refs})`));

  assert.equal(entry.description, 'a thing');
  assert.equal(entry.refs.length, 40);
  assert.equal(entry.refs[0], '1');
  assert.equal(entry.refs[39], '40');
});

test('classify leaves a parenthesised non-reference alone', () => {
  const entry = classify(commit('feat(x): keep (this) text'));
  assert.equal(entry.description, 'keep (this) text');
  assert.deepEqual(entry.refs, []);
});



