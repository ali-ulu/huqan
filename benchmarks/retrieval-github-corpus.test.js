'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { corpusHash, loadFrozenCorpus, runExperiment } = require('./retrieval-experiment');
const { buildCorpus, cleanText } = require('./build-retrieval-github-corpus');
const { CORPORA } = require('./bench-retrieval-experiment');

function pr(number, mergedAt, closes = [], body = '') {
  return { number, title: `Change ${number}`, body, mergedAt, closingIssuesReferences: { nodes: closes } };
}

describe('retrieval GitHub corpus (#3462)', () => {
  describe('builder', () => {
    it('strips numbers, links, emails, code and closing boilerplate from text', () => {
      const text = cleanText('[#12] Fix gate\nCloses #12\nsee https://x.test/a and a@b.io\n```js\nconst k = 1;\n```\n<!-- note -->');
      assert.equal(cleanText('Refs #9'), '');
      assert.equal(text, 'Fix gate see and');
    });

    it('takes relevance from closing links within the newest-PR window', () => {
      const corpus = buildCorpus([
        pr(3, '2026-01-02T00:00:00Z', [{ number: 1, title: 'Gate refuses #1' }]),
        pr(2, '2026-01-03T00:00:00Z', [{ number: 1, title: 'Gate refuses #1' }]),
        // Issue 6's title is only a reference, so it has no text to query with.
        pr(4, '2026-01-04T00:00:00Z', [{ number: 5, title: 'Speed up recall' }, { number: 6, title: '#6' }], 'Body **text**'),
      ]);
      assert.deepEqual(corpus.records.map((record) => record.memoryId), ['pr-3', 'pr-2', 'pr-4']);
      assert.equal(corpus.records[2].content, 'Change 4. Body text');
      assert.deepEqual(corpus.queries, [
        { id: 'issue-1', text: 'Gate refuses', relevant: ['pr-2', 'pr-3'] },
        { id: 'issue-5', text: 'Speed up recall', relevant: ['pr-4'] },
      ]);
      assert.equal(corpus.frozen.sha256, corpusHash(corpus));
    });

    it('keeps only the newest PRs and the issues they close', () => {
      const corpus = buildCorpus([
        pr(1, '2026-01-01T00:00:00Z', [{ number: 7, title: 'Old issue' }]),
        pr(2, '2026-01-02T00:00:00Z', [{ number: 8, title: 'New issue' }]),
      ], { window: 1 });
      assert.deepEqual(corpus.records.map((record) => record.memoryId), ['pr-2']);
      assert.deepEqual(corpus.queries.map((query) => query.id), ['issue-8']);
    });
  });

  describe('frozen fixture', () => {
    it('pins baseline and candidate recall@10 on 408 issue-title queries', () => {
      const corpus = loadFrozenCorpus(CORPORA.github);
      const { corpus: summary, baseline, candidate } = runExperiment(corpus, { k: 10 });
      assert.deepEqual([summary.records, summary.queries], [1000, 408]);
      assert.deepEqual([baseline.precisionAtK, baseline.recallAtK], [0.0037, 0.0368]);
      assert.deepEqual([candidate.precisionAtK, candidate.recallAtK], [0.088, 0.866]);
    });
  });
});
