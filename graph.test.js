const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const Graph = require('./graph');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('Graph - Düğüm Yönetimi', () => {
  let g;

  it('addNode: yeni düğüm oluşturur, weight=0.5', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    const n = g.getNode('köpek');
    assert.ok(n);
    assert.strictEqual(n.label, 'hayvan');
    assert.strictEqual(n.weight, 0.5);
    assert.deepStrictEqual(n.tags, []);
  });

  it('addNode: aynı id label günceller, weight artar', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    g.addNode('köpek', 'memeli hayvan');
    const n = g.getNode('köpek');
    assert.strictEqual(n.label, 'memeli hayvan');
    assert.ok(n.weight > 0.5);
  });

  it('getNode: olmayan id null döner', () => {
    g = new Graph({ useSQLite: false });
    assert.strictEqual(g.getNode('olmayan'), null);
  });
});

describe('Graph - Kenar Yönetimi', () => {
  let g;

  it('addEdge: kenar oluşturur, weight=0.5', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    g.addNode('memeli', 'sınıf');
    g.addEdge('köpek', 'memeli', 'tür');
    const edges = g.getEdges('köpek');
    assert.ok(edges.length > 0);
    const e = edges.find(x => x.relation === 'tür');
    assert.ok(e);
    assert.strictEqual(e.weight, 0.5);
  });

  it('addEdge: aynı kenar tekrarı weight artırır (tavan 1.0)', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    const w1 = g.getEdge('a', 'b', 'bag').weight;
    g.addEdge('a', 'b', 'bag');
    const w2 = g.getEdge('a', 'b', 'bag').weight;
    assert.ok(w2 > w1);
    assert.ok(w2 <= 1.0);
  });

  it('getEdge: olmayan kenar null döner', () => {
    g = new Graph({ useSQLite: false });
    assert.strictEqual(g.getEdge('x', 'y', 'z'), null);
  });

  it('getEdge returns a defensive copy', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    const edge = g.getEdge('a', 'b', 'bag');
    edge.weight = 0.001;
    const again = g.getEdge('a', 'b', 'bag');
    assert.notStrictEqual(again.weight, 0.001);
  });

  it('getEdgesBetween: iki düğüm arasındaki tüm kenarları döndürür', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'tür');
    g.addEdge('a', 'b', 'benzer');
    const edges = g.getEdgesBetween('a', 'b');
    assert.strictEqual(edges.length, 2);
  });

  it('getEdgesBetween: kenar yoksa boş dizi döner', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    assert.deepStrictEqual(g.getEdgesBetween('a', 'b'), []);
  });

  it('hasAnyEdge: iki düğüm arasında en az bir kenar varsa true', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'tür');
    assert.strictEqual(g.hasAnyEdge('a', 'b'), true);
  });

  it('hasAnyEdge: kenar yoksa false', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    assert.strictEqual(g.hasAnyEdge('a', 'b'), false);
  });

  it('hasAnyEdge: relation bilinmezken edge var mı kontrolü (regresyon: P0 bug fix)', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'tür');
    assert.strictEqual(g.hasAnyEdge('a', 'b'), true);
    assert.strictEqual(g.hasAnyEdge('b', 'a'), false);
  });
});

describe('Graph - Sorgu', () => {
  let g;

  it('query: label ile eşleşen düğümleri bulur', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    g.addNode('kedi', 'hayvan');
    g.addNode('masa', 'eşya');
    const results = g.query('hayvan');
    assert.strictEqual(results.length, 2);
  });
});

describe('Graph - Seyrek Süperpozisyon', () => {
  let g;

  it('addTag: vektöre boyut ekler', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    g.addTag('köpek', 'memeli', 0.8);
    const n = g.getNode('köpek');
    assert.strictEqual(n.vector['memeli'], 0.8);
  });

  it('addTag: varolan boyuta weight ekler', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    g.addTag('köpek', 'memeli', 0.8);
    g.addTag('köpek', 'memeli', 0.1);
    const n = g.getNode('köpek');
    assert.strictEqual(n.vector['memeli'], 0.9);
  });

  it('cosineSimilarity: aynı vektör 1 döner', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addTag('a', 'boyut1', 0.5);
    g.addTag('b', 'boyut1', 0.5);
    const sim = g.cosineSimilarity('a', 'b');
    assert.strictEqual(sim, 1);
  });

  it('cosineSimilarity: dik vektör 0 döner', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addTag('a', 'boyut1', 1);
    g.addTag('b', 'boyut2', 1);
    const sim = g.cosineSimilarity('a', 'b');
    assert.strictEqual(sim, 0);
  });
});

describe('Graph - Unutma Eğrisi', () => {
  let g;

  it('getNode: erişim lastAccessed günceller', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('köpek', 'hayvan');
    const once = g.getNode('köpek');
    const erisim1 = once.lastAccessed;
    const iki = g.getNode('köpek');
    assert.ok(iki.lastAccessed >= erisim1);
  });

  it('getNode returns a defensive copy', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('kedi', 'hayvan');
    const node = g.getNode('kedi');
    node.label = 'mutated';
    node.vector.mem = 1;
    const again = g.getNode('kedi');
    assert.strictEqual(again.label, 'hayvan');
    assert.strictEqual(again.vector.mem, undefined);
  });

  it('getWeight: zamanla azalan weight döner', () => {
    g = new Graph({ decayLambda: 0.1, useSQLite: false });
    g.addNode('test', 'x');
    g.getNode('test');
    const w = g.getWeight('test');
    assert.ok(w >= 0 && w <= 1);
  });
});

describe('Graph - Gelişmiş Sorgu', () => {
  let g;

  it('getInEdges: inbound kenarları O(1) döndürür', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y'); g.addNode('c', 'z');
    g.addEdge('b', 'a', 'tür');
    g.addEdge('c', 'a', 'tür');
    const inEdges = g.getInEdges('a');
    assert.strictEqual(inEdges.length, 2);
  });

  it('nodeCount / edgeCount: doğru sayı döner', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    assert.strictEqual(g.nodeCount(), 2);
    assert.strictEqual(g.edgeCount(), 1);
  });

  it('getStats: yapılandırma bilgisi döner', () => {
    g = new Graph({ decayLambda: 0.1, pruneThreshold: 0.05, useSQLite: false });
    const s = g.getStats();
    assert.strictEqual(s.decayLambda, 0.1);
    assert.ok(typeof s.nodes === 'number');
  });

  it('removeNode: düğüm ve tüm kenarlarını temizler', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    assert.ok(g.removeNode('a'));
    assert.strictEqual(g.getNode('a'), null);
    assert.strictEqual(g.getEdges('a').length, 0);
    assert.strictEqual(g.getInEdges('b').length, 0);
  });

  it('removeNode: olmayan düğüm false döner', () => {
    g = new Graph({ useSQLite: false });
    assert.strictEqual(g.removeNode('olmayan'), false);
  });
});

describe('Graph - Optimize', () => {
  let g;

  it('optimize: zayıf nodesuz kenarları budar', () => {
    g = new Graph({ decayLambda: 0.5, useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    g._edges[0].weight = 0.001;
    const result = g.optimize();
    assert.ok(result.pruned > 0);
  });

  it('optimize scopes pruning to the requested workspace', () => {
    g = new Graph({ pruneThreshold: 0.3, useSQLite: false });
    for (const workspaceId of ['one', 'two']) {
      g.addNode('a', 'a', null, { workspaceId });
      g.addNode('b', 'b', null, { workspaceId });
      g.addEdge('a', 'b', 'bag', { workspaceId, weight: 0.1 });
    }

    const result = g.optimize('one');
    assert.strictEqual(result.pruned, 1);
    assert.strictEqual(g.getEdge('a', 'b', 'bag', 'one'), null);
    assert.ok(g.getEdge('a', 'b', 'bag', 'two'));
  });
});

describe('Graph - Prune (Budama)', () => {
  let g;

  it('prune: eşik altı kenarları temizler', () => {
    g = new Graph({ useSQLite: false });
    g.addNode('a', 'x'); g.addNode('b', 'y'); g.addNode('c', 'z');
    g.addEdge('a', 'b', 'bag');
    g.addEdge('a', 'c', 'zayif');
    g._edges[g._edges.length - 1].weight = 0.1;
    const pruned = g.prune(0.3);
    assert.strictEqual(pruned, 1);
    assert.strictEqual(g.getEdge('a', 'c', 'zayif'), null);
  });

  it('prune keeps edges outside the default workspace', () => {
    g = new Graph({ useSQLite: false });
    for (const workspaceId of ['default', 'other']) {
      g.addNode('a', 'a', null, { workspaceId });
      g.addNode('b', 'b', null, { workspaceId });
      g.addEdge('a', 'b', 'bag', { workspaceId, weight: 0.1 });
    }

    assert.strictEqual(g.prune(0.3), 1);
    assert.strictEqual(g.getEdge('a', 'b', 'bag', 'default'), null);
    assert.ok(g.getEdge('a', 'b', 'bag', 'other'));
  });
});

describe('Graph - Save/Load', { concurrency: false }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-graph-'));
  const testFile = path.join(tempDir, 'test_memory.json');
  const testDb   = path.join(tempDir, 'test_memory.db');

  it('save ve load: dosyaya yazıp geri okur', () => {
    const g = new Graph({ memoryPath: testFile, useSQLite: false });
    g.addNode('köpek', 'hayvan');
    g.save();
    assert.ok(fs.existsSync(testFile));

    const g2 = new Graph({ memoryPath: testFile, useSQLite: false });
    g2.load();
    const n = g2.getNode('köpek');
    assert.ok(n);
    assert.strictEqual(n.label, 'hayvan');

    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  it('SQLite: save ve load çalışır', () => {
    try { fs.unlinkSync(testDb); } catch (_) {}
    const g = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    g.addNode('kedi', 'hayvan');
    g.addNode('balık', 'su canlısı');
    g.addEdge('kedi', 'balık', 'yer');
    g.save();

    const g2 = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    g2.load();
    assert.ok(g2.getNode('kedi'), 'kedi düğümü yüklenmeli');
    assert.ok(g2.getNode('balık'), 'balık düğümü yüklenmeli');
    const edges = g2.getEdges('kedi');
    assert.ok(edges.some(e => e.to === 'balık' && e.relation === 'yer'), 'kenar yüklenmeli');

    try { fs.unlinkSync(testDb); } catch (_) {}
    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  it('SQLite: kenar metadata bilgisini kaybetmez', () => {
    try { fs.unlinkSync(testDb); } catch (_) {}
    const g = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    g.addNode('kedi', 'kedi');
    g.addNode('hayvan', 'hayvan');
    g.addEdge('kedi', 'hayvan', 'tür', {
      confidence: 0.82,
      source: 'test',
      evidence: ['kedi hayvandır'],
    });
    g.save();

    const g2 = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    g2.load();
    const edge = g2.getEdge('kedi', 'hayvan', 'tür');
    assert.ok(edge);
    assert.strictEqual(edge.confidence, 0.82);
    assert.strictEqual(edge.source, 'test');
    assert.deepStrictEqual(edge.evidence, ['kedi hayvandır']);

    try { fs.unlinkSync(testDb); } catch (_) {}
    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  it('SQLite: prune does not delete another workspace edge', () => {
    try { fs.unlinkSync(testDb); } catch (_) {}
    const g = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    for (const workspaceId of ['one', 'two']) {
      g.addNode('a', 'a', null, { workspaceId });
      g.addNode('b', 'b', null, { workspaceId });
      g.addEdge('a', 'b', 'bag', { workspaceId, weight: 0.1 });
    }

    assert.strictEqual(g.prune(0.3, 'one'), 1);
    const reloaded = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    reloaded.load();
    assert.strictEqual(reloaded.getEdge('a', 'b', 'bag', 'one'), null);
    assert.ok(reloaded.getEdge('a', 'b', 'bag', 'two'));

    try { fs.unlinkSync(testDb); } catch (_) {}
    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  it('SQLite: getStats backend=sqlite döner', () => {
    try { fs.unlinkSync(testDb); } catch (_) {}
    const g = new Graph({ memoryPath: testFile, dbPath: testDb, useSQLite: true });
    const stats = g.getStats();
    assert.strictEqual(stats.backend, 'sqlite');
    try { fs.unlinkSync(testDb); } catch (_) {}
    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  it('useSQLite=false: getStats backend=json döner', () => {
    const g = new Graph({ memoryPath: testFile, useSQLite: false });
    const stats = g.getStats();
    assert.strictEqual(stats.backend, 'json');
    try { fs.unlinkSync(testFile); } catch (_) {}
  });

  after(() => {
    try { fs.unlinkSync(testFile); } catch (_) {}
    try { fs.unlinkSync(testDb); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  });
});
describe('Graph - Lifecycle and maintenance baseline contracts', { concurrency: false }, () => {
  function withTempGraph(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-contract-'));
    try {
      return run(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('load replaces stale JSON state and rebuilds public edge indexes', () => withTempGraph(root => {
    const memoryPath = path.join(root, 'memory.json');
    const writer = new Graph({ memoryPath, useSQLite: false });
    writer.addNode('source', 'source');
    writer.addNode('target', 'target');
    writer.addEdge('source', 'target', 'relates');
    writer.save();

    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('stale', 'stale');
    assert.strictEqual(graph.load(), undefined);
    assert.strictEqual(graph.getNode('stale'), null);
    assert.ok(graph.getNode('source'));
    assert.ok(graph.getNode('target'));
    assert.strictEqual(graph.getEdges('source').length, 1);
    assert.strictEqual(graph.getInEdges('target').length, 1);
  }));

  it('load clears stale state when the JSON file is missing', () => withTempGraph(root => {
    const graph = new Graph({ memoryPath: path.join(root, 'missing.json'), useSQLite: false });
    graph.addNode('stale', 'stale');
    graph.addNode('target', 'target');
    graph.addEdge('stale', 'target', 'relates');
    assert.strictEqual(graph.load(), undefined);
    assert.strictEqual(graph.nodeCount(), 0);
    assert.strictEqual(graph.edgeCount(), 0);
  }));

  it('load swallows malformed JSON after clearing stale state', () => withTempGraph(root => {
    const memoryPath = path.join(root, 'malformed.json');
    fs.writeFileSync(memoryPath, '{ invalid json', 'utf8');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('stale', 'stale');
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
      assert.strictEqual(graph.load(), undefined);
      assert.strictEqual(graph.nodeCount(), 0);
      assert.strictEqual(graph.edgeCount(), 0);
      assert.strictEqual(errors.length, 1);
    } finally {
      console.error = originalError;
    }
  }));

  it('save completes synchronously and persists public graph state', () => withTempGraph(root => {
    const memoryPath = path.join(root, 'memory.json');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('source', 'source');
    graph.addNode('target', 'target');
    graph.addEdge('source', 'target', 'relates');
    assert.strictEqual(graph.save(), undefined);
    assert.ok(fs.existsSync(memoryPath));

    const reloaded = new Graph({ memoryPath, useSQLite: false });
    reloaded.load();
    assert.ok(reloaded.getNode('source'));
    assert.strictEqual(reloaded.getEdges('source').length, 1);
  }));

  it('save prunes only the default workspace before persistence', () => withTempGraph(root => {
    const graph = new Graph({
      memoryPath: path.join(root, 'memory.json'),
      useSQLite: false,
      pruneThreshold: 0.3,
    });
    for (const workspaceId of ['default', 'other']) {
      graph.addNode('source', 'source', null, { workspaceId });
      graph.addNode('target', 'target', null, { workspaceId });
      graph.addEdge('source', 'target', 'relates', { workspaceId, weight: 0.1 });
    }
    graph.save();
    assert.strictEqual(graph.getEdge('source', 'target', 'relates', 'default'), null);
    assert.ok(graph.getEdge('source', 'target', 'relates', 'other'));
  }));

  it('save propagates filesystem write errors', () => withTempGraph(root => {
    const graph = new Graph({ memoryPath: root, useSQLite: false });
    graph.addNode('source', 'source');
    assert.throws(() => graph.save());
  }));

  it('optimize returns the exact baseline shape without persisting', () => withTempGraph(root => {
    const graph = new Graph({
      memoryPath: path.join(root, 'memory.json'),
      useSQLite: false,
      pruneThreshold: 0.3,
    });
    for (const workspaceId of ['default', 'other']) {
      graph.addNode('source', 'source', null, { workspaceId });
      graph.addNode('target', 'target', null, { workspaceId });
      graph.addEdge('source', 'target', 'relates', { workspaceId, weight: 0.1 });
    }
    let saveCalls = 0;
    graph.save = () => { saveCalls += 1; };

    const result = graph.optimize();
    assert.deepStrictEqual(Object.keys(result), ['pruned', 'removedNodes']);
    assert.deepStrictEqual(result, { pruned: 1, removedNodes: 0 });
    assert.strictEqual(graph.getEdge('source', 'target', 'relates', 'default'), null);
    assert.ok(graph.getEdge('source', 'target', 'relates', 'other'));
    assert.strictEqual(saveCalls, 0);
  }));

  it('assignEmbedding stores the exact vector on the exact existing storage key', () => {
    const graph = new Graph({ useSQLite: false });
    graph.addNode('shared', 'one', null, { workspaceId: 'one' });
    graph.addNode('shared', 'two', null, { workspaceId: 'two' });
    const storageKeys = Object.keys(graph._nodes);
    const target = new Float64Array([1, 2, 3]);
    const other = new Float64Array([4, 5]);
    graph._nodes[storageKeys[1]].embedding = other;
    const targetNode = graph._nodes[storageKeys[0]];
    let getNodeCalls = 0;
    let saveCalls = 0;
    graph.getNode = (...args) => {
      getNodeCalls += 1;
      return null;
    };
    graph.save = () => {
      saveCalls += 1;
    };

    graph._assignEmbedding(storageKeys[0], target);

    assert.strictEqual(graph._nodes[storageKeys[0]], targetNode);
    assert.strictEqual(graph._nodes[storageKeys[0]].embedding, target);
    assert.strictEqual(graph._nodes[storageKeys[1]].embedding, other);
    assert.strictEqual(getNodeCalls, 0);
    assert.strictEqual(saveCalls, 0);
  });

  it('temporal edge metadata preserves workspace-blind keys, identity, order, and no-save behavior', () => {
    const graph = new Graph({ useSQLite: false });
    for (const workspaceId of ['one', 'two']) {
      graph.addNode('source', 'source', null, { workspaceId });
      graph.addNode('target', 'target', null, { workspaceId });
      graph.addEdge('source', 'target', 'relates', { workspaceId });
    }
    const beforeKeys = graph._captureTemporalEdgeKeys();
    const originalEdges = graph._edges.slice();
    originalEdges[0].createdAt = '2020-01-01T00:00:00.000Z';
    originalEdges[0].evidence = 'legacy';
    originalEdges[1].evidence = ['source:contract'];
    let saveCalls = 0;
    graph.save = () => { saveCalls += 1; };

    assert.deepStrictEqual([...beforeKeys], ['source|relates|target']);
    graph._applyTemporalEdgeMetadata('contract', '2026-07-21T00:00:00.000Z', beforeKeys);

    assert.strictEqual(graph._edges[0], originalEdges[0]);
    assert.strictEqual(graph._edges[1], originalEdges[1]);
    assert.deepStrictEqual(graph._edges, originalEdges);
    assert.strictEqual(originalEdges[0].createdAt, '2020-01-01T00:00:00.000Z');
    assert.strictEqual(originalEdges[1].createdAt, undefined);
    assert.deepStrictEqual(originalEdges[0].evidence, ['source:contract']);
    assert.deepStrictEqual(originalEdges[1].evidence, ['source:contract']);
    assert.strictEqual(originalEdges[0].updatedAt, '2026-07-21T00:00:00.000Z');
    assert.strictEqual(originalEdges[1].updatedAt, '2026-07-21T00:00:00.000Z');
    assert.strictEqual(saveCalls, 0);
  });
});
