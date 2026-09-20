#!/usr/bin/env node
'use strict';

/**
 * Generate CHANGELOG entries from conventional commits (issue #2650, task M5).
 *
 * The changelog was hand-written, so it held whichever releases somebody
 * remembered to describe -- v0.12.0's own header says so, listing only "the
 * entries recorded as they landed". This derives the sections of a release
 * entry from the commits themselves, which already follow `type(scope):
 * message` almost everywhere, so the record stops depending on memory.
 *
 * Scope. This is a generator, not a gate. `--write` prepends to CHANGELOG.md;
 * nothing in `verify` reads the file back, so a stale changelog never blocks a
 * push. Classification drops nothing: a subject that does not parse as
 * conventional goes under "Other" rather than being lost, because silently
 * losing a change is worse than filing one under a vague heading.
 *
 * Usage:
 *   node scripts/changelog.js                  # preview the entry on stdout
 *   node scripts/changelog.js --write          # prepend it to CHANGELOG.md
 *   node scripts/changelog.js --since-tag=v0.12.0
 */

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const CHANGELOG_PATH = path.join(repoRoot, 'CHANGELOG.md');

// Conventional commit type -> the changelog section it belongs to. The four
// types the plan names explicitly (feat, fix, security, deprecate) map to
// their own sections; the housekeeping types are grouped under Internal so
// they stay visible without competing with user-visible changes.
const SECTION_BY_TYPE = Object.freeze({
  feat: 'Added',
  fix: 'Fixed',
  security: 'Security',
  deprecate: 'Deprecated',
  chore: 'Internal',
  refactor: 'Internal',
  style: 'Internal',
  test: 'Internal',
  docs: 'Internal',
  ci: 'Internal',
  build: 'Internal',
  perf: 'Internal',
  revert: 'Internal',
});

// Order the sections appear in. "Other" is last on purpose: it is the escape
// hatch for unparsed subjects and should be the least prominent thing there.
const SECTION_ORDER = Object.freeze([
  'Breaking Changes',
  'Added',
  'Fixed',
  'Security',
  'Deprecated',
  'Internal',
  'Other',
]);

const CONVENTIONAL_SUBJECT = /^([a-z]+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/;
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE:/m;
// The trailing "(#123, #124)" GitHub writes onto a squashed subject. The
// repetition is anchored by a literal comma instead of written as
// `(?:\s*#\d+\s*,?)+`: that shape let one run of whitespace be consumed by two
// adjacent quantifiers, which CodeQL reports as exponential backtracking
// (js/polynomial-redos on this file).
const TRAILING_REF_LIST = /\s*\(#\d+(?:\s*,\s*#\d+)*\)\s*$/;
/**
 * Every `#123` reference in a string, de-duplicated, in first-seen order.
 *
 * @param {string} text
 * @returns {string[]}
 */
function refsIn(text) {
  const refs = [];
  for (const match of String(text).matchAll(/#(\d+)/g)) {
    if (!refs.includes(match[1])) refs.push(match[1]);
  }
  return refs;
}

/**
 * Split one `git log --format=%H%x1f%s%x1f%b%x1e` record into fields.
 *
 * @param {string} record
 * @returns {{hash: string, subject: string, body: string}|null}
 */
function parseRecord(record) {
  const trimmed = String(record).trim();
  if (!trimmed) return null;
  const [hash, subject, body = ''] = trimmed.split('\x1f');
  if (!hash || !subject) return null;
  return { hash: hash.trim(), subject: subject.trim(), body: body.trim() };
}

/**
 * Decide which section a commit belongs to, and what text to print for it.
 *
 * A breaking change is a section of its own, so `feat!:` and a
 * `BREAKING CHANGE:` footer both win over the commit's own type -- the reader
 * deciding whether an upgrade is safe looks for that heading first.
 *
 * @param {{hash: string, subject: string, body: string}} commit
 * @returns {{section: string, type: string|null, scope: string|null, description: string, refs: string[], hash: string}}
 */
function classify(commit) {
  const subject = commit.subject || '';
  const refs = refsIn(subject);
  const match = CONVENTIONAL_SUBJECT.exec(subject);

  if (!match) {
    return { section: 'Other', type: null, scope: null, description: subject, refs, hash: commit.hash };
  }

  const [, type, scope, bang, rest] = match;
  const breaking = Boolean(bang) || BREAKING_FOOTER.test(commit.body || '');
  return {
    section: breaking ? 'Breaking Changes' : (SECTION_BY_TYPE[type] || 'Other'),
    type,
    scope: scope || null,
    description: rest.replace(TRAILING_REF_LIST, '').trim(),
    refs,
    hash: commit.hash,
  };
}

/**
 * Bucket classified commits by section, oldest commit first inside a bucket so
 * the entry reads in the order the work landed.
 *
 * @param {Array<{hash: string, subject: string, body: string}>} commits
 * @returns {Map<string, Array<ReturnType<typeof classify>>>}
 */
function groupCommits(commits) {
  const groups = new Map();
  for (const commit of commits) {
    const entry = classify(commit);
    if (!groups.has(entry.section)) groups.set(entry.section, []);
    groups.get(entry.section).push(entry);
  }
  for (const items of groups.values()) items.reverse();
  return groups;
}

function formatItem(entry, repoUrl) {
  const scope = entry.scope ? `**${entry.scope}:** ` : '';
  const links = entry.refs.map((ref) => `[#${ref}](${repoUrl}/issues/${ref})`).join(', ');
  const suffix = links ? ` (${links})` : '';
  return `- ${scope}${entry.description}${suffix}`;
}

/**
 * Render the classified groups as the body of a changelog entry. Sections with
 * nothing in them are omitted rather than printed empty.
 *
 * @param {Map<string, Array<ReturnType<typeof classify>>>} groups
 * @param {{repoUrl?: string}} [opts]
 * @returns {string} markdown, no trailing newline
 */
function renderEntry(groups, opts = {}) {
  const repoUrl = String(opts.repoUrl || '').replace(/\/+$/, '');
  const lines = [];
  for (const section of SECTION_ORDER) {
    const items = groups.get(section);
    if (!items || items.length === 0) continue;
    lines.push(`### ${section}`);
    for (const entry of items) lines.push(formatItem(entry, repoUrl));
    lines.push('');
  }
  while (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.join('\n');
}

/**
 * Put a rendered entry into the changelog, under `## Unreleased` when that
 * heading exists. The surrounding document is preserved verbatim apart from
 * the blank lines immediately around the insertion point -- this rewrites no
 * line it did not have to.
 *
 * @param {string} existing current CHANGELOG.md contents
 * @param {string} block rendered entry
 * @returns {string}
 */
function insertUnderUnreleased(existing, block) {
  const normalized = String(existing).replace(/\r\n/g, '\n');
  const unreleased = /^## Unreleased[ \t]*$/m.exec(normalized);
  if (unreleased) {
    const head = normalized.slice(0, unreleased.index + unreleased[0].length);
    const tail = normalized.slice(unreleased.index + unreleased[0].length).replace(/^\n+/, '');
    return `${head}\n\n${block}\n\n${tail}`;
  }
  const title = /^# Changelog[ \t]*$/m.exec(normalized);
  if (title) {
    const head = normalized.slice(0, title.index + title[0].length);
    const tail = normalized.slice(title.index + title[0].length).replace(/^\n+/, '');
    return `${head}\n\n## Unreleased\n\n${block}\n\n${tail}`;
  }
  return `# Changelog\n\n## Unreleased\n\n${block}\n`;
}

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' });
}

/** The most recent release tag, or null when the repository has none. */
function lastTag() {
  try {
    return git(['describe', '--tags', '--abbrev=0']).trim() || null;
  } catch {
    return null;
  }
}

/** `owner/repo` origin as a browsable https URL, or '' when it is not GitHub. */
function originUrl() {
  try {
    const url = git(['remote', 'get-url', 'origin']).trim();
    const match = /github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(url);
    return match ? `https://github.com/${match[1]}/${match[2]}` : '';
  } catch {
    return '';
  }
}

/** Commits since `tag` (or the whole history), newest first, merge commits out. */
function commitsSince(tag) {
  const range = tag ? `${tag}..HEAD` : 'HEAD';
  const raw = git(['log', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', range]);
  return raw.split('\x1e').map(parseRecord).filter(Boolean);
}

function main(argv = process.argv.slice(2)) {
  const write = argv.includes('--write');
  const sinceArg = argv.find((arg) => arg.startsWith('--since-tag='));
  const tag = sinceArg ? sinceArg.slice('--since-tag='.length) : lastTag();
  const commits = commitsSince(tag);
  const block = renderEntry(groupCommits(commits), { repoUrl: originUrl() });

  if (!block) {
    process.stdout.write(`changelog: no conventional commits since ${tag || 'the beginning'}\n`);
    return 0;
  }

  if (!write) {
    const heading = tag ? `## Unreleased (since ${tag})` : '## Unreleased';
    process.stdout.write(`${heading}\n\n${block}\n`);
    return 0;
  }

  const existing = fs.readFileSync(CHANGELOG_PATH, 'utf8');
  fs.writeFileSync(CHANGELOG_PATH, insertUnderUnreleased(existing, block));
  process.stdout.write(
    `changelog: prepended ${commits.length} commit(s) since ${tag || 'the beginning'} to CHANGELOG.md\n`,
  );
  return 0;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  CHANGELOG_PATH,
  SECTION_BY_TYPE,
  SECTION_ORDER,
  classify,
  commitsSince,
  groupCommits,
  insertUnderUnreleased,
  lastTag,
  main,
  originUrl,
  parseRecord,
  refsIn,
  renderEntry,
};


