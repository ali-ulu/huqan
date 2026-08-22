'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');

function seededKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-verify-substring-'));
  const kernel = new Kernel({
    memoryPath: path.join(dir, 'memory.json'),
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
  });
  kernel.graph.addNode('kedi', 'kedi');
  kernel.graph.addNode('hayvan', 'hayvan');
  kernel.graph.addEdge('kedi', 'hayvan', 'tür', { confidence: 0.9 });
  return { kernel, dir };
}

function citedEdgeTargets(result) {
  return (result.evidence || []).flatMap(item => (item.edges || []).map(edge => edge.to));
}

describe('verify: substring matching must not fabricate contradictions (#1032)', () => {
  it('the negation branch still contradicts a real negation', () => {
    const { kernel, dir } = seededKernel();
    const result = kernel.verify('kedi hayvan değildir');

    assert.strictEqual(result.data.status, 'contradicted');
    assert.ok(result.data.confidence >= 0.8, `confidence was ${result.data.confidence}`);
    assert.deepStrictEqual(citedEdgeTargets(result), ['hayvan']);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the negation branch no longer contradicts a substring of a known target', () => {
    // `e.to.includes(posNorm)` had no word boundary, so "kedi a değildir" was
    // refuted at 0.9 because `hayvan` contains an `a` — citing the unrelated
    // `tür` edge as the evidence that went into the Trust Receipt.
    const { kernel, dir } = seededKernel();

    for (const statement of ['kedi hay değildir', 'kedi h değildir', 'kedi a değildir', 'kedi ay değildir']) {
      const result = kernel.verify(statement);
      assert.notStrictEqual(result.data.status, 'contradicted', statement);
      assert.deepStrictEqual(citedEdgeTargets(result), [], `${statement} must cite no edge`);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('the partial-match branch no longer cites an unrelated edge on letter overlap', () => {
    // 'a', 'ay' and 'van' are each a substring of `hayvan`, so the edge matched
    // and the semantic signals then produced a 0.75 contradiction citing it.
    //
    // Note: these statements can still come back `contradicted` at 0.6 with no
    // evidence. That verdict comes from buildVerifySemanticTrust's edge loop,
    // which fires for any statement about a subject that has edges at all —
    // `kedi qqq www`, with no letter overlap whatsoever, behaves identically
    // and did so before this change too. It is a separate defect. What this
    // test pins is that no *edge-citing evidence* is fabricated from a letter
    // coincidence.
    const { kernel, dir } = seededKernel();

    for (const statement of ['kedi a sever', 'kedi ay yer', 'kedi van gogh']) {
      const result = kernel.verify(statement);
      assert.deepStrictEqual(citedEdgeTargets(result), [], `${statement} must cite no edge`);
      assert.ok(result.data.confidence < 0.75, `${statement} confidence was ${result.data.confidence}`);
    }

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a genuine four-character-or-longer overlap still matches', () => {
    // phraseMatches keeps substring matching above a four-character floor, so
    // real morphological variation is not lost — only letter coincidences are.
    const { kernel, dir } = seededKernel();
    const result = kernel.verify('kedi hayvanlar değildir');

    assert.strictEqual(result.data.status, 'contradicted');
    assert.deepStrictEqual(citedEdgeTargets(result), ['hayvan']);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
