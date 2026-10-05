const assert = require('assert');
const { describe, test } = require('node:test');

const {
  DEFAULT_NGRAM_SIZE,
  DEFAULT_THRESHOLD,
  evaluateDecontamination,
  scoreTextAgainstCorpus,
} = require('../lib/memory-decontamination');
const { evaluateMemoryRecall } = require('../lib/memory-recall-gate');
const { runQuery } = require('../lib/memory-query-engine');

const CURRENT_POLICY = '0.8.0';
const SOURCE_TEXT = 'the quick brown fox jumps over the lazy dog near the river bank at dawn';
const CORPUS = [SOURCE_TEXT];

function record(content, overrides = {}) {
  return {
    memoryId: 'mem-1',
    workspaceId: 'workspace-a',
    content,
    createdAt: '2026-01-01T00:00:00.000Z',
    status: 'active',
    trustPolicyVersion: CURRENT_POLICY,
    provenance: {
      provenanceId: 'prov-1',
      sourceRef: 'doc://alpha',
      sourceType: 'document',
      actor: 'agent-1',
      confidence: 0.9,
    },
    ...overrides,
  };
}

function evaluate(records, opts = {}) {
  return evaluateMemoryRecall({
    workspaceId: 'workspace-a',
    records,
    currentTrustPolicyVersion: CURRENT_POLICY,
    ...opts,
  });
}

describe('decontamination scorer: containment', () => {
  test('a verbatim echo of the corpus scores 1 against it', () => {
    const scored = scoreTextAgainstCorpus(SOURCE_TEXT, CORPUS);
    assert.strictEqual(scored.score, 1);
    assert.strictEqual(scored.bestEntryIndex, 0);
    assert.ok(scored.matchedNgrams > 0);
  });

  test('unrelated text scores 0', () => {
    const scored = scoreTextAgainstCorpus(
      'quantum entanglement distributes correlated measurement outcomes across distant laboratories',
      CORPUS,
    );
    assert.strictEqual(scored.score, 0);
    assert.strictEqual(scored.bestEntryIndex, -1);
  });

  test('partial overlap lands strictly between 0 and 1', () => {
    const scored = scoreTextAgainstCorpus(
      `${SOURCE_TEXT} plus an unrelated epilogue about container orchestration and midnight deploys`,
      CORPUS,
    );
    assert.ok(scored.score > 0 && scored.score < 1);
  });

  test('a short verbatim quote still scores 1 through the exact path', () => {
    const scored = scoreTextAgainstCorpus('lazy dog', CORPUS, { ngramSize: DEFAULT_NGRAM_SIZE });
    assert.strictEqual(scored.score, 1);
  });

  test('a short unrelated fragment scores 0', () => {
    const scored = scoreTextAgainstCorpus('purple zebra', CORPUS, { ngramSize: DEFAULT_NGRAM_SIZE });
    assert.strictEqual(scored.score, 0);
  });

  test('scoring is deterministic across repeated calls', () => {
    const text = `${SOURCE_TEXT} with a small original tail about release engineering`;
    const first = scoreTextAgainstCorpus(text, [...CORPUS, 'entirely different training material here']);
    const second = scoreTextAgainstCorpus(text, [...CORPUS, 'entirely different training material here']);
    assert.deepStrictEqual(first, second);
  });

  test('key order in object content cannot move the score', () => {
    const left = JSON.stringify({ b: 1, a: SOURCE_TEXT });
    const right = JSON.stringify({ a: SOURCE_TEXT, b: 1 });
    assert.strictEqual(
      scoreTextAgainstCorpus(left, CORPUS).score,
      scoreTextAgainstCorpus(right, CORPUS).score,
    );
  });
});

describe('decontamination scorer: validation', () => {
  test('exposes documented defaults', () => {
    assert.strictEqual(DEFAULT_NGRAM_SIZE, 8);
    assert.strictEqual(DEFAULT_THRESHOLD, 0.8);
  });

  test('marks a contaminated record at the default threshold', () => {
    const result = evaluateDecontamination({ text: SOURCE_TEXT, corpus: CORPUS });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.contaminated, true);
    assert.strictEqual(result.threshold, DEFAULT_THRESHOLD);
  });

  test('a custom threshold moves the verdict deterministically', () => {
    const text = `${SOURCE_TEXT} plus an unrelated epilogue about container orchestration and midnight deploys`;
    const strict = evaluateDecontamination({ text, corpus: CORPUS, threshold: 0.99 });
    const lax = evaluateDecontamination({ text, corpus: CORPUS, threshold: 0.01 });
    assert.strictEqual(strict.ok, true);
    assert.strictEqual(lax.ok, true);
    assert.strictEqual(strict.score, lax.score);
    assert.strictEqual(lax.contaminated, true);
    assert.strictEqual(strict.contaminated, strict.score >= 0.99);
  });

  test('rejects a non-array corpus, an out-of-range threshold and a bad n-gram size', () => {
    assert.strictEqual(evaluateDecontamination({ text: 'x', corpus: 'nope' }).ok, false);
    assert.strictEqual(evaluateDecontamination({ text: 'x', corpus: CORPUS, threshold: 2 }).ok, false);
    assert.strictEqual(evaluateDecontamination({ text: 'x', corpus: CORPUS, ngramSize: 2 }).ok, false);
    assert.strictEqual(evaluateDecontamination({ text: 'x', corpus: [42] }).ok, false);
  });
});

describe('recall gate: self-contamination screen (#3464)', () => {
  test('withholds a record that echoes the corpus', () => {
    const result = evaluate([record(SOURCE_TEXT)], { decontamination: { corpus: CORPUS } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.strictEqual(result.decisions[0].reason, 'self_contamination');
    assert.strictEqual(result.summary.withheld, 1);
    assert.strictEqual(result.admitted.length, 0);
  });

  test('every evaluated record carries its measurement while the screen is on', () => {
    const result = evaluate(
      [record(SOURCE_TEXT), record('deployment checklist for the canary rollout window')],
      { decontamination: { corpus: CORPUS } },
    );
    assert.deepStrictEqual(result.decisions.map((d) => d.decision), ['withhold', 'admit']);
    assert.strictEqual(result.decisions[0].decontamination.contaminated, true);
    assert.strictEqual(result.decisions[1].decontamination.contaminated, false);
    assert.strictEqual(result.decisions[1].decontamination.score, 0);
  });

  test('withheld entries and ledger events carry the score, never the content', () => {
    const result = evaluate([record(SOURCE_TEXT)], { decontamination: { corpus: CORPUS } });
    assert.strictEqual(result.withheld[0].contaminationScore, 1);
    assert.strictEqual(result.withheld[0].contaminationThreshold, DEFAULT_THRESHOLD);
    const event = result.ledgerEvents[0];
    assert.strictEqual(event.reason, 'self_contamination');
    assert.strictEqual(event.contaminationScore, 1);
    assert.ok(!JSON.stringify(event).includes('lazy dog'));
  });

  test('the screen is off unless requested: no measurement, no behaviour change', () => {
    const result = evaluate([record(SOURCE_TEXT)]);
    assert.strictEqual(result.decisions[0].decision, 'admit');
    assert.strictEqual(result.decisions[0].decontamination, undefined);
  });

  test('an empty corpus is off, not an error', () => {
    const result = evaluate([record(SOURCE_TEXT)], { decontamination: { corpus: [] } });
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.decisions[0].decision, 'admit');
  });

  test('an invalid screen fails the whole call closed and admits nothing', () => {
    for (const decontamination of [
      'nope',
      { corpus: 'nope' },
      { corpus: CORPUS, threshold: 5 },
      { corpus: CORPUS, ngramSize: 2 },
      { corpus: [42] },
    ]) {
      const result = evaluate([record(SOURCE_TEXT)], { decontamination });
      assert.strictEqual(result.ok, false, JSON.stringify(decontamination));
      assert.deepStrictEqual(result.admitted, []);
    }
  });

  test('contamination outranks staleness: the strictest signal still wins', () => {
    const result = evaluate(
      [record(SOURCE_TEXT, { trustPolicyVersion: '0.7.0' })],
      { decontamination: { corpus: CORPUS } },
    );
    assert.strictEqual(result.decisions[0].decision, 'withhold');
    assert.strictEqual(result.decisions[0].reason, 'self_contamination');
    assert.ok(result.decisions[0].signals.some((s) => s.reason === 'stale_trust_policy'));
  });

  test('a custom threshold is honoured by the gate', () => {
    const partial = `${SOURCE_TEXT} plus an unrelated epilogue about container orchestration and midnight deploys`;
    const scored = evaluateDecontamination({ text: partial, corpus: CORPUS });
    assert.ok(scored.score > 0 && scored.score < 1);
    const above = evaluate([record(partial)], {
      decontamination: { corpus: CORPUS, threshold: Math.max(0, scored.score - 0.01) },
    });
    const below = evaluate([record(partial)], {
      decontamination: { corpus: CORPUS, threshold: Math.min(1, scored.score + 0.01) },
    });
    assert.strictEqual(above.decisions[0].decision, 'withhold');
    assert.strictEqual(below.decisions[0].decision, 'admit');
  });

  test('object content is measured through the canonical projection', () => {
    // Key 'a' is a stopword-filtered token, so the canonical projection
    // carries exactly the source token stream and still scores 1.
    const fromObjects = evaluate(
      [record({ a: SOURCE_TEXT })],
      { decontamination: { corpus: CORPUS } },
    );
    assert.strictEqual(fromObjects.decisions[0].decision, 'withhold');
    assert.strictEqual(fromObjects.decisions[0].decontamination.score, 1);
  });

  test('does not mutate the records or the corpus it is handed', () => {
    const input = record(SOURCE_TEXT);
    const corpus = [...CORPUS];
    const before = JSON.stringify({ input, corpus });
    evaluate([input], { decontamination: { corpus } });
    assert.strictEqual(JSON.stringify({ input, corpus }), before);
  });
});

describe('query engine: contaminated records never occupy a page', () => {
  function contextWith(records) {
    const memories = new Map();
    for (const rec of records) memories.set(`${rec.workspaceId}:${rec.memoryId}`, rec);
    return { memories, isActiveRecord: (rec) => rec.status === 'active' };
  }

  function stored(memoryId, content) {
    return record(content, { memoryId, workspaceId: 'default', kind: 'memory-record' });
  }

  test('a leaked record is dropped before pagination and reported', () => {
    const result = runQuery(
      contextWith([stored('mem-leaked', SOURCE_TEXT), stored('mem-clean', 'deployment checklist for the canary rollout window')]),
      { recall: { currentTrustPolicyVersion: CURRENT_POLICY, decontamination: { corpus: CORPUS } } },
    );
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.memories.map((m) => m.memoryId), ['mem-clean']);
    assert.strictEqual(result.total, 1);
    assert.strictEqual(result.recall.withheld[0].memoryId, 'mem-leaked');
    assert.strictEqual(result.recall.withheld[0].reason, 'self_contamination');
  });
});
