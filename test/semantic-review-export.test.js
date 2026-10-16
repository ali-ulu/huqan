'use strict';

// R51 follow-up (#3583): conflict-review verdicts leave the candidate store as
// a review-decisions file, under the owner's internal usage licence, which the
// dataset builder admits only for HUQAN's own internal source.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { exportConflictReviewDecisions, main } = require('../scripts/export-conflict-reviews');
const { buildReviewLabels } = require('../scripts/semantic-review-labels');
const { buildTrainingDataset, INTERNAL_USAGE_LICENSE } = require('../scripts/semantic-training-dataset');

const FROZEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'contradiction-eval-v1.corpus.json'), 'utf8')).records;
const SHA = 'b'.repeat(40);
const edge = (from, relation, to) => ({ from, relation, to, confidence: 0.9, workspaceId: 'default', provenanceId: '' });

function candidate(id, overrides = {}) {
  return {
    candidateId: id,
    claim: 'kahve sakinleştiricidir',
    proposedEdge: edge('kahve', 'IS', 'sakinleştirici'),
    status: 'accepted',
    reviewedBy: 'ali',
    reviewedAt: '2026-10-09T01:00:00.000Z',
    conflict: { conflict: true, type: 'AGENT_VS_GRAPH', existingEvidence: [edge('kahve', 'IS', 'uyarıcı')] },
    ...overrides,
  };
}

test('a reviewed conflict becomes one decision per existing edge, with provenance and the internal licence', () => {
  const { file, skipped } = exportConflictReviewDecisions([
    candidate('c2', { status: 'rejected', claim: '', conflict: { conflict: true, existingEvidence: [edge('su', 'IS', 'soğuk'), edge('su', 'IS', 'buz')] }, proposedEdge: edge('su', 'IS', 'sıcak') }),
    candidate('c1'),
  ], { workspaceId: 'w1' });
  assert.deepEqual(skipped, {});
  assert.equal(file.source.license, INTERNAL_USAGE_LICENSE);
  assert.equal(file.source.url, 'huqan://conflict-review/w1');
  assert.deepEqual(file.decisions.map(d => [d.stored.text, d.incoming.text, d.verdict, d.provenance.decisionId]), [
    ['kahve IS uyarıcı', 'kahve sakinleştiricidir', 'accepted', 'c1#0'],
    ['su IS soğuk', 'su IS sıcak', 'rejected', 'c2#0'],
    ['su IS buz', 'su IS sıcak', 'rejected', 'c2#1'],
  ]);
  assert.equal(file.decisions[0].provenance.reviewer, 'ali');
});

test('pending, non-conflict and text-less candidates are skipped and counted, never guessed', () => {
  const { file, skipped } = exportConflictReviewDecisions([
    candidate('p', { status: 'pending' }),
    candidate('n', { conflict: { conflict: false, existingEvidence: [edge('a', 'IS', 'b')] } }),
    candidate('i', { claim: '', proposedEdge: null }),
    candidate('s', { conflict: { conflict: true, existingEvidence: [] } }),
    candidate('t', { reviewedAt: undefined }),
    candidate('ok'),
  ]);
  assert.equal(file.decisions.length, 1);
  assert.deepEqual(skipped, { not_reviewed: 1, not_a_conflict: 1, incoming_text_missing: 1, stored_text_missing: 1, review_time_missing: 1 });
});

test('the export feeds the label builder and the dataset builder end to end', () => {
  const { file } = exportConflictReviewDecisions([candidate('c1'), candidate('c2', { claim: 'su sıcaktır', status: 'rejected',
    conflict: { conflict: true, existingEvidence: [edge('su', 'IS', 'soğuk')] } })]);
  const labels = buildReviewLabels(file, { frozenCorpus: FROZEN });
  const dataset = buildTrainingDataset({ ...labels, frozenCorpus: FROZEN, sourceCommit: SHA });
  assert.equal(dataset.records.length, 2);
  assert.equal(dataset.sources[0].license, INTERNAL_USAGE_LICENSE);
  assert.deepEqual(dataset.records.map(r => r.teacherSet[0].teacherId), ['human-review', 'human-review']);
});

test('the internal licence is admitted only for the internal source, never for an external dataset', () => {
  const record = { stored: { text: 'x' }, incoming: { text: 'y' }, split: 'train' };
  const teachers = ['t1', 't2'].map(teacherId => ({ teacherId, teacherVersion: '1', input: { stored: record.stored, incoming: record.incoming },
    distribution: { CONTRADICTION: 1, ENTAILMENT: 0, NEUTRAL: 0, ABSTAIN: 0 }, latencyMs: 0 }));
  const build = (sourceId, license) => buildTrainingDataset({ records: [{ ...record, sourceId }], teachers,
    sources: [{ id: sourceId, license, url: 'https://example.org/x', attribution: 'x' }], frozenCorpus: FROZEN, sourceCommit: SHA });
  assert.throws(() => build('snli', INTERNAL_USAGE_LICENSE), /semantic_license_invalid/);
  assert.throws(() => build('conflict-review', 'AGPL-3.0-only'), /semantic_license_invalid/);
  assert.doesNotThrow(() => build('conflict-review', INTERNAL_USAGE_LICENSE));
  assert.doesNotThrow(() => build('snli', 'CC-BY-SA-4.0'));
});

test('the CLI reads one workspace through an injected kernel, writes once and refuses to overwrite', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r51-export-'));
  const out = path.join(dir, 'decisions.json');
  const asked = [];
  const openKernel = () => ({ getCandidateClaims: filters => { asked.push(filters); return [candidate('c1')]; } });
  try {
    assert.match(main([out, '--workspace=team'], { openKernel }), /^1 decisions exported/);
    assert.deepEqual(asked, [{ workspaceId: 'team' }]);
    assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).source.url, 'huqan://conflict-review/team');
    assert.throws(() => main([out], { openKernel }), /EEXIST/);
    assert.throws(() => main([path.join(dir, 'none.json')], { openKernel: () => ({ getCandidateClaims: () => [] }) }), /no exportable review decisions/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
