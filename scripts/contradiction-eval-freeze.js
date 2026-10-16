'use strict';

/**
 * R50 PR1 — the freeze step itself (issue #3582): from an authored source
 * snapshot and authored labels, produce the corpus, the frozen label file and
 * the manifest that carries every digest a reader needs to re-run the freeze.
 *
 * The order of operations is the contract. Validation first, then content
 * dedup, then seeded selection, then label-blind split assignment per group,
 * then the label join, then adequacy. Adequacy is checked last and it is a
 * gate: below the pre-declared floor the builder refuses to produce a corpus
 * that would look measurable and be noise.
 *
 * The step is pure — no clock, no file system, no detector — so the same
 * inputs and the locked seed always produce the same bytes.
 */

const {
  DATASET_VERSION,
  CORPUS_SCHEMA_VERSION,
  LABELS_SCHEMA_VERSION,
  MANIFEST_SCHEMA_VERSION,
  FREEZE_SEED,
  SELECTION_RULE,
  SPLIT_RULE,
  SPLIT_BUCKET_EDGES,
  SPLITS,
  STRATA,
  LABEL_VALUES,
  SCORABLE_LABELS,
  MIN_SCORABLE_PER_SPLIT,
  RECORD_FIELDS,
  SOURCE_FIELDS,
  CLAIM_FIELDS,
  fail,
  digestOf,
  pickClaim,
  pairDigestOf,
  pairIdOf,
  sourceSnapshotDigest,
  selectionKeyFor,
  assignSplit,
  requireExactFields,
  validateSourceSnapshot,
  validateSourceLabels,
} = require('./contradiction-eval-freeze-contract');

/** Dedup by content pair: two candidate ids for the same claims are one pair. */
function dedupeByPairDigest(candidates) {
  const byDigest = new Map();
  const ordered = [...candidates].sort((left, right) => (left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0));
  for (const candidate of ordered) {
    const digest = pairDigestOf(candidate);
    if (!byDigest.has(digest)) byDigest.set(digest, { ...candidate, pairDigest: digest });
  }
  return [...byDigest.values()];
}

/**
 * Dedup keeps one candidate per content pair, and the label join reads only
 * that candidate's label. Two candidates with the same claims but different
 * labels are a ground-truth inconsistency; refuse it instead of letting the
 * candidateId order silently pick a winner.
 */
function assertDuplicateLabelsAgree(candidates, labelsByCandidate) {
  const labelByDigest = new Map();
  for (const candidate of candidates) {
    const entry = labelsByCandidate[candidate.candidateId];
    if (!entry) continue;
    const digest = pairDigestOf(candidate);
    const seen = labelByDigest.get(digest);
    if (!seen) {
      labelByDigest.set(digest, { candidateId: candidate.candidateId, label: entry.label });
    } else if (seen.label !== entry.label) {
      fail('duplicate_label_conflict', 'two candidates with the same content pair carry different labels', {
        pairDigest: digest,
        candidates: [
          { candidateId: seen.candidateId, label: seen.label },
          { candidateId: candidate.candidateId, label: entry.label },
        ],
      });
    }
  }
}

function selectByStratum(deduped, targets) {
  const selected = [];
  for (const stratum of STRATA) {
    const inStratum = deduped
      .filter((candidate) => candidate.samplingStratum === stratum)
      .sort((left, right) => {
        const leftKey = selectionKeyFor(left.candidateId);
        const rightKey = selectionKeyFor(right.candidateId);
        if (leftKey !== rightKey) return leftKey < rightKey ? -1 : 1;
        return left.candidateId < right.candidateId ? -1 : 1;
      });
    const target = targets[stratum];
    if (target > 0 && inStratum.length < target) {
      fail('selection_target_unmet', `stratum ${stratum} holds fewer unique pairs than its frozen target`, {
        stratum, target, available: inStratum.length,
      });
    }
    selected.push(...inStratum.slice(0, target));
  }
  return selected;
}

function buildCorpusRecord(candidate, split, snapshotDigest, sourceSystem) {
  return {
    schemaVersion: CORPUS_SCHEMA_VERSION,
    pairId: pairIdOf(candidate.pairDigest),
    pairDigest: candidate.pairDigest,
    pairGroupId: candidate.pairGroupId,
    source: {
      system: sourceSystem,
      candidateId: candidate.candidateId,
      snapshotDigest,
      triggerKind: candidate.triggerKind,
    },
    stored: pickClaim(candidate.stored),
    incoming: pickClaim(candidate.incoming),
    split,
    samplingStratum: candidate.samplingStratum,
  };
}

/** A record that carries anything but claims is a leaked measurement. */
function assertNoLeakage(record) {
  requireExactFields(record, RECORD_FIELDS, 'corpus_leakage', `record ${record.pairId}`);
  requireExactFields(record.source, SOURCE_FIELDS, 'corpus_leakage', `record ${record.pairId}.source`);
  for (const side of ['stored', 'incoming']) {
    requireExactFields(record[side], CLAIM_FIELDS, 'corpus_leakage', `record ${record.pairId}.${side}`);
  }
}

function countScorable(records, labels) {
  const labelOf = (pairId) => {
    const entry = labels[pairId];
    return entry && typeof entry === 'object' ? entry.label : entry;
  };
  return SPLITS.map((split) => {
    const inSplit = records.filter((record) => record.split === split);
    const scorable = inSplit.filter((record) => SCORABLE_LABELS.includes(labelOf(record.pairId)));
    return {
      split,
      total: inSplit.length,
      scorable: scorable.length,
      contradiction: scorable.filter((record) => labelOf(record.pairId) === 'CONTRADICTION').length,
      notContradiction: scorable.filter((record) => labelOf(record.pairId) === 'NOT_CONTRADICTION').length,
      excluded: inSplit.length - scorable.length,
    };
  });
}

function buildContradictionEvalFixture({ sourceSnapshot, sourceLabels, seed = FREEZE_SEED } = {}) {
  if (seed !== FREEZE_SEED) {
    fail('freeze_seed_locked', 'the sampling seed is frozen in the preregistration and cannot be passed in', {
      frozen: FREEZE_SEED, requested: seed,
    });
  }
  const snapshot = validateSourceSnapshot(sourceSnapshot);
  const knownCandidateIds = new Set(snapshot.candidates.map((candidate) => candidate.candidateId));
  const labelsByCandidate = validateSourceLabels(sourceLabels, knownCandidateIds);
  assertDuplicateLabelsAgree(snapshot.candidates, labelsByCandidate);

  const snapshotDigest = sourceSnapshotDigest(snapshot.candidates);
  const deduped = dedupeByPairDigest(snapshot.candidates);
  const selected = selectByStratum(deduped, snapshot.targets);

  // Split assignment is per group, so a group can never span splits. The
  // explicit check below is what makes that a verified property, not a hope.
  const splitByGroup = new Map();
  for (const candidate of selected) {
    const split = assignSplit(candidate.pairGroupId);
    const previous = splitByGroup.get(candidate.pairGroupId);
    if (previous !== undefined && previous !== split) {
      fail('group_split_leakage', `pairGroupId spans two splits: ${candidate.pairGroupId}`, { pairGroupId: candidate.pairGroupId });
    }
    splitByGroup.set(candidate.pairGroupId, split);
  }

  const records = selected
    .map((candidate) => buildCorpusRecord(candidate, splitByGroup.get(candidate.pairGroupId), snapshotDigest, snapshot.sourceSystem))
    .sort((left, right) => (left.pairId < right.pairId ? -1 : left.pairId > right.pairId ? 1 : 0));
  for (const record of records) assertNoLeakage(record);

  const frozenLabels = {};
  for (const record of records) {
    const entry = labelsByCandidate[record.source.candidateId];
    if (!entry) {
      fail('label_missing', 'no label for the selected candidate', { candidateId: record.source.candidateId, pairId: record.pairId });
    }
    frozenLabels[record.pairId] = { label: entry.label, note: String(entry.note ?? '') };
  }
  const orderedLabels = {};
  for (const key of Object.keys(frozenLabels).sort()) orderedLabels[key] = frozenLabels[key];

  const corpus = { schemaVersion: CORPUS_SCHEMA_VERSION, datasetVersion: DATASET_VERSION, records };
  const labelsDocument = {
    schemaVersion: LABELS_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    labelValues: [...LABEL_VALUES],
    scorableLabelValues: [...SCORABLE_LABELS],
    provenance: sourceLabels.provenance,
    labels: orderedLabels,
  };

  const adequacy = countScorable(records, frozenLabels);
  const insufficient = adequacy.filter((entry) => entry.scorable < MIN_SCORABLE_PER_SPLIT[entry.split]);
  if (insufficient.length > 0) {
    fail('sample_insufficient', 'a split is below the pre-declared scorable minimum', {
      minimums: MIN_SCORABLE_PER_SPLIT, observed: adequacy,
    });
  }

  const splitIdentity = records.map((record) => `${record.pairId}=${record.split}`).sort();
  const holdoutIds = records.filter((record) => record.split === 'holdout').map((record) => record.pairId).sort();
  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    datasetVersion: DATASET_VERSION,
    source: {
      system: snapshot.sourceSystem,
      snapshotId: snapshot.snapshotId,
      snapshotDigest,
      candidateCount: snapshot.candidates.length,
      uniquePairCount: deduped.length,
      selectedCount: records.length,
    },
    sampling: {
      seed: FREEZE_SEED,
      selectionRule: SELECTION_RULE,
      splitRule: SPLIT_RULE,
      bucketEdges: { ...SPLIT_BUCKET_EDGES },
      targets: { ...snapshot.targets },
    },
    sampleAdequacy: {
      status: 'ADEQUATE',
      floor: { ...MIN_SCORABLE_PER_SPLIT },
      observed: adequacy,
    },
    digests: {
      sourceSnapshot: snapshotDigest,
      corpus: digestOf(corpus),
      labels: digestOf(labelsDocument),
      split: digestOf(splitIdentity),
      protocol: digestOf({
        datasetVersion: DATASET_VERSION,
        seed: FREEZE_SEED,
        selectionRule: SELECTION_RULE,
        splitRule: SPLIT_RULE,
        bucketEdges: SPLIT_BUCKET_EDGES,
        minScorablePerSplit: MIN_SCORABLE_PER_SPLIT,
        labelValues: LABEL_VALUES,
      }),
    },
    holdout: {
      pairIds: holdoutIds,
      sealDigest: digestOf(holdoutIds),
      readerPolicy: 'train_and_calibration_only_until_final_evaluation',
      independentAdjudication: 'PENDING',
    },
    leakageControls: {
      groupsSpanningSplits: 0,
      corpusCarriesLabels: false,
      corpusCarriesDetectorOutput: false,
      glue: 'record_shape_is_a_strict_allowlist',
    },
    authority: {
      kind: 'DETERMINISTIC', locality: 'LOCAL', authority: 'CANDIDATE_ONLY', canonical: false,
      modelCalls: 0, tokens: 0, externalCalls: 0,
    },
    productionBehaviorChanged: false,
  };

  return { corpus, labelsDocument, manifest, digests: manifest.digests, adequacy, snapshotDigest };
}

module.exports = {
  dedupeByPairDigest,
  assertDuplicateLabelsAgree,
  selectByStratum,
  buildCorpusRecord,
  assertNoLeakage,
  countScorable,
  buildContradictionEvalFixture,
};
