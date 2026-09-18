'use strict';

const fs = require('node:fs');
const path = require('node:path');

const workflowsDir = path.join(__dirname, '..', '.github', 'workflows');
const workflowNames = fs.readdirSync(workflowsDir)
  .filter((name) => /\.ya?ml$/i.test(name))
  .sort();

const usesPattern = /^\s*(?:-\s*)?uses:\s*([^\s#]+)(?:\s+#\s*(.+))?\s*$/;
const immutableRefPattern = /^[0-9a-f]{40}$/i;
const failures = [];
let checked = 0;

for (const workflowName of workflowNames) {
  const workflowPath = path.join(workflowsDir, workflowName);
  const lines = fs.readFileSync(workflowPath, 'utf8').split(/\r?\n/);

  lines.forEach((line, index) => {
    const match = line.match(usesPattern);
    if (!match) return;

    const target = match[1];
    if (target.startsWith('./')) return;

    checked += 1;
    const at = target.lastIndexOf('@');
    const ref = at >= 0 ? target.slice(at + 1) : '';
    const annotation = match[2] ? match[2].trim() : '';

    if (!immutableRefPattern.test(ref)) {
      failures.push(`${workflowName}:${index + 1}: action is not pinned to a full 40-character commit SHA: ${target}`);
      return;
    }

    if (!annotation) {
      failures.push(`${workflowName}:${index + 1}: pinned action must include a readable version/comment annotation`);
    }
  });
}

if (failures.length > 0) {
  console.error('GitHub Action pin check failed:');
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`GitHub Action pin check passed: ${checked} external action reference(s) across ${workflowNames.length} workflow(s).`);
}
