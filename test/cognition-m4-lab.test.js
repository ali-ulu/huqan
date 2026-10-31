'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildM4Corpus, holdoutGroups, SPLIT_SIZES, RISK_EVERY, RECALL_K, NOW, digestGroups, digestCorpus,
} = require('../lib/cognitive-lab-m4-corpus');
const { evaluateM4, lockGroupCount, MIN_GROUPS, RESTORE_RATE_MAX } = require('../lib/cognitive-lab-m4-evaluator');

const corpus = buildM4Corpus();
const queryCount = (group) => corpus.groups.find((item) => item.sourceGroup === group).queries.length;
const manifest = (over = {}) => ({
  seed: corpus.seed, preregistrationDigest: 'preregistration-sha', recallK: corpus.recallK,
  corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest, nRequired: MIN_GROUPS, ...over,
});
const integrity = { firewallBypass: 0, approvalBypass: 0 };
const record = (group, { queries = queryCount(group), recallHits = queries, readSetSize = 5, archived = 0, neededArchived = 0, restoreFailures = 0 } = {}) => ({
  sourceGroup: group, readSetSize, queries, recallHits, archived, neededArchived, restoreFailures,
});
const arm = (groups, over) => groups.map((group) => record(group, over));
const evaluate = (overrides = {}) => evaluateM4({ corpus, manifest: manifest(), integrity, ...overrides });

test('the corpus is deterministic, group-split, and marks risk groups', () => {
  assert.deepEqual(buildM4Corpus(), corpus);
  assert.notEqual(buildM4Corpus({ seed: 1 }).corpusDigest, corpus.corpusDigest);
  const counts = { calibration: 0, holdout: 0 };
  for (const group of corpus.groups) counts[group.split] += 1;
  assert.deepEqual(counts, SPLIT_SIZES);
  assert.equal(new Set(corpus.groups.map((group) => group.sourceGroup)).size, corpus.groups.length);
  assert.equal(corpus.now, NOW);
  assert.equal(corpus.recallK, RECALL_K);
  for (const group of corpus.groups) {
    assert.equal(group.risk, Number(group.sourceGroup.slice(-3)) % RISK_EVERY === 0);
    // Risk groups carry an extra query that targets the risk record itself.
    assert.equal(group.queries.length, group.risk ? 6 : 5);
  }
});

test('a non-inferior candidate that shrinks the read set reports GAIN', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const result = evaluate({ executions: {
    candidate: arm(groups, { readSetSize: 2, archived: 3, neededArchived: 0 }),
    control: arm(groups, { readSetSize: 5, archived: 0 }),
  } });
  assert.equal(result.label, 'GAIN');
  assert.equal(result.recall.mean, 0);
  assert.equal(result.shrink.mean, 3);
  assert.equal(result.restoreRate, 0);
  assert.equal(result.assertsGain, false);
  assert.equal(result.evidenceClass, 'controlled-fixture');
  assert.equal(result.intelligenceGain, 'NOT_MEASURED');
  assert.deepEqual(evaluate({ executions: {
    candidate: arm(groups, { readSetSize: 2, archived: 3, neededArchived: 0 }),
    control: arm(groups, { readSetSize: 5, archived: 0 }),
  } }), result);
});

test('a recall interval whose upper bound is below the negative margin reports HARM', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const result = evaluate({ executions: {
    candidate: arm(groups, { recallHits: 0, readSetSize: 2, archived: 3, neededArchived: 3 }),
    control: arm(groups, { readSetSize: 5 }),
  } });
  assert.equal(result.label, 'HARM');
  assert.deepEqual(result.reasons, ['recall_interval_upper_below_negative_margin']);
});

test('a non-inferior run that did not shrink the read set is NOT_CLEARED, not a gain', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const result = evaluate({ executions: {
    candidate: arm(groups, { readSetSize: 5, archived: 0 }),
    control: arm(groups, { readSetSize: 5 }),
  } });
  assert.equal(result.label, 'NOT_CLEARED');
  assert.deepEqual(result.reasons, ['read_set_did_not_shrink']);
});

test('a recall loss beyond the margin is NOT_CLEARED (not non-inferior)', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  // A single group loses 40% recall; its interval lower bound is below -0.05.
  const candidate = arm(groups, { readSetSize: 2, archived: 3, neededArchived: 1 });
  const control = arm(groups, { readSetSize: 5 });
  candidate[0].recallHits = 2;
  const result = evaluate({ executions: { candidate, control } });
  assert.equal(result.label, 'NOT_CLEARED');
  assert.ok(result.reasons.includes('recall_not_non_inferior'));
});

test('a restore rate above the frozen limit is NOT_CLEARED', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const result = evaluate({ executions: {
    candidate: arm(groups, { readSetSize: 2, archived: 1, neededArchived: 1 }),
    control: arm(groups, { readSetSize: 5 }),
  } });
  assert.ok(RESTORE_RATE_MAX < 1);
  assert.equal(result.label, 'NOT_CLEARED');
  assert.ok(result.reasons.includes('restore_rate_exceeded'));
});

test('below the preregistered group floor the run is INSUFFICIENT with visible coverage', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const fewer = groups.slice(0, 20);
  const result = evaluate({ manifest: manifest({ nRequired: 24 }), executions: {
    candidate: arm(fewer, { readSetSize: 2, archived: 3 }),
    control: arm(fewer, { readSetSize: 5 }),
  } });
  assert.equal(result.label, 'INSUFFICIENT');
  assert.deepEqual(result.reasons, ['paired_groups_below_required']);
  assert.equal(result.coverage.paired, 20);
  assert.equal(result.coverage.uncovered.length, groups.length - 20);
});

test('a non-reversible archive outranks the group floor (§7 REJECT before INSUFFICIENT)', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const fewer = groups.slice(0, 20);
  const candidate = arm(fewer, { readSetSize: 2, archived: 3 });
  candidate[0].restoreFailures = 1;
  const result = evaluate({ manifest: manifest({ nRequired: 24 }), executions: {
    candidate, control: arm(fewer, { readSetSize: 5 }),
  } });
  assert.equal(result.label, 'REJECT');
  assert.equal(result.reasons[0], 'non_reversible_archive');
  assert.equal(result.coverage.paired, 20);
});

test('integrity bypass, a non-reversible archive, mismatched arms and digests are rejected', () => {
  const groups = holdoutGroups(corpus).map((group) => group.sourceGroup);
  const valid = {
    candidate: arm(groups, { readSetSize: 2, archived: 3 }),
    control: arm(groups, { readSetSize: 5 }),
  };
  assert.equal(evaluate({ executions: valid, integrity: { firewallBypass: 1, approvalBypass: 0 } }).reasons[0],
    'firewall_or_approval_bypass');
  const broken = arm(groups, { readSetSize: 2, archived: 3 });
  broken[0].restoreFailures = 1;
  assert.equal(evaluate({ executions: { candidate: broken, control: valid.control } }).reasons[0], 'non_reversible_archive');
  // The reversibility rule covers every archive, so a control record that fails
  // to restore is a non-reversible mutation too and must not be scored.
  const brokenControl = arm(groups, { readSetSize: 5, archived: 3 });
  brokenControl[0].restoreFailures = 1;
  assert.equal(evaluate({ executions: { candidate: valid.candidate, control: brokenControl } }).reasons[0], 'non_reversible_archive');
  assert.equal(evaluate({ executions: { candidate: valid.candidate, control: valid.control.slice(1) } }).reasons[0],
    'arm_group_sets_differ');
  assert.equal(evaluate({ manifest: manifest({ corpusDigest: 'deadbeef' }), executions: valid }).reasons[0], 'corpus_digest_mismatch');
  assert.equal(evaluate({ manifest: manifest({ seed: 1 }), executions: valid }).reasons[0], 'manifest_seed_mismatch');
  assert.equal(evaluateM4({ corpus: { ...corpus, groups: undefined }, manifest: manifest(), executions: valid, integrity }).reasons[0],
    'invalid_corpus_groups');
  const badRecall = arm(groups, { readSetSize: 2, archived: 3 });
  badRecall[0].recallHits = badRecall[0].queries + 1;
  assert.equal(evaluate({ executions: { candidate: badRecall, control: valid.control } }).reasons[0], 'candidate:invalid_recall_hits');
  const shortQueries = arm(groups, { readSetSize: 2, archived: 3 });
  shortQueries[0].queries = shortQueries[0].queries - 1;
  shortQueries[0].recallHits = shortQueries[0].queries;
  assert.equal(evaluate({ executions: { candidate: shortQueries, control: valid.control } }).reasons[0], 'candidate:query_count_mismatch');
  assert.equal(evaluateM4({ corpus: { ...corpus, groups: [null] }, manifest: manifest(), executions: valid, integrity }).reasons[0],
    'invalid_corpus_groups');
  const malformed = { ...corpus.groups[0], queries: null };
  assert.equal(evaluateM4({ corpus: { ...corpus, groups: [malformed] }, manifest: manifest(), executions: valid, integrity }).reasons[0],
    'invalid_corpus_groups');
  // A query scored at another k would make the reported recallK disagree with
  // the k the recallHits were measured at.
  const wrongK = { ...corpus.groups[0], queries: corpus.groups[0].queries.map((query) => ({ ...query, k: corpus.recallK + 1 })) };
  const kGroups = [wrongK, ...corpus.groups.slice(1)];
  const kCorpus = { ...corpus, groups: kGroups, groupDigest: digestGroups(kGroups) };
  kCorpus.corpusDigest = digestCorpus(kCorpus);
  const kManifest = manifest({ corpusDigest: kCorpus.corpusDigest, groupDigest: kCorpus.groupDigest });
  assert.equal(evaluateM4({ corpus: kCorpus, manifest: kManifest, executions: valid, integrity }).reasons[0], 'query_k_mismatch');
  // A value JSON cannot serialize is a REJECT, not a thrown TypeError.
  const circular = { ...corpus.groups[0] };
  circular.memories = [...circular.memories];
  circular.memories[0] = { ...circular.memories[0], self: circular };
  const cGroups = [circular, ...corpus.groups.slice(1)];
  // The digests are left as the valid corpus carries them; recomputing throws
  // on the circular value, which must come back as a REJECT.
  const cCorpus = { ...corpus, groups: cGroups };
  assert.equal(evaluateM4({ corpus: cCorpus, manifest: manifest(), executions: valid, integrity }).reasons[0],
    'invalid_corpus_groups');
  // A repeated holdout id would be collapsed by the Map and never scored.
  const holdout = corpus.groups.filter((group) => group.split === 'holdout');
  const duplicated = [...corpus.groups, { ...holdout[0] }];
  const dupCorpus = { ...corpus, groups: duplicated, groupDigest: digestGroups(duplicated) };
  dupCorpus.corpusDigest = digestCorpus(dupCorpus);
  const dupManifest = manifest({ corpusDigest: dupCorpus.corpusDigest, groupDigest: dupCorpus.groupDigest });
  assert.equal(evaluateM4({ corpus: dupCorpus, manifest: dupManifest, executions: valid, integrity }).reasons[0], 'duplicate_holdout_group');
  // A calibration episode that archived without restoring is non-reversible too.
  assert.equal(evaluate({ executions: valid, otherExecutions: [{ restoreFailures: 1 }] }).reasons[0], 'non_reversible_archive');
});

test('the group floor follows the preregistered power formula', () => {
  assert.equal(lockGroupCount(0), 24);
  assert.equal(lockGroupCount(0.1), 32);
  assert.equal(lockGroupCount(0.2), 126);
  assert.throws(() => lockGroupCount(-1), /M4_SIGMA_INVALID/);
});

test('the group digest commits the importance/age/use fields the score depends on', () => {
  const groups = buildM4Corpus().groups.map((group) => ({
    ...group,
    memories: group.memories.map((item) => ({ ...item })),
  }));
  assert.equal(digestGroups(groups), corpus.groupDigest);
  groups[0].memories[0].importance = 0.95;
  assert.notEqual(digestGroups(groups), corpus.groupDigest);
});

test('buildM4Corpus freezes the nested group data so a scored corpus cannot be mutated', () => {
  const frozen = buildM4Corpus();
  assert.ok(Object.isFrozen(frozen.groups));
  assert.ok(Object.isFrozen(frozen.groups[0].memories[0]));
  assert.throws(() => { frozen.groups[0].memories[0].importance = 0.95; }, TypeError);
});

test('evaluateM4 recomputes the digests and rejects a corpus mutated after construction', () => {
  const groups = buildM4Corpus().groups.map((group) => ({
    ...group,
    memories: group.memories.map((item) => ({ ...item })),
  }));
  groups[0].memories[0].importance = 0.95;
  const tampered = { ...corpus, groups };
  assert.equal(evaluate({ corpus: tampered }).reasons[0], 'corpus_digest_mismatch');
  const regrouped = { ...corpus, groupDigest: 'deadbeef' };
  assert.equal(evaluate({ corpus: regrouped }).reasons[0], 'group_digest_mismatch');
});
