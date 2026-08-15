'use strict';

const fs = require('node:fs');
const path = require('node:path');

const workflowDirectory = path.join(process.cwd(), '.github', 'workflows');
const files = fs.readdirSync(workflowDirectory)
  .filter((file) => /\.ya?ml$/i.test(file))
  .sort();
const failures = [];

function stripComments(source) {
  return source
    .split(/\r?\n/)
    .map((line) => line.replace(/(^|\s)#.*$/, '$1'))
    .join('\n');
}

function hasPullRequestTargetTrigger(source) {
  const clean = stripComments(source);

  if (/^\s*pull_request_target\s*:/m.test(clean)) return true;
  if (/^\s*on\s*:\s*\[[^\]]*\bpull_request_target\b[^\]]*\]/m.test(clean)) return true;
  if (/^\s*on\s*:\s*\{[^}]*\bpull_request_target\b[^}]*\}/m.test(clean)) return true;

  return false;
}

for (const file of files) {
  const fullPath = path.join(workflowDirectory, file);
  const source = fs.readFileSync(fullPath, 'utf8');
  const lines = source.split(/\r?\n/);

  if (!/^permissions:\s*$/m.test(source)) {
    failures.push(`${file}: missing explicit top-level permissions`);
  }

  if (/^\s*pull_request:\s*$/m.test(source) && !/^concurrency:\s*$/m.test(source)) {
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
}

if (failures.length > 0) {
  console.error('Workflow governance check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`Workflow governance passed for ${files.length} workflow files.`);
}
