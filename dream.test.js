const { describe, it } = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const Kernel = require('./kernel');
const Dream = require('./dream');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function fresh() {
  // Isolated journal per test: dream tests mutate the durable JSON mutation
  // journal, and sharing the repo's real memory.json/memory.mutations.json
  // would both pollute user data and let stale locks from an aborted run
  // wedge every subsequent test (see lib/mutation-journal-lock.js).
  const iso = path.join(os.tmpdir(), `huqan-dream-test-${process.pid}-${crypto.randomUUID()}`);
  const k = new Kernel({ noLoad: true, memoryPath: iso });
  const learn = k.learn.bind(k);
  k.learn = (text, learnOpts = {}) => learn(text, { ...learnOpts, ...TEST_FIXTURE_LEARN_BYPASS });
  return { k, d: new Dream(k) };
}

describe('Dream - Hayal Kurma', () => {
  it('dream: boş graf hatasız çalışır', () => {
    const { d } = fresh();
    assert.ok(Array.isArray(d.dream()));
  });

  it('dream: bilgi varken hipotez üretir', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    assert.ok(Array.isArray(d.dream()));
  });
});

describe('Dream - Amplifikasyon', () => {
  it('amplify: doğru cevabın weighti en yüksek olur', () => {
    const { k, d } = fresh();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    k.learn('Köpek memelidir');

    const before = k.graph.getEdge('köpek', 'hayvan', 'tür').weight;
    const result = d.amplify('köpek', ['hayvan', 'uçar', 'yeşil'], 'tür');
    const after = k.graph.getEdge('köpek', 'hayvan', 'tür').weight;

    assert.ok(result.length > 0);
    assert.strictEqual(result[0], 'hayvan');
    assert.ok(after >= before);
  });
});

describe('Dream - Simülasyon', () => {
  it('simulate: en iyi 2 cevabı skorla döndürür', () => {
    const { k, d } = fresh();
    k.learn('Köpek hayvandır');
    k.learn('Köpek havlar');
    k.learn('Köpek memelidir');
    k.learn('Köpek dörtayaklıdır');

    const result = d.simulate('köpek');
    assert.ok(result.length >= 2);
    assert.ok(result[0].score >= result[1].score);
    assert.ok(result.every(r => r.answer && typeof r.score === 'number'));
  });
});

describe('Dream - Doğruluk Testi', () => {
  it('verify: grafikte kanıtlanmış bilgi doğrudur', () => {
    const { k, d } = fresh();
    k.learn('Köpek hayvandır');
    const v = d.verify('köpek', 'hayvan');
    assert.ok(v.valid);
    assert.ok(v.confidence > 0);
  });

  it('verify: grafikte olmayan bilgi yanlıştır', () => {
    const { k, d } = fresh();
    k.learn('Köpek hayvandır');
    const v = d.verify('köpek', 'uçar');
    assert.strictEqual(v.valid, false);
    assert.strictEqual(v.confidence, 0);
  });

  it('verify: zincirleme kanıt bulur', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    const v = d.verify('köpek', 'hayvan');
    assert.ok(v.valid);
    assert.ok(v.path.length > 1);
  });
});

describe('Dream - Rastgele Yürüyüş', () => {
  it('walk: düğümler arasında yol bulur', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    k.learn('Hayvan canlıdır');
    const path = d.walk('köpek', 3);
    assert.ok(path.length > 0);
    assert.strictEqual(path[0], 'köpek');
  });

  it('walk: derinlik sınırına uyar', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Memeli hayvandır');
    k.learn('Hayvan canlıdır');
    const path = d.walk('köpek', 1);
    assert.ok(path.length <= 2);
  });
});

describe('Dream - Node2Vec Gömmeler', () => {
  it('embedding: boş graf null döner', () => {
    const { d } = fresh();
    assert.strictEqual(d.embedding(), null);
  });

  it('embedding: tek düğüm null döner', () => {
    const { d } = fresh();
    d.graph.addNode('test', 'test'); // label zorunlu
    assert.strictEqual(d.embedding(), null);
  });

  it('projection weights cover both signs within the documented range (#1046)', () => {
    const { d } = fresh();
    const weights = [];
    for (let i = 0; i < 512; i++) weights.push(d._projectionWeight(`node-${i}`, i % 64, 64));
    assert.ok(weights.every((weight) => weight >= -1 && weight < 1));
    assert.ok(weights.some((weight) => weight < 0));
    assert.ok(weights.some((weight) => weight > 0));
  });

  it('embedding: düğümlere vektör atar', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Kuş uçar');
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    const r = d.embedding({ walksPerNode: 5, walkLength: 10 });
    assert.ok(r);
    assert.strictEqual(r.nodes, Object.keys(k.graph._nodes).length);
    for (const id of Object.keys(k.graph._nodes)) {
      assert.ok(k.graph._nodes[id].embedding, `node ${id} has embedding`);
      assert.strictEqual(k.graph._nodes[id].embedding.length, 64);
    }
  });

  it('nodeSimilarity: bağlantılı kavramlar yüksek skor', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');
    k.learn('Aslan memelidir');
    k.learn('Aslan kükrer');
    d.embedding({ walksPerNode: 8, walkLength: 15 });
    const sim = d.nodeSimilarity('köpek', 'kedi');
    assert.ok(sim > 0, `köpek-kedi similarity: ${sim}`);
  });

  it('embedding: varsayılan random walk aynı graph için deterministiktir', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Köpek havlar');
    k.learn('Kedi miyavlar');

    const options = { walksPerNode: 8, walkLength: 15 };
    d.embedding(options);
    const first = Object.fromEntries(
      Object.entries(k.graph._nodes).map(([id, node]) => [id, Array.from(node.embedding)]),
    );
    d.embedding(options);
    const second = Object.fromEntries(
      Object.entries(k.graph._nodes).map(([id, node]) => [id, Array.from(node.embedding)]),
    );

    assert.deepStrictEqual(second, first);
  });

  it('nodeSimilarity: ilgisiz kavramlar düşük skor', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Elma meyvedir');
    k.learn('Armut meyvedir');
    d.embedding({ walksPerNode: 8, walkLength: 10 });
    const simRelated = d.nodeSimilarity('köpek', 'kedi');
    const simUnrelated = d.nodeSimilarity('köpek', 'elma');
    assert.ok(simUnrelated <= simRelated + 0.2 || simRelated > 0,
      `related=${simRelated} unrelated=${simUnrelated}`);
  });

  it('findSimilar: en yakın komşuları bulur', () => {
    const { k, d } = fresh();
    k.learn('Köpek memelidir');
    k.learn('Kedi memelidir');
    k.learn('Aslan memelidir');
    k.learn('Balık yüzer');
    k.learn('Kuş uçar');
    d.embedding({ walksPerNode: 8, walkLength: 15 });
    const similar = d.findSimilar('köpek', 2);
    assert.ok(similar.length > 0);
    assert.ok(similar.every(s => s.id && typeof s.score === 'number'));
  });

  it('embedding: özel boyut sayısına saygı gösterir', () => {
    const { k, d } = fresh();
    k.learn('A Bdir');
    k.learn('A Cdir');
    const r = d.embedding({ dimensions: 16, walksPerNode: 3, walkLength: 5 });
    assert.strictEqual(r.dimensions, 16);
    for (const id of Object.keys(k.graph._nodes)) {
      assert.strictEqual(k.graph._nodes[id].embedding.length, 16);
    }
  });

  it('embedding: simetrik düğümleri aynı vektöre kilitlemez', () => {
    const { k, d } = fresh();
    k.learn('Kedi memelidir');
    k.learn('Köpek memelidir');
    k.learn('Aslan memelidir');
    k.learn('Kedi avlanır');
    k.learn('Köpek havlar');
    k.learn('Aslan kükrer');

    d.embedding({ walksPerNode: 8, walkLength: 15 });

    const kedi = Array.from(k.graph._nodes['kedi'].embedding);
    const kopek = Array.from(k.graph._nodes['köpek'].embedding);
    const aslan = Array.from(k.graph._nodes['aslan'].embedding);

    assert.notDeepStrictEqual(kedi, kopek);
    assert.notDeepStrictEqual(kopek, aslan);
    assert.notDeepStrictEqual(kedi, aslan);
  });

  it('embedding: before hook always, after hook only on success', () => {
    const { d } = fresh();
    const events = [];
    d.kernel.plugins.emit = event => events.push(event);

    assert.strictEqual(d.embedding(), null);
    assert.deepStrictEqual(events, ['beforeEmbedding']);

    d.graph.addNode('a', 'a');
    d.graph.addNode('b', 'b');
    assert.ok(d.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 }));
    assert.deepStrictEqual(events, [
      'beforeEmbedding',
      'beforeEmbedding',
      'afterEmbedding',
    ]);
  });

  it('embedding: processes all workspace nodes in global storage insertion order', () => {
    const { d } = fresh();
    d.graph.addNode('shared', 'first', null, { workspaceId: 'one' });
    d.graph.addNode('shared', 'second', null, { workspaceId: 'two' });
    const storageOrder = Object.keys(d.graph._nodes);
    const walkStarts = [];
    d._biasedWalk = start => {
      walkStarts.push(start);
      return [start];
    };

    const result = d.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 });

    assert.strictEqual(result.nodes, 2);
    assert.deepStrictEqual(walkStarts, storageOrder);
    for (const storageKey of storageOrder) {
      assert.ok(d.graph._nodes[storageKey].embedding instanceof Float64Array);
    }
  });

  it('embedding: preserves node identity, replaces embedding, and avoids graph access', () => {
    const { d } = fresh();
    d.graph.addNode('a', 'a');
    d.graph.addNode('b', 'b');
    const storageOrder = Object.keys(d.graph._nodes);
    const nodeRefs = Object.fromEntries(storageOrder.map(key => [key, d.graph._nodes[key]]));
    const previousEmbeddings = Object.fromEntries(storageOrder.map(key => {
      const embedding = new Float64Array([1, 2]);
      d.graph._nodes[key].embedding = embedding;
      return [key, embedding];
    }));
    let getNodeCalls = 0;
    let saveCalls = 0;
    d.graph.getNode = () => {
      getNodeCalls++;
      return null;
    };
    d.graph.save = () => {
      saveCalls++;
    };

    d.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 });

    assert.strictEqual(getNodeCalls, 0);
    assert.strictEqual(saveCalls, 0);
    for (const storageKey of storageOrder) {
      const node = d.graph._nodes[storageKey];
      assert.strictEqual(node, nodeRefs[storageKey]);
      assert.notStrictEqual(node.embedding, previousEmbeddings[storageKey]);
      assert.ok(node.embedding instanceof Float64Array);
      assert.strictEqual(node.embedding.length, 4);
    }
  });

  it('embedding: after hook failure leaves assigned embeddings without rollback', () => {
    const { d } = fresh();
    d.graph.addNode('a', 'a');
    d.graph.addNode('b', 'b');
    const storageOrder = Object.keys(d.graph._nodes);
    const previousEmbeddings = Object.fromEntries(storageOrder.map(key => {
      const embedding = new Float64Array([3, 4]);
      d.graph._nodes[key].embedding = embedding;
      return [key, embedding];
    }));
    d.kernel.plugins.emit = event => {
      if (event === 'afterEmbedding') throw new Error('afterEmbedding failed');
    };

    assert.throws(
      () => d.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 }),
      /afterEmbedding failed/
    );
    for (const storageKey of storageOrder) {
      const embedding = d.graph._nodes[storageKey].embedding;
      assert.notStrictEqual(embedding, previousEmbeddings[storageKey]);
      assert.ok(embedding instanceof Float64Array);
      assert.strictEqual(embedding.length, 4);
    }
  });

  it('embedding: computation failure keeps earlier assignments without rollback', () => {
    const { d } = fresh();
    d.graph.addNode('a', 'a');
    d.graph.addNode('b', 'b');
    d.graph.addNode('c', 'c');
    const storageOrder = Object.keys(d.graph._nodes);
    const previousEmbeddings = Object.fromEntries(storageOrder.map(key => {
      const embedding = new Float64Array([5, 6]);
      d.graph._nodes[key].embedding = embedding;
      return [key, embedding];
    }));
    const secondNode = d.graph._nodes[storageOrder[1]];
    const originalSignature = d._nodeSignatureWeight.bind(d);
    const events = [];
    d.kernel.plugins.emit = event => events.push(event);
    d._nodeSignatureWeight = (node, ...args) => {
      if (node === secondNode) throw new Error('projection failed');
      return originalSignature(node, ...args);
    };

    assert.throws(
      () => d.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 }),
      /projection failed/
    );
    assert.notStrictEqual(d.graph._nodes[storageOrder[0]].embedding, previousEmbeddings[storageOrder[0]]);
    assert.strictEqual(d.graph._nodes[storageOrder[1]].embedding, previousEmbeddings[storageOrder[1]]);
    assert.strictEqual(d.graph._nodes[storageOrder[2]].embedding, previousEmbeddings[storageOrder[2]]);
    assert.deepStrictEqual(events, ['beforeEmbedding']);
  });

  it('embedding: delegates each computed vector once in storage-key order', () => {
    const { d } = fresh();
    d.graph.addNode('shared', 'first', null, { workspaceId: 'one' });
    d.graph.addNode('shared', 'second', null, { workspaceId: 'two' });
    const storageOrder = Object.keys(d.graph._nodes);
    const assignments = [];
    d.graph._assignEmbedding = (storageKey, embedding) => {
      assignments.push({ storageKey, embedding });
    };

    const result = d.embedding({ dimensions: 4, walksPerNode: 1, walkLength: 1 });

    assert.deepStrictEqual(assignments.map(({ storageKey }) => storageKey), storageOrder);
    assert.strictEqual(assignments.length, storageOrder.length);
    for (const { embedding } of assignments) {
      assert.ok(embedding instanceof Float64Array);
      assert.strictEqual(embedding.length, 4);
    }
    assert.deepStrictEqual(result, { dimensions: 4, nodes: storageOrder.length });
  });
});

describe('Dream - Gelişmiş Skorlama ve Sıralama', () => {
  it('dream: çelişkiler her zaman en üstte yer alır', () => {
    const { k, d } = fresh();
    // Bir çelişki üretmek için kernel.detectContradictions'ı mock'layalım
    k.detectContradictions = () => [
      { node: 'armut', targets: ['bal'], confidence: 0.1 } // Çok düşük confidence
    ];
    
    // Çok yüksek confidence'lı diğer hipotezleri üretmek için veri ekleyelim
    k.learn('X Ydir');
    k.learn('Z Ydir');
    
    const results = d.dream();
    
    assert.strictEqual(results[0].type, 'çelişki', 'İlk sonuç mutlaka çelişki olmalı');
    assert.strictEqual(results[0].node, 'armut');
  });

  it('dream: novelty (yenilik) skoru sıralamayı etkiler', () => {
    const { k, d } = fresh();
    
    // Yuklemler gercek Turkce kopula tasiyor: "cdir" gibi tek harfli koku olan
    // sentetik bicimler artik `tur` kenari uretmiyor, cunku kopula soyma bir
    // asgari kok uzunlugu ariyor (#1195). Testin kurgusu ayni: iki cift, ikisi
    // de ortak komsu paylasiyor, biri kendi arasinda zaten bagli.
    //
    // 1. ali ve ayse: Ortak komşuları var ama aralarında zaten bağ var (Novelty = 0)
    k.learn('ali cevizdir');
    k.learn('ayse cevizdir');
    k.learn('ali aysedir');

    // 2. deniz ve emre: Ortak komşuları var ve aralarında bağ yok (Novelty = 1)
    k.learn('deniz gemidir');
    k.learn('emre gemidir');

    const results = d.dream();
    const hypAB = results.find(h => (h.from === 'ali' && h.to === 'ayse') || (h.from === 'ayse' && h.to === 'ali'));
    const hypDE = results.find(h => (h.from === 'deniz' && h.to === 'emre') || (h.from === 'emre' && h.to === 'deniz'));
    
    assert.ok(hypAB, 'A-B hipotezi üretilmeli');
    assert.ok(hypDE, 'D-E hipotezi üretilmeli');
    assert.ok(hypDE.novelty > hypAB.novelty, `DE novelty(${hypDE.novelty}) > AB novelty(${hypAB.novelty}) olmalı`);
    
    // DE daha novel (özgün) olduğu için skoru AB'den yüksek olmalı
    assert.ok(hypDE.score > hypAB.score, `DE score(${hypDE.score}) > AB score(${hypAB.score}) olmalı`);
  });

  it('dream: usefulness (degree) skoru sıralamayı etkiler', () => {
    const { k, d } = fresh();
    
    // Sentetik tek harfli kokler yerine gercek kopula tasiyan yuklemler (#1195).
    // 1. ali -> ayse -> ceviz (ali düşük degree: sadece 1 çıkış)
    k.learn('ali aysedir');
    k.learn('ayse cevizdir');

    // 2. ozan -> selin -> gemi (ozan yüksek degree: 4 çıkış)
    k.learn('ozan selindir');
    k.learn('selin gemidir');
    k.learn('ozan kalemdir');
    k.learn('ozan yesimdir');
    k.learn('ozan denizdir');
    
    // Ortalama degree'i yükseltmek için ek düğümler
    for (let i = 0; i < 20; i++) {
      k.learn(`d${i} base`);
    }
    
    const results = d.dream();
    
    // Zincir hipotezleri: ali->ceviz (ayse uzerinden) ve ozan->gemi (selin uzerinden)
    const hypAC = results.find(h => h.from === 'ali' && h.to === 'ceviz' && h.type === 'zincir');
    const hypXZ = results.find(h => h.from === 'ozan' && h.to === 'gemi' && h.type === 'zincir');
    
    assert.ok(hypAC, 'A->C zincir hipotezi üretilmeli');
    assert.ok(hypXZ, 'X->Z zincir hipotezi üretilmeli');
    assert.ok(hypXZ.usefulness > hypAC.usefulness,
      `XZ usefulness(${hypXZ.usefulness}) > AC usefulness(${hypAC.usefulness}) olmalı`);
    assert.ok(hypXZ.score > hypAC.score,
      `XZ score(${hypXZ.score}) > AC score(${hypAC.score}) olmalı`);
  });

  it('dream: sonuç sayısı toplamda 10 ile sınırlıdır', () => {
    const { k, d } = fresh();
    for(let i=0; i<20; i++) {
      k.learn(`node${i} common`);
    }
    
    const results = d.dream();
    assert.strictEqual(results.length, 10, `Sonuç sayısı tam 10 olmalı, bulundu: ${results.length}`);
  });

  it('dream: finderlar soft cap (50) limitine uyar', () => {
    const { k, d } = fresh();
    for(let i=0; i<100; i++) {
      k.learn(`node${i} common`);
    }
    const results = d.dream();
    assert.strictEqual(results.length, 10);
  });

  it('dream: adversarial empty comparisons stay within the fixed work budget', () => {
    const { k, d } = fresh();
    for (let i = 0; i < 500; i++) d.graph.addNode(`isolated-${i}`, `isolated-${i}`);

    const calls = { getEdges: 0, getInEdges: 0, cosineSimilarity: 0 };
    for (const method of Object.keys(calls)) {
      const original = d.graph[method].bind(d.graph);
      d.graph[method] = (...args) => {
        calls[method]++;
        return original(...args);
      };
    }
    k.detectGaps = () => [];
    k.detectContradictions = () => [];

    assert.deepStrictEqual(d.dream(), []);
    assert.ok(calls.cosineSimilarity <= 10_000, `cosine calls exceeded budget: ${calls.cosineSimilarity}`);
    assert.ok(calls.getEdges <= 500, `out-edge reads were not pre-indexed: ${calls.getEdges}`);
    assert.ok(calls.getInEdges <= 500, `in-edge reads were not pre-indexed: ${calls.getInEdges}`);
  });

  it('dream: indexed execution preserves deterministic hypothesis output', () => {
    const { k, d } = fresh();
    k.learn('a cdir');
    k.learn('b cdir');
    k.learn('a ddir');
    k.learn('d edir');
    k.detectGaps = () => [];
    k.detectContradictions = () => [];

    const first = d.dream();
    const second = d.dream();

    assert.deepStrictEqual(second, first);
  });
});

