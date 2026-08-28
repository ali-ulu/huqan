const { describe, it } = require('node:test');
const assert = require('node:assert');
const Kernel = require('../kernel');
const Dream = require('../dream');
const { isEligibleHypothesisNode } = require('../lib/dream-hypothesis-semantics');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function fresh() {
  const k = new Kernel({ noLoad: true });
  const learn = k.learn.bind(k);
  k.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return { k, d: new Dream(k) };
}

describe('#1643 - dream hipotez kalitesi: düğüm uygunluk kapısı', () => {
  it('isEligibleHypothesisNode: noktalama/artık etiketleri elenir', () => {
    assert.strictEqual(isEligibleHypothesisNode('|'), false);
    assert.strictEqual(isEligibleHypothesisNode('||'), false);
    assert.strictEqual(isEligibleHypothesisNode('---'), false);
    assert.strictEqual(isEligibleHypothesisNode(''), false);
    assert.strictEqual(isEligibleHypothesisNode(null), false);
  });

  it('isEligibleHypothesisNode: id benzeri sayısal etiketler elenir', () => {
    assert.strictEqual(isEligibleHypothesisNode('93172327986'), false);
    assert.strictEqual(isEligibleHypothesisNode('#2'), false);
    assert.strictEqual(isEligibleHypothesisNode('pr | #2 |'), false);
  });
  it('isEligibleHypothesisNode: meşru kısa Türkçe kelime ve cümleler geçer', () => {
    assert.strictEqual(isEligibleHypothesisNode('köpek'), true);
    assert.strictEqual(isEligibleHypothesisNode('ağaç'), true);
    assert.strictEqual(isEligibleHypothesisNode('npm test job başarılı'), true);
    assert.strictEqual(isEligibleHypothesisNode('self-healer loop nedir?'), true);
  });

  it('dream: gürültü düğümleri hipotez kaynağı olamaz', () => {
    const { k, d } = fresh();
    // Anlamlı kavram çifti
    k.learn('Köpek hayvandır');
    k.learn('Kedi hayvandır');
    // Gürültü: markdown tablo artığı ve CI log id'si (doğrudan graf düğümü olarak)
    k.graph.addNode('|', '|', null, {});
    k.graph.addNode('93172327986', '93172327986', null, {});
    k.graph.addEdge('|', '93172327986', 'ilişkili');

    const hyps = d.dream();
    for (const h of hyps) {
      const sources = [h.from, h.to, h.node, ...(h.targets || [])].filter(Boolean);
      for (const s of sources) {
        assert.ok(
          isEligibleHypothesisNode(s),
          `gürültü kaynak: ${JSON.stringify(s)} -> ${JSON.stringify(h)}`,
        );
      }
    }
  });

  it('dream: sadece sayıyla farklılaşan çelişki hedefleri gürültü sayılır', () => {
    const { k, d } = fresh();
    k.learn('Köpek hayvandır');
    // CI log kalıbı: aynı satır, farklı job id
    k.detectContradictions = () => [
      { node: 'npm test job durumu', targets: ['20 npm test job 111 success', '22 npm test job 222 success'], confidence: 0.75 },
      { node: 'kavram çatışması', targets: ['köpek bir kuştur', 'köpek bir balıktır'], confidence: 0.75 },
    ];
    const hyps = d.dream().filter(h => h.type === 'çelişki');
    const nodes = hyps.map(h => h.node);
    assert.ok(nodes.includes('kavram çatışması'), 'gerçek çelişki korunmalı');
    assert.ok(!nodes.includes('npm test job durumu'), 'id varyantı çelişkisi elenmeli');
  });

  it('dream: anlamlı corpus ile hipotez üretmeye devam eder', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    const hyps = d.dream();
    assert.ok(Array.isArray(hyps));
    // Kalite kapısı anlamlı düğümleri engellemez: en azından bozulma yok
    assert.ok(hyps.length > 0, 'anlamlı düğümlerden hipotez üretilmeli');
  });
});
