'use strict';

const fs = require('node:fs');
const path = require('node:path');

// #1312: the previous implementation stripped `# ...` with a plain regex
// that had no idea it was inside a quoted string, so `run: echo "hello #
// world"` lost everything from the `#` on -- a `#` preceded by whitespace
// inside a single- or double-quoted string is not a YAML comment. Track
// quote state per line and only treat `#` as a comment start when it is
// outside both quote kinds.
function stripLineComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble) {
      const prev = i === 0 ? '' : line[i - 1];
      if (i === 0 || /\s/.test(prev)) return line.slice(0, i);
    }
  }
  return line;
}

function stripComments(source) {
  return source
    .split(/\r?\n/)
    .map(stripLineComment)
    .join('\n');
}

function hasPullRequestTargetTrigger(source) {
  const clean = stripComments(source);

  if (/^\s*pull_request_target\s*:/m.test(clean)) return true;
  if (/^\s*on\s*:\s*\[[^\]]*\bpull_request_target\b[^\]]*\]/m.test(clean)) return true;
  if (/^\s*on\s*:\s*\{[^}]*\bpull_request_target\b[^}]*\}/m.test(clean)) return true;

  return false;
}

function checkSource(file, source) {
  const failures = [];
  const lines = source.split(/\r?\n/);

  // #1312: tolerate a trailing inline comment on these lines (e.g.
  // `permissions: # inherited`) instead of requiring the line to be exactly
  // `permissions:` with nothing else.
  if (!/^permissions:\s*(#.*)?$/m.test(source)) {
    failures.push(`${file}: missing explicit top-level permissions`);
  }

  if (/^\s*pull_request:\s*$/m.test(source) && !/^concurrency:\s*(#.*)?$/m.test(source)) {
    failures.push(`${file}: pull_request workflow must define concurrency`);
  }

  if (hasPullRequestTargetTrigger(source)) {
    failures.push(`${file}: pull_request_target is not allowed in repository workflows`);
  }

  lines.forEach((line, index) => {
    if (/^\s*#/.test(line)) return;
    const match = line.match(/^\s*uses:\s*([^\s#]+)/);
    if (!match || match[1].startsWith('./')) return;
    const reference = match[1];
    const at = reference.lastIndexOf('@');
    const sha = at === -1 ? '' : reference.slice(at + 1);
    if (!/^[0-9a-f]{40}$/.test(sha)) {
      failures.push(`${file}:${index + 1}: action must be pinned to a 40-character commit SHA (${reference})`);
    }
  });

  return failures;
}

function main() {
  const workflowDirectory = path.join(process.cwd(), '.github', 'workflows');
  const files = fs.readdirSync(workflowDirectory)
    .filter((file) => /\.ya?ml$/i.test(file))
    .sort();
  const failures = [];

  for (const file of files) {
    const fullPath = path.join(workflowDirectory, file);
    const source = fs.readFileSync(fullPath, 'utf8');
    failures.push(...checkSource(file, source));
  }

  if (failures.length > 0) {
    console.error('Workflow governance check failed:');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Workflow governance passed for ${files.length} workflow files.`);
  }
}

if (require.main === module) {
  main();
}

module.exports = { stripComments, stripLineComment, hasPullRequestTargetTrigger, checkSource };
