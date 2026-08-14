#!/usr/bin/env node
'use strict';

/**
 * Every V5 document declares what kind of document it is.
 *
 * The V5 set is 61 files describing, variously: work that shipped, work that
 * is authorized and specified, contracts, task orders, research, and
 * directions nobody has authorized at all. Read one out of context and those
 * are hard to tell apart -- a planning document written in the present tense
 * reads like a description of the product. That is the failure #295 names:
 * future ideas presented as production.
 *
 * Fourteen of the sixty-one carried a `## Status` prose section, under four
 * different spellings. Prose is what a reader needs; it is not what a check
 * can hold. So each document also declares one machine-readable status, and
 * this script fails when one does not, or when it claims a status outside the
 * vocabulary. Same shape as lib/module-reachability.js: a new document cannot
 * quietly join the pile unclassified.
 *
 * The vocabulary is drawn from what the corpus already says about itself
 * rather than imposed on it -- the documents were saying "Planning only",
 * "Draft criteria only", "**Mode:** implementation taskpack only" long before
 * this file existed.
 */

const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const DOC_ROOT = path.join('docs', 'v5');

/**
 * What a document is, in one word, and what claiming it commits you to.
 */
const STATUS_VOCABULARY = Object.freeze({
  research: 'open questions and directions being explored; commits to nothing',
  future: 'a described direction with no authorized track behind it; must not be read as built or scheduled',
  draft: 'criteria or a contract still being written; not agreed',
  spec: 'the agreed shape of work inside a gated track; describes what will be built, not what is',
  contract: 'a boundary two parts of the system are held to; binding where it applies',
  implementation: 'a task order for, or description of, code that exists',
  closeout: 'a record that a gate was measured and what the verdict was',
  archive: 'superseded; kept for history and not to be cited as current',
});

/**
 * Documents that carry no status of their own, each with the reason.
 * An index describes the set rather than belonging to it.
 */
const EXEMPT = Object.freeze({
  'docs/v5/README.md': 'directory index; it defines the vocabulary the others declare',
});

const STATUS_LINE = /^\*\*Status:\*\*\s*`([a-z]+)`\s*$/m;
// A declaration buried on line 200 is not a label a reader will see.
const DECLARATION_WINDOW_LINES = 12;

/**
 * The classes whose whole point is to be checkable against a version (#700).
 *
 * A closeout records that a gate was measured; without a commit it does not
 * say what was measured. An implementation record describes code that exists,
 * and a contract binds a boundary -- both are statements about a particular
 * state of the tree. Seven such records named no commit when this rule was
 * written, and two of them were closeouts.
 *
 * The other classes are exempt because they have nothing to pin, not because
 * the rule is inconvenient there. A `future` document describes a direction
 * nobody authorized, a `draft` is unfinished, `research` commits to nothing,
 * and a `spec` is routinely written before the work it scopes -- four of the
 * thirty-one legitimately carry no commit for exactly that reason.
 *
 * Applied going forward rather than retroactively invented: back-filling a
 * pin for a record whose history cannot establish one is how a guess ends up
 * looking like evidence, which is the failure the pin exists to prevent.
 */
const MUST_PIN_A_COMMIT = Object.freeze(['closeout', 'implementation', 'contract']);
const COMMIT_SHA = /\b[0-9a-f]{40}\b/;

function listDocs() {
  const dir = path.join(repoRoot, DOC_ROOT);
  return fs.readdirSync(dir)
    .filter(name => name.endsWith('.md'))
    .sort()
    .map(name => `${DOC_ROOT}/${name}`.split(path.sep).join('/'));
}

function readDeclaration(relPath) {
  const text = fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
  const head = text.split('\n').slice(0, DECLARATION_WINDOW_LINES).join('\n');
  const match = STATUS_LINE.exec(head);
  return match ? match[1] : null;
}

function namesACommit(relPath) {
  return COMMIT_SHA.test(fs.readFileSync(path.join(repoRoot, relPath), 'utf8'));
}

function checkDocStatus() {
  const missing = [];
  const invalid = [];
  const unpinned = [];
  const counts = new Map();

  for (const relPath of listDocs()) {
    if (Object.hasOwn(EXEMPT, relPath)) continue;
    const declared = readDeclaration(relPath);
    if (!declared) {
      missing.push(relPath);
      continue;
    }
    if (!Object.hasOwn(STATUS_VOCABULARY, declared)) {
      invalid.push({ relPath, declared });
      continue;
    }
    counts.set(declared, (counts.get(declared) || 0) + 1);
    if (MUST_PIN_A_COMMIT.includes(declared) && !namesACommit(relPath)) {
      unpinned.push({ relPath, declared });
    }
  }

  return { missing, invalid, unpinned, counts };
}

function report({ missing, invalid, unpinned }) {
  const lines = [];
  if (missing.length > 0) {
    lines.push(`${missing.length} document(s) declare no status:`);
    for (const relPath of missing) lines.push(`  ${relPath}`);
    lines.push('');
    lines.push('Add one of the following within the first '
      + `${DECLARATION_WINDOW_LINES} lines, as: **Status:** \`<status>\``);
    for (const [name, meaning] of Object.entries(STATUS_VOCABULARY)) {
      lines.push(`  ${name.padEnd(15)} ${meaning}`);
    }
  }
  if (invalid.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`${invalid.length} document(s) declare a status outside the vocabulary:`);
    for (const item of invalid) lines.push(`  ${item.relPath}: \`${item.declared}\``);
  }
  if (unpinned.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(`${unpinned.length} document(s) name no commit, so they do not say what they are about:`);
    for (const item of unpinned) lines.push(`  ${item.relPath} (\`${item.declared}\`)`);
    lines.push('');
    lines.push(`A \`${MUST_PIN_A_COMMIT.join('\`, \`')}\` record is a statement about a particular`);
    lines.push('state of the tree. Name the commit it is about, as:');
    lines.push('  **Canonical base:** `main @ <40-char sha>` — what that commit is');
    lines.push('Do not fill one in from memory: a guessed commit makes an unverifiable');
    lines.push('record look verifiable, which is what the pin exists to prevent.');
  }
  return lines.join('\n');
}

module.exports = {
  DOC_ROOT,
  EXEMPT,
  MUST_PIN_A_COMMIT,
  STATUS_VOCABULARY,
  checkDocStatus,
  listDocs,
  readDeclaration,
  report,
};

if (require.main === module) {
  const result = checkDocStatus();
  if (result.missing.length > 0 || result.invalid.length > 0 || result.unpinned.length > 0) {
    process.stderr.write(`${report(result)}\n`);
    process.exitCode = 1;
  } else {
    const summary = [...result.counts.entries()]
      .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
      .map(([name, count]) => `${count} ${name}`)
      .join(', ');
    process.stdout.write(
      `OK: every ${DOC_ROOT} document declares its status (${summary}), `
      + `and every ${MUST_PIN_A_COMMIT.join('/')} record names the commit it is about.\n`,
    );
  }
}
