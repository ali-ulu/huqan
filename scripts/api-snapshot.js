#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildSnapshot, stableStringify } = require('./api-snapshot-surface');
const { diffSnapshots, reportMarkdown } = require('./api-snapshot-diff');

function readJson(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  fs.writeFileSync(path.resolve(file), `${stableStringify(value)}\n`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith('--')) {
      args[key] = next;
      index += 1;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const snapshot = args.snapshot ? readJson(args.snapshot) : buildSnapshot();

  if (args.write) writeJson(args.write, snapshot);

  if (args['check-baseline']) {
    const baseline = readJson(args['check-baseline']);
    if (stableStringify(baseline, 0) !== stableStringify(snapshot, 0)) {
      console.error('API snapshot baseline is stale. Regenerate api-snapshot-baseline.json.');
      process.exitCode = 1;
    } else {
      console.log('API snapshot baseline is current.');
    }
  }

  if (args.compare) {
    const result = diffSnapshots(readJson(args.compare), snapshot);
    const report = reportMarkdown(result);
    if (args.report) fs.writeFileSync(path.resolve(args.report), report);
    process.stdout.write(report);
    if (result.breaking.length > 0) process.exitCode = 1;
  }

  if (args['bootstrap-report']) {
    const report = reportMarkdown({ breaking: [], added: [] }, { bootstrap: true });
    if (args.report) fs.writeFileSync(path.resolve(args.report), report);
    process.stdout.write(report);
  }

  if (!args.write && !args.compare && !args['check-baseline'] && !args['bootstrap-report']) {
    process.stdout.write(`${stableStringify(snapshot)}\n`);
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs, readJson, writeJson };
