#!/usr/bin/env node
'use strict';

/**
 * R50 PR1 — freeze CLI for the contradiction evaluation fixture (issue #3582).
 *
 * This file owns the file system and the operator's intent; the rules live in
 * `contradiction-eval-freeze-contract.js` and the freeze step in
 * `contradiction-eval-freeze.js`. What is added here is the part that cannot
 * be a pure function:
 *
 * - it never silently re-freezes. A source snapshot whose digest differs from
 *   the frozen manifest is a hard failure (`source_snapshot_mismatch`) unless
 *   the operator passes `--refreeze`, which is a visible, reviewed act;
 * - `--check` re-derives the corpus, the labels and the manifest from the
 *   committed inputs and fails when the committed bytes are not what the
 *   freeze produces, so the fixture cannot drift away from its own contract.
 *
 * Usage:
 *   node scripts/build-contradiction-eval-fixture.js [--check] [--refreeze]
 */

const fs = require('node:fs');
const path = require('node:path');

const contract = require('./contradiction-eval-freeze-contract');
const freeze = require('./contradiction-eval-freeze');

const {
  DATASET_VERSION,
  FREEZE_SEED,
  MIN_SCORABLE_PER_SPLIT,
  SPLIT_BUCKET_EDGES,
  LABEL_VALUES,
  SCORABLE_LABELS,
  SPLITS,
  STRATA,
  FixtureError,
  fail,
  stableStringify,
  digestOf,
  pairDigestOf,
  pairIdOf,
  sourceSnapshotDigest,
  assignSplit,
} = contract;

const FIXTURE_DIR = path.join(__dirname, '..', 'test', 'fixtures');
const SOURCE_SNAPSHOT_PATH = path.join(FIXTURE_DIR, `${DATASET_VERSION}`, 'source-snapshot.json');
const SOURCE_LABELS_PATH = path.join(FIXTURE_DIR, `${DATASET_VERSION}`, 'source-labels.json');
const CORPUS_PATH = path.join(FIXTURE_DIR, `${DATASET_VERSION}.corpus.json`);
const LABELS_PATH = path.join(FIXTURE_DIR, `${DATASET_VERSION}.labels.json`);
const MANIFEST_PATH = path.join(FIXTURE_DIR, `${DATASET_VERSION}.manifest.json`);

function serialize(document) {
  return `${JSON.stringify(document, null, 2)}\n`;
}

function readJson(filePath, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    fail(code, `cannot read ${path.relative(process.cwd(), filePath)}: ${error.message}`, { filePath });
  }
}

/**
 * Refuse to re-freeze silently. A snapshot whose digest moved is a different
 * dataset; the manifest that recorded the old one is only replaced when the
 * operator says so out loud.
 */
function assertFrozenSource(committedManifest, snapshotDigest, { refreeze = false } = {}) {
  if (!committedManifest || refreeze) return { action: committedManifest ? 'refreeze' : 'initial-freeze' };
  const frozen = committedManifest.source && committedManifest.source.snapshotDigest;
  if (frozen !== snapshotDigest) {
    fail('source_snapshot_mismatch', 'the source snapshot changed under a frozen manifest; freeze a new dataset version or pass --refreeze explicitly', { frozen, observed: snapshotDigest });
  }
  return { action: 'verify' };
}

function readCommittedManifest() {
  try {
    return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  } catch (_) {
    return null;
  }
}

function compareArtifacts(name, expected, actualPath) {
  let committed = null;
  try {
    committed = fs.readFileSync(actualPath, 'utf8');
  } catch (_) {
    return `${name}: committed file is missing (${path.relative(process.cwd(), actualPath)})`;
  }
  if (committed !== serialize(expected)) return `${name}: committed file is not what the freeze produces`;
  return null;
}

function readInputs() {
  return {
    sourceSnapshot: readJson(SOURCE_SNAPSHOT_PATH, 'source_snapshot_unreadable'),
    sourceLabels: readJson(SOURCE_LABELS_PATH, 'source_labels_unreadable'),
  };
}

function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes('--check');
  const refreeze = argv.includes('--refreeze');
  const unknown = argv.filter((arg) => !['--check', '--refreeze'].includes(arg));
  if (unknown.length > 0) fail('unknown_argument', `unsupported argument(s): ${unknown.join(' ')}`, { unknown });

  const built = freeze.buildContradictionEvalFixture(readInputs());

  if (checkOnly) {
    const problems = [
      compareArtifacts('corpus', built.corpus, CORPUS_PATH),
      compareArtifacts('labels', built.labelsDocument, LABELS_PATH),
      compareArtifacts('manifest', built.manifest, MANIFEST_PATH),
    ].filter(Boolean);
    if (problems.length > 0) {
      for (const problem of problems) console.error(`[contradiction-eval] ${problem}`);
      return 1;
    }
    console.log(`[contradiction-eval] ${DATASET_VERSION} is reproducible: corpus digest ${built.digests.corpus}`);
    return 0;
  }

  assertFrozenSource(readCommittedManifest(), built.snapshotDigest, { refreeze });
  fs.writeFileSync(CORPUS_PATH, serialize(built.corpus), 'utf8');
  fs.writeFileSync(LABELS_PATH, serialize(built.labelsDocument), 'utf8');
  fs.writeFileSync(MANIFEST_PATH, serialize(built.manifest), 'utf8');
  console.log(`[contradiction-eval] froze ${built.corpus.records.length} pairs; corpus digest ${built.digests.corpus}`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof FixtureError) {
      console.error(`[contradiction-eval] ${error.code}: ${error.message}`);
      if (Object.keys(error.detail).length > 0) console.error(JSON.stringify(error.detail));
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}

module.exports = {
  ...contract,
  ...freeze,
  DATASET_VERSION,
  FREEZE_SEED,
  MIN_SCORABLE_PER_SPLIT,
  SPLIT_BUCKET_EDGES,
  LABEL_VALUES,
  SCORABLE_LABELS,
  SPLITS,
  STRATA,
  FixtureError,
  stableStringify,
  digestOf,
  pairDigestOf,
  pairIdOf,
  sourceSnapshotDigest,
  assignSplit,
  SOURCE_SNAPSHOT_PATH,
  SOURCE_LABELS_PATH,
  CORPUS_PATH,
  LABELS_PATH,
  MANIFEST_PATH,
  serialize,
  readJson,
  assertFrozenSource,
  main,
};
