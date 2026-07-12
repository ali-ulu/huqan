const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('./kernel');

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

// Test için temiz kernel — memory.json yüklemez
function freshKernel(opts = {}) {
  const kernel = new Kernel({ noLoad: true, ...opts });
  const learn = kernel.learn.bind(kernel);
  kernel.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return kernel;
}

describe('Kernel - Öğrenme', () => {
  it('learn: basit cümleyi parse edip grafiğe ekler', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    const n = k.graph.getNode('köpek');
    assert.ok(n);
    assert.strictEqual(n.label, 'köpek');
    const edges = k.graph.getEdges('köpek');
    assert.ok(edges.some(e => e.relation === 'tür' && e.to === 'hayvan'));
  });

  it('learn: aynı özne birden fazla yüklem alabilir', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    const edges = k.graph.getEdges('köpek');
    assert.ok(edges.some(e => e.relation === 'tür'));
    assert.ok(edges.some(e => e.relation === 'yapabilir' && e.to === 'havlar'));
  });

  it('learn: birden fazla kavram bağımsız eklenir', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Kedi hayvandır');
    k.learn('Kedi miyavlar');
    assert.ok(k.graph.getNode('köpek'));
    assert.ok(k.graph.getNode('kedi'));
    assert.ok(k.graph.getNode('hayvan'));
  });

  it('learn: "bir" artikeli atlanır', () => {
    const k = freshKernel();
    k.learn('Kedi bir memelilerdir');
    const edges = k.graph.getEdges('kedi');
    assert.ok(edges.some(e => e.relation === 'tür'));
  });

  it('learn: çoğul özne normalize edilir', () => {
    const k = freshKernel();
    k.learn('kediler hayvandır');
    // "kediler" → "kedi" normalize edilmeli
    const node = k.graph.getNode('kedi');
    assert.ok(node, 'kedi düğümü oluşmalı');
  });
});

describe('Kernel - Çıkarım', () => {
  it('ask: doğrudan ilişkiyi bulur', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    const cevap = k.ask('Köpek nedir').data.answer;
    assert.ok(cevap);
    assert.ok(cevap.includes('hayvan'));
  });

  it('ask: bilinmeyen kavram için "Bilmiyorum" döner', () => {
    const k = freshKernel();
    const cevap = k.ask('Uçan fil nedir').data.answer;
    assert.strictEqual(cevap, 'Bilmiyorum');
  });

  it('ask: transitivite ile dolaylı ilişki bulur', () => {
    const k = freshKernel();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    const cevap = k.ask('Köpek nedir').data.answer;
    assert.ok(cevap.includes('hayvan'));
  });

  it('ask: soru kelimesi temizlenir', () => {
    const k = freshKernel();
    k.learn('Kedi hayvandır');
    const cevap = k.ask('kedi nedir').data.answer;
    assert.ok(cevap !== 'Bilmiyorum');
    assert.ok(cevap.includes('hayvan'));
  });

  it('verify: explicit negation conflicts with known fact', () => {
    const k = freshKernel();
    k.learn('Kedi hayvandır');
    const result = k.verify('Kedi hayvan değildir');
    assert.strictEqual(result.data.status, 'celiski');
    assert.ok(result.evidence.length > 0);
  });

  it('verify: direct numeric comparisons are evaluated before partial matches', () => {
    const k = freshKernel();
    const trueComparison = k.verify('9 != 8');
    const falseComparison = k.verify('9 = 8');

    assert.strictEqual(trueComparison.data.status, 'dogrulandi');
    assert.ok(trueComparison.evidence.length > 0);
    assert.strictEqual(falseComparison.data.status, 'celiski');
    assert.ok(falseComparison.evidence.length > 0);
  });

  it('contradiction evidence keeps the underlying edge relation', () => {
    const k = freshKernel();
    k.learn('kiraci alt kiralayabilir');
    k.learn('kiraci alt kiralayamaz');
    const contradictionSource = k.detectContradictions().find(item => item.type === 'negasyon');
    const contradiction = k._contradictionEvidence(contradictionSource);
    assert.ok(contradiction);
    assert.ok(contradiction.text.length > 0);
    assert.ok(contradiction.nodes.includes('kiraci'));
    assert.ok(contradiction.edges.some(edge => edge.relation === 'değil' || edge.relation === 'yapabilir'));
  });
});

describe('Kernel - Bağlam Duyarlı Benzerlik', () => {
  it('contextSimilarity: aynı bağlamdaki kavramlar yüksek skor', () => {
    const k = freshKernel();
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    k.learn('Köpek hayvandır');
    k.learn('Kedi hayvandır');
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.graph.addTag('köpek', 'hayvan', 0.9);
    k.graph.addTag('kedi', 'hayvan', 0.9);
    k.graph.addTag('köpek', 'memeli', 0.8);
    k.graph.addTag('kedi', 'memeli', 0.8);
    k.graph.addTag('köpek', 'evcil', 0.7);
    k.graph.addTag('kedi', 'evcil', 0.7);

    const simHayvan = k.contextSimilarity('köpek', 'kedi', 'hayvan');
    const simRastgele = k.contextSimilarity('köpek', 'masa', 'hayvan');
    assert.ok(simHayvan > simRastgele);
    assert.ok(simHayvan > 0.5);
  });
});

describe('Kernel - Entropi', () => {
  it('entropy: boş graf sıfır entropi', () => {
    const k = freshKernel();
    assert.strictEqual(k.entropy(), 0);
  });

  it('entropy: bağlantılı düğüm pozitif entropi', () => {
    const k = freshKernel();
    // Direkt graph API ile kenar ekle — learn() NLP parsing'e bağımlı değil
    k.graph.addNode('a', 'a');
    k.graph.addNode('b', 'b');
    k.graph.addNode('c', 'c');
    k.graph.addEdge('a', 'b', 'tür');
    k.graph.addEdge('a', 'c', 'yapabilir');
    k.graph.addEdge('b', 'c', 'özellik');
    const s = k.entropy();
    assert.ok(s > 0, `Entropi pozitif olmalı, gelen: ${s}`);
  });
});

describe('Kernel - Boşluk Tespiti', () => {
  it('detectGaps: bağlantısız düğümleri bulur', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.graph.addNode('yalnız', 'tek başına');
    const gaps = k.detectGaps();
    assert.ok(gaps.length > 0);
    assert.ok(gaps.includes('yalnız'));
  });
});

describe('Kernel - Çelişki Tespiti', () => {
  it('detectContradictions: çoklu-tür çelişkisini bulur', () => {
    const k = freshKernel();
    k.graph.addNode('a', 'a');
    k.graph.addNode('b', 'b');
    k.graph.addNode('c', 'c');
    k.graph.addEdge('a', 'b', 'tür');
    k.graph.addEdge('a', 'c', 'tür');
    const cons = k.detectContradictions();
    const multiType = cons.find(c => c.type === 'çoklu-tür');
    assert.ok(multiType);
    assert.strictEqual(multiType.node, 'a');
  });

  it('detectContradictions: döngü çelişkisini bulur', () => {
    const k = freshKernel();
    k.graph.addNode('a', 'a');
    k.graph.addNode('b', 'b');
    k.graph.addEdge('a', 'b', 'tür');
    k.graph.addEdge('b', 'a', 'tür');
    const cons = k.detectContradictions();
    const cycle = cons.find(c => c.type === 'döngü');
    assert.ok(cycle);
  });

  it('detectContradictions: çelişkisiz graf boş dizi döndürür', () => {
    const k = freshKernel();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    const cons = k.detectContradictions();
    assert.ok(Array.isArray(cons));
    assert.strictEqual(cons.length, 0);
  });

  it('detectContradictions: sayisal contradiction carries concrete edges', () => {
    const k = freshKernel();
    k.learn('depozito en fazla 3 aylik kira bedelidir');
    k.learn('depozito en fazla 6 aylik kira bedelidir');
    const cons = k.detectContradictions();
    const numeric = cons.find(c => c.type === 'sayısal');
    assert.ok(numeric);
    assert.ok(Array.isArray(numeric.edges));
    assert.strictEqual(numeric.edges.length, 2);
  });
});

describe('Kernel - Reason & Compare', () => {
  it('reason: ileri ve geri zincir döner', () => {
    const k = freshKernel();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    const r = k.reason('köpek').data.answer;
    assert.ok(r !== 'Bilmiyorum');
    assert.ok(r.includes('köpek'));
  });

  it('compare: ortak özellikleri bulur', () => {
    const k = freshKernel();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    const r = k.compare('köpek', 'kedi').data.answer;
    assert.ok(r.includes('ortak'));
  });
});


describe('Kernel - Core API Contract', () => {
  function assertEnvelope(result, type) {
    assert.strictEqual(typeof result.ok, 'boolean');
    assert.strictEqual(result.type, type);
    assert.ok('data' in result);
    assert.ok(Array.isArray(result.evidence));
    assert.ok('error' in result);
    assert.ok(result.meta && typeof result.meta === 'object');
  }

  it('public methods return the structured envelope', () => {
    const k = freshKernel();
    k.learn('kedi hayvandir');
    assertEnvelope(k.learn('kopek hayvandir'), 'learn');
    const askResult = k.ask('kedi nedir');
    const verifyResult = k.verify('kedi hayvandir');
    assertEnvelope(askResult, 'ask');
    assertEnvelope(verifyResult, 'verify');
    assertEnvelope(k.reason('kedi'), 'reason');
    assertEnvelope(k.compare('kedi', 'kopek'), 'compare');
    assertEnvelope(k.dream(), 'dream');
    assert.strictEqual(askResult.meta.contractVersion, Kernel.CONTRACT_VERSION);
    assert.strictEqual(verifyResult.meta.contractVersion, Kernel.CONTRACT_VERSION);
    assert.strictEqual(verifyResult.meta.paranoidMode, false);
  });

  it('validateResult catches invalid result shapes', () => {
    const k = freshKernel();
    assert.throws(() => k._validateResult({ ok: 'yes', evidence: [] }), /ok must be boolean/);
    assert.throws(() => k._validateResult({ ok: true, evidence: null }), /evidence must be array/);
    assert.throws(() => k._validateResult({ ok: true, type: 'verify', data: { status: 'bad', confidence: 0 }, evidence: [] }), /Invalid verify status/);
    assert.throws(() => k._validateResult({ ok: true, type: 'verify', data: { status: 'dogrulandi', confidence: 2 }, evidence: [] }), /Invalid confidence/);
  });

  it('normalizes Istanbul dotted and dotless variants to one node', () => {
    const k = freshKernel();
    k.learn('\u0130STANBUL sehirdir');
    k.learn('\u0131stanbul buyuktur');
    k.learn('istanbul kalabaliktir');
    assert.ok(k.graph.getNode('istanbul'));
    assert.strictEqual(k.graph.getNode('\u0131stanbul'), null);
    assert.ok(k.graph.getEdges('istanbul').length >= 3);
  });

  it('keeps other Turkish letters instead of transliterating them', () => {
    const k = freshKernel();
    k.learn('k\u00f6pek hayvandir');
    k.learn('\u00e7ocuk insandir');
    k.learn('\u00f6\u011frenme surectir');
    assert.ok(k.graph.getNode('k\u00f6pek'));
    assert.ok(k.graph.getNode('\u00e7ocuk'));
    assert.ok(k.graph.getNode('\u00f6\u011frenme'));
    assert.strictEqual(k.graph.getNode('kopek'), null);
    assert.strictEqual(k.graph.getNode('cocuk'), null);
    assert.strictEqual(k.graph.getNode('ogrenme'), null);
  });

  it('paranoidMode blocks learnFromLLM with a typed error', () => {
    const k = freshKernel({ paranoidMode: true });
    const result = k.learnFromLLM('kedi hayvandir');
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.error.code, Kernel.AXIOM_ERROR.LLM_DISABLED);
    assert.strictEqual(result.learned, 0);
    assert.strictEqual(result.skipped, 0);
    assert.strictEqual(result.meta.contractVersion, Kernel.CONTRACT_VERSION);
    assert.strictEqual(result.meta.paranoidMode, true);
  });

  it('exports error catalog and contract version on the class', () => {
    assert.strictEqual(Kernel.CONTRACT_VERSION, '1.0.0');
    assert.ok(Kernel.AXIOM_ERROR);
    assert.strictEqual(Kernel.AXIOM_ERROR.LLM_DISABLED, 'LLM_DISABLED');
  });
});

describe('Kernel - Capability System', () => {
  it('defaults expose the planned core capability set', () => {
    const k = freshKernel();
    assert.strictEqual(k.hasCapability('graph'), true);
    assert.strictEqual(k.hasCapability('llm'), true);
    assert.strictEqual(k.hasCapability('contradictionDetection'), true);
    assert.strictEqual(k.hasCapability('temporal'), false);
    assert.strictEqual(k.hasCapability('pluginCapabilities'), false);
    assert.strictEqual(k.hasCapability('evidenceRanking'), false);
  });

  it('enableCapability: toggles a capability on', () => {
    const k = freshKernel();
    assert.strictEqual(k.hasCapability('temporal'), false);
    assert.strictEqual(k.enableCapability('temporal'), true);
    assert.strictEqual(k.hasCapability('temporal'), true);
  });

  it('requireCapability: throws for missing capabilities', () => {
    const k = freshKernel();
    assert.throws(() => k.requireCapability('temporal'), /Required capability is not enabled: temporal/);
    k.enableCapability('temporal');
    assert.strictEqual(k.requireCapability('temporal'), true);
  });
});

describe('Kernel - Dream hypothesis regressions', () => {
  it('selfEvolve maps vektör-benzerlik to benzer without a relation field', () => {
    const kernel = freshKernel({ useSQLite: false, loadPlugins: false });
    const Dream = require('./dream');
    const originalDream = Dream.prototype.dream;
    const originalCommit = kernel._commitBackgroundEdge;
    const proposedRelations = [];

    Dream.prototype.dream = function () {
      return [{
        from: 'kaynak',
        to: 'hedef',
        type: 'vektör-benzerlik',
        confidence: 0.9,
      }];
    };
    kernel._commitBackgroundEdge = function (from, to, relation) {
      proposedRelations.push({ from, to, relation });
      return { decision: 'review', edge: null };
    };

    try {
      const result = kernel.selfEvolve();
      assert.deepStrictEqual(proposedRelations, [{
        from: 'kaynak',
        to: 'hedef',
        relation: 'benzer',
      }]);
      assert.strictEqual(result.deferred, 1);
      assert.strictEqual(result.deferredDetails[0].relation, 'benzer');
    } finally {
      Dream.prototype.dream = originalDream;
      kernel._commitBackgroundEdge = originalCommit;
    }
  });

  it('introspect recognizes the canonical rüya self node', () => {
    const kernel = freshKernel({ useSQLite: false, loadPlugins: false });
    kernel.graph.addNode('rüya', null, 'default');

    const result = kernel.introspect();

    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.data.ozBilgi.rüya, { var: true, kenar: 0 });
    assert.strictEqual(Object.hasOwn(result.data.ozBilgi, 'r?ya'), false);
  });
});
