#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { buildSnapshot, stableStringify } = require('./api-snapshot-surface');
const { diffSnapshots, reportMarkdown } = require('./api-snapshot-diff');

function readJson(file) {
  const parsed = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'));
  if (parsed?.formatVersion === 'huqan.api-snapshot-baseline.v1' && parsed.encoding === 'gzip-base64') {
    const json = zlib.gunzipSync(Buffer.from(parsed.payload, 'base64')).toString('utf8');
    return JSON.parse(json);
  }
  return parsed;
}

function parseStableSemver(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function packageJsonVersion() {
  return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version;
}

// A breaking API diff is expected on the branch that bumps to a new major: the
// base names the lower version it was cut from, and this package is now a
// strictly higher X.0.0. scripts/api-semver-gate.js applies the same rule.
function isAcknowledgedMajorBump(baseVersion, currentVersion) {
  const base = parseStableSemver(baseVersion);
  const current = parseStableSemver(currentVersion);
  return Boolean(base && current && current.major > base.major && current.minor === 0 && current.patch === 0);
}

function writeBaseline(file, value) {
  // Keep the committed baseline compact while preserving deterministic snapshot bytes.
  const compact = stableStringify(value, 0);
  const payload = zlib.gzipSync(Buffer.from(compact), { level: 9 }).toString('base64');
  const baseline = {
    formatVersion: 'huqan.api-snapshot-baseline.v1',
    encoding: 'gzip-base64',
    digest: value.digest,
    payload,
  };
  fs.writeFileSync(path.resolve(file), `${JSON.stringify(baseline)}\n`);
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

  // Reject unknown flags so a mistyped option cannot silently pass the gate.
  const KNOWN = new Set(['snapshot', 'write', 'write-baseline', 'check-baseline', 'compare', 'report', 'bootstrap-report', 'accept-breaking-major-at']);
  for (const key of Object.keys(args)) {
    if (!KNOWN.has(key)) {
      console.error(`Unknown option --${key}`);
      process.exitCode = 1;
      return;
    }
  }
  if (args.write) writeJson(args.write, snapshot);
  if (args['write-baseline']) writeBaseline(args['write-baseline'], snapshot);

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
    let breaking = result.breaking.length > 0;
    // A major release is the acknowledged home for a breaking change: when the
    // caller names the base version and this package is now a strictly higher
    // X.0.0, the diff is expected and the gate passes. scripts/api-semver-gate.js
    // applies the same rule at publish time.
    let acknowledgedMajor = null;
    if (breaking && args['accept-breaking-major-at']) {
      if (isAcknowledgedMajorBump(args['accept-breaking-major-at'], packageJsonVersion())) {
        breaking = false;
        acknowledgedMajor = `v${parseStableSemver(packageJsonVersion()).major}.0.0`;
      }
    }
    const report = reportMarkdown(result, { acknowledgedMajor });
    if (args.report) fs.writeFileSync(path.resolve(args.report), report);
    process.stdout.write(report);
    if (breaking) process.exitCode = 1;
  }

  if (args['bootstrap-report']) {
    const report = reportMarkdown({ breaking: [], added: [] }, { bootstrap: true });
    if (args.report) fs.writeFileSync(path.resolve(args.report), report);
    process.stdout.write(report);
  }

  if (!args.write && !args['write-baseline'] && !args.compare && !args['check-baseline'] && !args['bootstrap-report']) {
    process.stdout.write(`${stableStringify(snapshot)}\n`);
  }
}

if (require.main === module) main();

module.exports = { main, parseArgs, readJson, writeJson, writeBaseline, isAcknowledgedMajorBump, parseStableSemver };
