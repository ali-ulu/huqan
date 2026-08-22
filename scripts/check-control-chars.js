#!/usr/bin/env node
'use strict';

/**
 * Reject raw control characters in tracked text sources (issue #1042).
 *
 * `lib/graph-edge-mutations.js` carried three raw NUL bytes as the separator
 * inside `edgeTouchKey`. The choice of NUL was right — it cannot occur in a
 * workspace id or a node name — but writing it as a raw byte rather than an
 * escape had consequences well outside that function:
 *
 *   - git classified the file as binary, so every change to it rendered as
 *     `Bin X -> Y bytes` with no line diff. A reviewer could not see what a PR
 *     changed there, and `git blame`, `git log -p`, `git add -p` and conflict
 *     resolution were all unusable on it.
 *   - grep and ripgrep reported only "binary file matches" instead of the
 *     matching lines, so every codebase-wide search silently skipped it.
 *
 * That file enforces a tenancy boundary — it is the fix for a bug that used to
 * collapse two workspaces into one key — so being outside review is exactly
 * where a regression would go unnoticed.
 *
 * The right fix was to take the bytes out of the source. This gate is what
 * stops them coming back. Adding `*.js text` to .gitattributes would force git
 * to diff the file, but it would hide the cause rather than remove it.
 *
 * Usage:  node scripts/check-control-chars.js
 * Exit 0 = clean, exit 1 = a violation.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repoRoot = path.resolve(__dirname, '..');

// Generated bundles are not hand-edited, so a finding there is not actionable
// by the person who would see it.
const EXCLUDE = /(^|\/)(node_modules|graphify-out)\/|obsidian-plugin\/dist\//;

const EXTENSIONS = ['*.js', '*.json', '*.md', '*.ts', '*.yml', '*.yaml'];

/**
 * Tab, line feed and carriage return are the control characters that belong in
 * a text file. Everything else below 0x20, plus DEL, does not.
 */
function isDisallowed(code) {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  return code < 0x20 || code === 0x7f;
}

function listTrackedTextFiles() {
  const out = execFileSync('git', ['ls-files', '--', ...EXTENSIONS], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  return out
    .split('\n')
    .map((line) => line.trim().replace(/\\/g, '/'))
    .filter(Boolean)
    .filter((file) => !EXCLUDE.test(file));
}

/**
 * Reports the 1-based line and column of every disallowed byte, so a finding
 * can be opened straight from the output rather than hunted for with `cat -v`.
 */
function findViolations(file) {
  const buffer = fs.readFileSync(path.join(repoRoot, file));
  const found = [];
  let line = 1;
  let column = 1;
  for (let i = 0; i < buffer.length; i += 1) {
    const code = buffer[i];
    if (code === 0x0a) {
      line += 1;
      column = 1;
      continue;
    }
    if (isDisallowed(code)) {
      found.push({ file, line, column, code });
    }
    column += 1;
  }
  return found;
}

function main() {
  const violations = listTrackedTextFiles().flatMap(findViolations);
  if (violations.length === 0) {
    console.log('No raw control characters in tracked text sources.');
    return 0;
  }

  console.error('Raw control characters found in tracked text sources:\n');
  for (const { file, line, column, code } of violations) {
    const hex = `0x${code.toString(16).padStart(2, '0')}`;
    console.error(`  ${file}:${line}:${column}  ${hex}`);
  }
  console.error(
    '\nA raw control byte makes git treat the file as binary: changes to it'
    + '\nrender as `Bin X -> Y bytes` with no line diff, and grep reports only'
    + '\n"binary file matches" (#1042). Write the character as an escape'
    + '\nsequence instead — `\\u0000` produces the same string.',
  );
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  EXTENSIONS,
  isDisallowed,
  listTrackedTextFiles,
  findViolations,
  main,
};
