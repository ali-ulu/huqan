#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');
const { buildSnapshot } = require('./api-snapshot-surface');
const { diffSnapshots } = require('./api-snapshot-diff');

const ROOT = path.resolve(__dirname, '..');

function parseStableSemver(value) {
  const match = String(value || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    version: `${match[1]}.${match[2]}.${match[3]}`,
  };
}

function compareSemver(left, right) {
  return left.major - right.major
    || left.minor - right.minor
    || left.patch - right.patch;
}

function previousReleaseTag(tags, currentVersion) {
  const current = parseStableSemver(currentVersion);
  if (!current) throw new Error(`Current package version is not stable semver: ${currentVersion}`);
  return tags
    .map((tag) => ({ tag, parsed: parseStableSemver(tag) }))
    .filter((item) => item.parsed && compareSemver(item.parsed, current) < 0)
    .sort((a, b) => compareSemver(b.parsed, a.parsed))[0]?.tag || null;
}

function isRequiredMajorBump(previousVersion, currentVersion) {
  const previous = parseStableSemver(previousVersion);
  const current = parseStableSemver(currentVersion);
  if (!previous || !current) return false;
  return current.major > previous.major && current.minor === 0 && current.patch === 0;
}

function decodeBaseline(text) {
  const parsed = JSON.parse(text);
  if (parsed?.formatVersion === 'huqan.api-snapshot-baseline.v1' && parsed.encoding === 'gzip-base64') {
    return JSON.parse(zlib.gunzipSync(Buffer.from(parsed.payload, 'base64')).toString('utf8'));
  }
  return parsed;
}

function git(args, options = {}) {
  try {
    return execFileSync('git', args, {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
}

function buildSnapshotAtTag(tag) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-api-semver-'));
  const worktree = path.join(tempRoot, 'release-tree');
  try {
    git(['worktree', 'add', '--detach', '--quiet', worktree, tag]);
    const scriptsDir = path.join(worktree, 'scripts');
    for (const file of ['api-snapshot.js', 'api-snapshot-surface.js', 'api-snapshot-diff.js']) {
      fs.copyFileSync(path.join(ROOT, 'scripts', file), path.join(scriptsDir, file));
    }
    const output = path.join(tempRoot, 'release-snapshot.json');
    execFileSync(process.execPath, [path.join(scriptsDir, 'api-snapshot.js'), '--write', output], {
      cwd: worktree,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(fs.readFileSync(output, 'utf8'));
  } finally {
    git(['worktree', 'remove', '--force', worktree], { allowFailure: true });
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function releaseSnapshot(tag) {
  const baselineText = git(['show', `${tag}:api-snapshot-baseline.json`], { allowFailure: true });
  if (baselineText) {
    return { snapshot: decodeBaseline(baselineText), source: 'committed baseline' };
  }
  return { snapshot: buildSnapshotAtTag(tag), source: 'reconstructed historical snapshot' };
}

function evaluateSemverGate(previousSnapshot, currentSnapshot, previousVersion, currentVersion) {
  const result = diffSnapshots(previousSnapshot, currentSnapshot);
  const breaking = result.breaking.length > 0;
  return {
    breaking,
    breakingChanges: result.breaking,
    majorBump: isRequiredMajorBump(previousVersion, currentVersion),
    ok: !breaking || isRequiredMajorBump(previousVersion, currentVersion),
  };
}

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const currentVersion = packageJson.version;
  if (!parseStableSemver(currentVersion)) {
    console.error(`API semver gate requires a stable X.Y.Z package version; got ${currentVersion}.`);
    process.exitCode = 1;
    return;
  }

  const tags = git(['tag', '--merged', 'HEAD', '--list', 'v*'])
    .split(/\r?\n/)
    .map((tag) => tag.trim())
    .filter(Boolean);
  const previousTag = previousReleaseTag(tags, currentVersion);
  if (!previousTag) {
    console.log(`API semver gate bootstrap: no stable release older than ${currentVersion} is reachable from HEAD.`);
    return;
  }

  const previousVersion = previousTag.slice(1);
  const previous = releaseSnapshot(previousTag);
  console.log(`API semver gate: comparing against ${previousTag} via ${previous.source}.`);

  const currentSnapshot = buildSnapshot();
  const verdict = evaluateSemverGate(previous.snapshot, currentSnapshot, previousVersion, currentVersion);

  if (!verdict.breaking) {
    console.log(`API semver gate: no breaking changes since ${previousTag}.`);
    return;
  }

  if (verdict.ok) {
    console.log(
      `API semver gate: ${verdict.breakingChanges.length} breaking change(s) since ${previousTag}; `
      + `major bump ${previousVersion} -> ${currentVersion} is valid.`,
    );
    return;
  }

  console.error(`⚠️ Breaking change detected. Major version bump required.`);
  console.error(
    `Found ${verdict.breakingChanges.length} breaking API change(s) since ${previousTag}, `
    + `but package.json is ${currentVersion}. Expected X.0.0 with X > ${parseStableSemver(previousVersion).major}.`,
  );
  for (const item of verdict.breakingChanges) {
    console.error(`- ${item.area} ${item.key}: ${item.reason}`);
  }
  process.exitCode = 1;
}

if (require.main === module) main();

module.exports = {
  compareSemver,
  decodeBaseline,
  evaluateSemverGate,
  isRequiredMajorBump,
  parseStableSemver,
  previousReleaseTag,
  releaseSnapshot,
};
