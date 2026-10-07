'use strict';

// R50 PR1 (issue #3582): the frozen contradiction-eval fixture is the ground
// truth the A/B/C measurement stands on. These tests lock the properties that
// make it usable as ground truth rather than a file that merely exists:
//
//   - the freeze is deterministic and replayable from the committed inputs;
//   - selection and splitting never read a label, so a label edit cannot move
//     a pair between splits;
//   - a pair group never spans splits and content duplicates collapse;
//   - the corpus carries claims only: no label, no detector output, nothing the
//     measurement is supposed to produce;
//   - a changed source snapshot is a hard failure, not a silent new dataset;
//   - sample adequacy is a gate, and the shipped fixture meets the floor.
//
// The test restates the record contract instead of importing it, so a widened
// allowlist in the builder cannot widen the test with it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const builder = require('../scripts/build-contradiction-eval-fixture.js');

const SOURCE_SNAPSHOT = JSON.parse(fs.readFileSync(builder.SOURCE_SNAPSHOT_PATH, 'utf8'));
const SOURCE_LABELS = JSON.parse(fs.readFileSync(builder.SOURCE_LABELS_PATH, 'utf8'));
const CORPUS = JSON.parse(fs.readFileSync(builder.CORPUS_PATH, 'utf8'));
const LABELS = JSON.parse(fs.readFileSync(builder.LABELS_PATH, 'utf8'));
const MANIFEST = JSON.parse(fs.readFileSync(builder.MANIFEST_PATH, 'utf8'));

const RECORD_KEYS = [
  'schemaVersion', 'pairId', 'pairDigest', 'pairGroupId', 'source', 'stored', 'incoming', 'split', 'samplingStratum',
];
const SOURCE_KEYS = ['system', 'candidateId', 'snapshotDigest', 'triggerKind'];
const CLAIM_KEYS = ['text', 'subject', 'relation', 'sourceType', 'frameId'];

function build(overrides = {}) {
  return builder.buildContradictionEvalFixture({
    sourceSnapshot: overrides.sourceSnapshot || SOURCE_SNAPSHOT,
    sourceLabels: overrides.sourceLabels || SOURCE_LABELS,
  });
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function throwsCode(fn, code) {
  assert.throws(fn, (error) => error instanceof builder.FixtureError && error.code === code, `expected ${code}`);
}

// --- the committed freeze ----------------------------------------------------

test('the frozen fixture is exactly what the committed inputs produce', () => {
  const built = build();
  assert.deepEqual(built.corpus, CORPUS);
  assert.deepEqual(built.labelsDocument, LABELS);
  assert.deepEqual(built.manifest, MANIFEST);
  // The CLI contract: `--check` is 0 only when the freeze replays byte for byte.
  assert.equal(builder.main(['--check']), 0);
});

test('every manifest digest recomputes from the artifacts it names', () => {
  const built = build();
  assert.equal(MANIFEST.digests.corpus, builder.digestOf(built.corpus));
  assert.equal(MANIFEST.digests.labels, builder.digestOf(built.labelsDocument));
  // Snapshot identity is the content set: re-ordering the file cannot move it.
  assert.equal(MANIFEST.digests.sourceSnapshot, builder.sourceSnapshotDigest(SOURCE_SNAPSHOT.candidates));
  assert.equal(
    MANIFEST.digests.sourceSnapshot,
    builder.sourceSnapshotDigest([...SOURCE_SNAPSHOT.candidates].reverse()),
  );
  const splitIdentity = CORPUS.records.map((record) => `${record.pairId}=${record.split}`).sort();
  assert.equal(MANIFEST.digests.split, builder.digestOf(splitIdentity));
  assert.ok(/^[0-9a-f]{64}$/.test(MANIFEST.digests.protocol), 'the protocol digest is a sha256 hex');
});

test('the freeze is independent of input order and of label content', () => {
  const forward = build();
  const reversed = builder.buildContradictionEvalFixture({
    sourceSnapshot: { ...SOURCE_SNAPSHOT, candidates: [...SOURCE_SNAPSHOT.candidates].reverse() },
    sourceLabels: SOURCE_LABELS,
  });
  assert.deepEqual(reversed.corpus, forward.corpus);

  // Label-blindness, stated as a property: replacing every label with the
  // opposite scorable value leaves every split where it was.
  const flipped = clone(SOURCE_LABELS);
  for (const entry of Object.values(flipped.labels)) {
    if (entry.label === 'CONTRADICTION') entry.label = 'NOT_CONTRADICTION';
    else if (entry.label === 'NOT_CONTRADICTION') entry.label = 'CONTRADICTION';
  }
  const flippedBuild = builder.buildContradictionEvalFixture({
    sourceSnapshot: SOURCE_SNAPSHOT,
    sourceLabels: flipped,
  });
  assert.deepEqual(
    flippedBuild.corpus.records.map((record) => [record.pairId, record.split]),
    forward.corpus.records.map((record) => [record.pairId, record.split]),
  );
});

// --- corpus contract ---------------------------------------------------------

test('the corpus carries claims only: no label, no detector output, no extra field', () => {
  for (const record of CORPUS.records) {
    assert.deepEqual(Object.keys(record).sort(), [...RECORD_KEYS].sort());
    assert.deepEqual(Object.keys(record.source).sort(), [...SOURCE_KEYS].sort());
    for (const side of ['stored', 'incoming']) {
      assert.deepEqual(Object.keys(record[side]).sort(), [...CLAIM_KEYS].sort());
    }
    assert.equal(Object.hasOwn(record, 'label'), false);
  }
  // The labels live in their own artifact, keyed by pairId.
  assert.deepEqual(Object.keys(LABELS.labels).sort(), CORPUS.records.map((record) => record.pairId).sort());
  for (const entry of Object.values(LABELS.labels)) {
    assert.ok(builder.LABEL_VALUES.includes(entry.label), `unknown label ${entry.label}`);
  }
});

test('content duplicates collapse and no pair repeats', () => {
  const digests = CORPUS.records.map((record) => record.pairDigest);
  assert.equal(new Set(digests).size, digests.length, 'two records share a pairDigest');
  assert.ok(MANIFEST.source.candidateCount > MANIFEST.source.uniquePairCount, 'the source snapshot must exercise dedup');
  assert.equal(MANIFEST.source.uniquePairCount, MANIFEST.source.candidateCount - 8, 'eight authored duplicates');
  assert.equal(CORPUS.records.length, MANIFEST.source.selectedCount);
  assert.equal(builder.pairIdOf(digests[0]), CORPUS.records[0].pairId);
});

// --- split integrity ---------------------------------------------------------

test('a pair group never spans splits and the holdout is sealed', () => {
  const splitByGroup = new Map();
  for (const record of CORPUS.records) {
    assert.ok(builder.SPLITS.includes(record.split), `unknown split ${record.split}`);
    const previous = splitByGroup.get(record.pairGroupId);
    if (previous !== undefined) assert.equal(previous, record.split, `${record.pairGroupId} spans splits`);
    splitByGroup.set(record.pairGroupId, record.split);
  }
  const holdoutIds = CORPUS.records.filter((record) => record.split === 'holdout').map((record) => record.pairId).sort();
  assert.deepEqual(MANIFEST.holdout.pairIds, holdoutIds);
  assert.equal(MANIFEST.holdout.sealDigest, builder.digestOf(holdoutIds));
  assert.equal(MANIFEST.holdout.readerPolicy, 'train_and_calibration_only_until_final_evaluation');
  const trainIds = new Set(CORPUS.records.filter((record) => record.split !== 'holdout').map((record) => record.pairId));
  for (const id of holdoutIds) assert.equal(trainIds.has(id), false);
});

test('the split assignment is a pure function of the group id and the frozen seed', () => {
  for (const record of CORPUS.records) {
    assert.equal(builder.assignSplit(record.pairGroupId), record.split);
  }
  const buckets = new Set(CORPUS.records.map((record) => builder.assignSplit(record.pairGroupId)));
  assert.deepEqual([...buckets].sort(), ['calibration', 'holdout', 'train']);
});

// --- freeze discipline -------------------------------------------------------

test('the sampling seed is frozen and cannot be passed in', () => {
  assert.equal(builder.FREEZE_SEED, 3582);
  throwsCode(
    () => builder.buildContradictionEvalFixture({ sourceSnapshot: SOURCE_SNAPSHOT, sourceLabels: SOURCE_LABELS, seed: 1 }),
    'freeze_seed_locked',
  );
});

test('a changed source snapshot is refused instead of silently re-frozen', () => {
  const mutated = clone(SOURCE_SNAPSHOT);
  mutated.candidates[0].incoming.text = 'the storage backend is MySQL';
  const observed = `sha256:${builder.digestOf(mutated.candidates)}`;
  assert.notEqual(observed, MANIFEST.source.snapshotDigest);
  throwsCode(() => builder.assertFrozenSource(MANIFEST, observed), 'source_snapshot_mismatch');
  assert.deepEqual(builder.assertFrozenSource(MANIFEST, observed, { refreeze: true }), { action: 'refreeze' });
  assert.deepEqual(builder.assertFrozenSource(MANIFEST, MANIFEST.source.snapshotDigest), { action: 'verify' });
  assert.deepEqual(builder.assertFrozenSource(null, observed), { action: 'initial-freeze' });
  // The dataset the mutation would produce is a different dataset.
  assert.notEqual(builder.buildContradictionEvalFixture({ sourceSnapshot: mutated, sourceLabels: SOURCE_LABELS }).digests.corpus, MANIFEST.digests.corpus);
});

test('a freeze input outside the candidate set is refused too, not only the snapshot digest', () => {
  assert.deepEqual(builder.assertFrozenManifest(MANIFEST, build().manifest), { action: 'verify' });

  // A relabelled holdout pair leaves the candidate digest where it was.
  const holdoutPair = CORPUS.records.find((record) => record.split === 'holdout');
  const relabelled = clone(SOURCE_LABELS);
  const entry = relabelled.labels[holdoutPair.source.candidateId];
  entry.label = entry.label === 'CONTRADICTION' ? 'NOT_CONTRADICTION' : 'CONTRADICTION';
  const relabelledManifest = build({ sourceLabels: relabelled }).manifest;
  assert.equal(relabelledManifest.source.snapshotDigest, MANIFEST.source.snapshotDigest);
  throwsCode(() => builder.assertFrozenManifest(MANIFEST, relabelledManifest), 'frozen_manifest_mismatch');

  const renamed = clone(SOURCE_SNAPSHOT);
  renamed.snapshotId = `${renamed.snapshotId}-edited`;
  throwsCode(() => builder.assertFrozenManifest(MANIFEST, build({ sourceSnapshot: renamed }).manifest), 'frozen_manifest_mismatch');

  assert.deepEqual(builder.assertFrozenManifest(MANIFEST, relabelledManifest, { refreeze: true }), { action: 'refreeze' });
  assert.deepEqual(builder.assertFrozenManifest(null, relabelledManifest), { action: 'initial-freeze' });
});

test('content duplicates whose labels disagree are refused, not silently resolved', () => {
  const firstByDigest = new Map();
  let duplicate = null;
  for (const candidate of SOURCE_SNAPSHOT.candidates) {
    const digest = builder.pairDigestOf(candidate);
    if (firstByDigest.has(digest)) { duplicate = [firstByDigest.get(digest), candidate]; break; }
    firstByDigest.set(digest, candidate);
  }
  assert.ok(duplicate, 'the committed snapshot carries authored duplicates');

  const conflicting = clone(SOURCE_LABELS);
  const kept = conflicting.labels[duplicate[0].candidateId].label;
  conflicting.labels[duplicate[1].candidateId].label = builder.LABEL_VALUES.find((value) => value !== kept);
  throwsCode(() => build({ sourceLabels: conflicting }), 'duplicate_label_conflict');
});

test('an unreadable committed manifest is refused, not treated as an initial freeze', () => {
  const os = require('node:os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'r50-manifest-'));
  try {
    // A missing manifest really is "no frozen dataset yet".
    assert.equal(builder.readCommittedManifest(path.join(tmp, 'absent.json')), null);
    // An existing manifest that cannot be parsed must not read as one.
    const corrupt = path.join(tmp, 'broken.json');
    fs.writeFileSync(corrupt, '{ not json', 'utf8');
    throwsCode(() => builder.readCommittedManifest(corrupt), 'committed_manifest_unreadable');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('a snapshot outside the frozen schema or shape is rejected', () => {
  const wrongSchema = { ...clone(SOURCE_SNAPSHOT), schemaVersion: 'something-else' };
  throwsCode(() => builder.buildContradictionEvalFixture({ sourceSnapshot: wrongSchema, sourceLabels: SOURCE_LABELS }), 'source_snapshot_schema_mismatch');

  const extraField = clone(SOURCE_SNAPSHOT);
  extraField.candidates[0].detectorConfidence = 0.95;
  throwsCode(() => builder.buildContradictionEvalFixture({ sourceSnapshot: extraField, sourceLabels: SOURCE_LABELS }), 'source_snapshot_invalid');

  const unknownStratum = clone(SOURCE_SNAPSHOT);
  unknownStratum.candidates[0].samplingStratum = 'invented';
  throwsCode(() => builder.buildContradictionEvalFixture({ sourceSnapshot: unknownStratum, sourceLabels: SOURCE_LABELS }), 'source_snapshot_invalid');
});

test('labels are validated: unknown pair, unknown value and a missing label all fail', () => {
  const unknownCandidate = clone(SOURCE_LABELS);
  unknownCandidate.labels['cand-not-in-the-snapshot'] = { label: 'CONTRADICTION', note: '' };
  throwsCode(() => builder.buildContradictionEvalFixture({ sourceSnapshot: SOURCE_SNAPSHOT, sourceLabels: unknownCandidate }), 'label_unknown_candidate');

  const badValue = clone(SOURCE_LABELS);
  badValue.labels['cand-001'].label = 'MAYBE';
  throwsCode(() => builder.buildContradictionEvalFixture({ sourceSnapshot: SOURCE_SNAPSHOT, sourceLabels: badValue }), 'label_malformed');

  const missing = clone(SOURCE_LABELS);
  delete missing.labels['cand-001'];
  throwsCode(() => builder.buildContradictionEvalFixture({ sourceSnapshot: SOURCE_SNAPSHOT, sourceLabels: missing }), 'label_missing');
});

// --- adequacy ----------------------------------------------------------------

test('the shipped corpus meets the pre-declared scorable floor', () => {
  assert.equal(MANIFEST.sampleAdequacy.status, 'ADEQUATE');
  assert.deepEqual(MANIFEST.sampleAdequacy.observed.map((entry) => entry.split).sort(), ['calibration', 'holdout', 'train']);
  for (const entry of MANIFEST.sampleAdequacy.observed) {
    assert.ok(entry.scorable >= builder.MIN_SCORABLE_PER_SPLIT[entry.split], `${entry.split} is below the floor`);
    assert.ok(entry.contradiction >= 1 && entry.notContradiction >= 1, `${entry.split} cannot score both classes`);
    assert.equal(entry.scorable + entry.excluded, entry.total);
  }
});

test('too little data is INSUFFICIENT, not a small dataset that looks measurable', () => {
  const trimmed = clone(SOURCE_SNAPSHOT);
  trimmed.candidates = trimmed.candidates.filter((candidate) => candidate.samplingStratum === 'measurement_uncertain');
  const kept = new Set(trimmed.candidates.map((candidate) => candidate.candidateId));
  for (const stratum of builder.STRATA) trimmed.selectionTargets[stratum] = 0;
  trimmed.selectionTargets.measurement_uncertain = builder.dedupeByPairDigest(trimmed.candidates).length;
  // Labels are keyed by candidate id, so the trimmed source trims its labels too;
  // the pair that survives is all UNCERTAIN, which cannot score a single class.
  const trimmedLabels = clone(SOURCE_LABELS);
  trimmedLabels.labels = Object.fromEntries(Object.entries(trimmedLabels.labels).filter(([id]) => kept.has(id)));
  throwsCode(
    () => builder.buildContradictionEvalFixture({ sourceSnapshot: trimmed, sourceLabels: trimmedLabels }),
    'sample_insufficient',
  );
});

// --- boundary -----------------------------------------------------------------

test('the freeze reads no contradiction detector and claims no authority', () => {
  const loaded = Object.keys(require.cache).join('\n');
  assert.equal(/contradiction-rules|semantic-signals|risk-rules|llmAdapter/.test(loaded), false, 'the fixture path must not load a detector');
  assert.deepEqual(MANIFEST.authority, {
    kind: 'DETERMINISTIC', locality: 'LOCAL', authority: 'CANDIDATE_ONLY', canonical: false,
    modelCalls: 0, tokens: 0, externalCalls: 0,
  });
  assert.equal(MANIFEST.productionBehaviorChanged, false);
  assert.equal(MANIFEST.schemaVersion, 'huqan-contradiction-eval-manifest-v1');
  assert.equal(LABELS.provenance.adjudication.status, 'PENDING_INDEPENDENT_HOLDOUT_REVIEW');
});

test('the builder serializes canonically', () => {
  assert.equal(
    builder.serialize({ b: 1, a: { d: 2, c: 3 } }),
    '{\n  "b": 1,\n  "a": {\n    "d": 2,\n    "c": 3\n  }\n}\n',
  );
  assert.equal(builder.stableStringify({ b: 1, a: [2, { d: 4, c: 3 }] }), builder.stableStringify({ a: [2, { c: 3, d: 4 }], b: 1 }));
  assert.equal(path.basename(builder.CORPUS_PATH), 'contradiction-eval-v1.corpus.json');
  assert.equal(path.basename(builder.MANIFEST_PATH), 'contradiction-eval-v1.manifest.json');
});
