#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_DOC_PATH = 'SECURITY_INVARIANTS.md';
const ID_PATTERN = /^SI-\d{2}$/;
const TEST_REF_PATTERN = /`(test\/[^`]+\.test\.js)`/g;

function parseInvariantRows(markdown) {
  return String(markdown)
    .split(/\r?\n/)
    .filter((line) => /^\|\s*SI-\d{2}\s*\|/.test(line))
    .map((line) => {
      const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
      const references = [...cells.slice(2).join('|').matchAll(TEST_REF_PATTERN)]
        .map((match) => match[1]);
      return {
        id: cells[0] || '',
        invariant: cells[1] || '',
        references,
      };
    });
}

function isSafeTestReference(reference) {
  const normalized = path.normalize(reference);
  return normalized.startsWith(`test${path.sep}`)
    && !normalized.split(path.sep).includes('..')
    && normalized.endsWith('.test.js');
}

function validateSecurityInvariants(options = {}) {
  const rootDir = path.resolve(options.rootDir || path.resolve(__dirname, '..'));
  const docPath = path.resolve(rootDir, options.docPath || DEFAULT_DOC_PATH);
  const errors = [];

  let markdown;
  try {
    markdown = fs.readFileSync(docPath, 'utf8');
  } catch (error) {
    return { rows: [], errors: [`cannot read ${path.relative(rootDir, docPath) || DEFAULT_DOC_PATH}: ${error.message}`] };
  }

  const rows = parseInvariantRows(markdown);
  if (rows.length < 5 || rows.length > 7) {
    errors.push(`expected 5-7 security invariants, found ${rows.length}`);
  }

  const ids = new Set();
  for (const row of rows) {
    if (!ID_PATTERN.test(row.id)) errors.push(`invalid invariant id: ${row.id || '<empty>'}`);
    if (ids.has(row.id)) errors.push(`duplicate invariant id: ${row.id}`);
    ids.add(row.id);

    if (!row.invariant) errors.push(`${row.id}: invariant text is empty`);
    if (row.references.length === 0) {
      errors.push(`${row.id}: no test reference`);
      continue;
    }

    for (const reference of row.references) {
      if (!isSafeTestReference(reference)) {
        errors.push(`${row.id}: unsafe or invalid test reference ${reference}`);
        continue;
      }
      const absolute = path.resolve(rootDir, reference);
      if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
        errors.push(`${row.id}: referenced test does not exist: ${reference}`);
      }
    }
  }

  return { rows, errors };
}

function main() {
  const docPath = process.argv[2] || DEFAULT_DOC_PATH;
  const result = validateSecurityInvariants({ docPath });
  if (result.errors.length > 0) {
    for (const error of result.errors) console.error(`FAIL security invariant: ${error}`);
    return 1;
  }
  const references = result.rows.reduce((total, row) => total + row.references.length, 0);
  console.log(`OK: ${result.rows.length} security invariants, ${references} test references verified.`);
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = {
  DEFAULT_DOC_PATH,
  parseInvariantRows,
  validateSecurityInvariants,
};
