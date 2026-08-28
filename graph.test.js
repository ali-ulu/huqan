const { isolatedKernelOptions, isolatedGraphOptions } = require('./test/helpers/isolated-persistence');
const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const Graph = require('./graph');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('node:child_process');

describe('Graph JSON corruption refuses persistence (#1703)', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-json-corrupt-'));
  after(() => fs.rmSync(root, { recursive: true, force: true }));

  it('a restarted process cannot overwrite corrupt graph or append a successful operation', () => {
    const memoryPath = path.join(root, 'restart.json');
    const seed = new Graph({ memoryPath, useSQLite: false });
    seed.runMutationOnce('seed', () => { seed.addNode('seed'); return { ok: true }; });
    seed.close();
    const journalPath = memoryPath.replace(/\.json$/, '.mutations.json');
    const journal = fs.readFileSync(journalPath);
    const corrupt = '{"nodes":{"seed":';
    fs.writeFileSync(memoryPath, corrupt);
    const child = spawnSync(process.execPath, ['-e', `
      const assert = require('node:assert/strict');
      const Graph = require(process.argv[1]);
      const graph = new Graph({ memoryPath: process.argv[2], useSQLite: false });
      assert.throws(() => graph.load(), { code: 'GRAPH_JSON_LOAD_FAILED' });
      let called = false;
      assert.throws(() => graph.runMutationOnce('new-operation', () => {
        called = true;
        graph.addNode('replacement');
        return { ok: true };
      }), { code: 'GRAPH_JSON_LOAD_FAILED' });
      assert.equal(called, false);
      assert.throws(() => graph.save(), { code: 'GRAPH_JSON_LOAD_FAILED' });
      graph.close();
    `, require.resolve('./graph'), memoryPath], { encoding: 'utf8', timeout: 10000 });
    assert.ifError(child.error);
    assert.strictEqual(child.status, 0, child.stderr);
    assert.strictEqual(fs.readFileSync(memoryPath, 'utf8'), corrupt);
    assert.deepStrictEqual(fs.readFileSync(journalPath), journal);
  });

  it('rejects malformed graph shapes without publishing a partial snapshot', () => {
    const memoryPath = path.join(root, 'shapes.json');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('prior');
    for (const value of [null, [], {}, { nodes: [] }, { nodes: { bad: null } },
      { nodes: { bad: { id: 42 } } }, { nodes: {}, edges: {} },
      { nodes: {}, edges: [null] }, { nodes: {}, edges: [{ from: 'a' }] },
      { nodes: {}, candidateClaims: {} }, { nodes: {}, auditEvents: [false] },
      { nodes: {}, candidateClaims: null }, { nodes: {}, candidate_claims: null },
      { nodes: {}, auditEvents: null }, { nodes: {}, audit_log: null },
      { nodes: { first: { id: 'same' }, second: { id: 'same' } } }]) {
      const bytes = JSON.stringify(value);
      fs.writeFileSync(memoryPath, bytes);
      assert.throws(() => graph.load(), { code: 'GRAPH_JSON_LOAD_FAILED' });
      assert.ok(graph.getNode('prior'));
      assert.throws(() => graph.save(), { code: 'GRAPH_JSON_LOAD_FAILED' });
      assert.strictEqual(fs.readFileSync(memoryPath, 'utf8'), bytes);
    }
    graph.close();
  });

  it('requires a valid reload to recover, while a fresh missing store remains supported', () => {
    const memoryPath = path.join(root, 'recovery.json');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.load();
    graph.addNode('saved');
    graph.save();
    const backup = fs.readFileSync(memoryPath);
    fs.writeFileSync(memoryPath, '{');
    assert.throws(() => graph.load(), { code: 'GRAPH_JSON_LOAD_FAILED' });
    fs.unlinkSync(memoryPath);
    assert.throws(() => graph.load(), { code: 'GRAPH_JSON_LOAD_FAILED' });
    fs.writeFileSync(memoryPath, backup);
    graph.load();
    graph.runMutationOnce('recovered', () => { graph.addNode('after'); return { ok: true }; });
    graph.close();
    const reopened = new Graph({ memoryPath, useSQLite: false });
    reopened.load();
    assert.ok(reopened.getNode('saved'));
    assert.ok(reopened.getNode('after'));
    reopened.close();
  });
});

describe('Graph - Düğüm Yönetimi', () => {
  let g;

  it('addNode: yeni düğüm oluşturur, weight=0.5', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('köpek', 'hayvan');
    const n = g.getNode('köpek');
    assert.ok(n);
    assert.strictEqual(n.label, 'hayvan');
    assert.strictEqual(n.weight, 0.5);
    assert.deepStrictEqual(n.tags, []);
  });

  it('addNode: aynı id label günceller, weight artar', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('köpek', 'hayvan');
    g.addNode('köpek', 'memeli hayvan');
    const n = g.getNode('köpek');
    assert.strictEqual(n.label, 'memeli hayvan');
    assert.ok(n.weight > 0.5);
  });

  it('getNode: olmayan id null döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    assert.strictEqual(g.getNode('olmayan'), null);
  });
});

describe('Graph - Kenar Yönetimi', () => {
  let g;

  it('addEdge: kenar oluşturur, weight=0.5', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
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
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
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
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    assert.strictEqual(g.getEdge('x', 'y', 'z'), null);
  });

  it('getEdge returns a defensive copy', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    const edge = g.getEdge('a', 'b', 'bag');
    edge.weight = 0.001;
    const again = g.getEdge('a', 'b', 'bag');
    assert.notStrictEqual(again.weight, 0.001);
  });

  it('getEdgesBetween: iki düğüm arasındaki tüm kenarları döndürür', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'tür');
    g.addEdge('a', 'b', 'benzer');
    const edges = g.getEdgesBetween('a', 'b');
    assert.strictEqual(edges.length, 2);
  });

  it('getEdgesBetween: kenar yoksa boş dizi döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    assert.deepStrictEqual(g.getEdgesBetween('a', 'b'), []);
  });

  it('hasAnyEdge: iki düğüm arasında en az bir kenar varsa true', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'tür');
    assert.strictEqual(g.hasAnyEdge('a', 'b'), true);
  });

  it('hasAnyEdge: kenar yoksa false', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    assert.strictEqual(g.hasAnyEdge('a', 'b'), false);
  });

  it('hasAnyEdge: relation bilinmezken edge var mı kontrolü (regresyon: P0 bug fix)', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'tür');
    assert.strictEqual(g.hasAnyEdge('a', 'b'), true);
    assert.strictEqual(g.hasAnyEdge('b', 'a'), false);
  });
});

describe('Graph - Sorgu', () => {
  let g;

  it('query: label ile eşleşen düğümleri bulur', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
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
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('köpek', 'hayvan');
    g.addTag('köpek', 'memeli', 0.8);
    const n = g.getNode('köpek');
    assert.strictEqual(n.vector['memeli'], 0.8);
  });

  it('addTag: varolan boyuta weight ekler', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('köpek', 'hayvan');
    g.addTag('köpek', 'memeli', 0.8);
    g.addTag('köpek', 'memeli', 0.1);
    const n = g.getNode('köpek');
    assert.strictEqual(n.vector['memeli'], 0.9);
  });

  it('cosineSimilarity: aynı vektör 1 döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x');
    g.addNode('b', 'y');
    g.addTag('a', 'boyut1', 0.5);
    g.addTag('b', 'boyut1', 0.5);
    const sim = g.cosineSimilarity('a', 'b');
    assert.strictEqual(sim, 1);
  });

  it('cosineSimilarity: dik vektör 0 döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
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

  it('getNode is a pure defensive read and touchNode owns access updates', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('köpek', 'hayvan');
    Object.values(g._nodes)[0].lastAccessed = 1;
    const once = g.getNode('köpek');
    const erisim1 = once.lastAccessed;
    once.lastAccessed = 0;
    assert.strictEqual(g.getNode('köpek').lastAccessed, erisim1);
    g.touchNode('köpek');
    assert.ok(g.getNode('köpek').lastAccessed > erisim1);
  });

  it('getNode returns a defensive copy', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('kedi', 'hayvan');
    const node = g.getNode('kedi');
    node.label = 'mutated';
    node.vector.mem = 1;
    const again = g.getNode('kedi');
    assert.strictEqual(again.label, 'hayvan');
    assert.strictEqual(again.vector.mem, undefined);
  });

  it('getWeight: zamanla azalan weight döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { decayLambda: 0.1, useSQLite: false }));
    g.addNode('test', 'x');
    g.getNode('test');
    const w = g.getWeight('test');
    assert.ok(w >= 0 && w <= 1);
  });
});

describe('Graph - Gelişmiş Sorgu', () => {
  let g;

  it('getInEdges: inbound kenarları O(1) döndürür', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y'); g.addNode('c', 'z');
    g.addEdge('b', 'a', 'tür');
    g.addEdge('c', 'a', 'tür');
    const inEdges = g.getInEdges('a');
    assert.strictEqual(inEdges.length, 2);
  });

  it('nodeCount / edgeCount: doğru sayı döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    assert.strictEqual(g.nodeCount(), 2);
    assert.strictEqual(g.edgeCount(), 1);
  });

  it('getStats: yapılandırma bilgisi döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { decayLambda: 0.1, pruneThreshold: 0.05, useSQLite: false }));
    const s = g.getStats();
    assert.strictEqual(s.decayLambda, 0.1);
    assert.ok(typeof s.nodes === 'number');
  });

  it('removeNode: düğüm ve tüm kenarlarını temizler', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    assert.ok(g.removeNode('a'));
    assert.strictEqual(g.getNode('a'), null);
    assert.strictEqual(g.getEdges('a').length, 0);
    assert.strictEqual(g.getInEdges('b').length, 0);
  });

  it('removeNode: olmayan düğüm false döner', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    assert.strictEqual(g.removeNode('olmayan'), false);
  });
});

describe('Graph - Optimize', () => {
  let g;

  it('optimize: zayıf nodesuz kenarları budar', () => {
    g = new Graph(isolatedGraphOptions('graph', { decayLambda: 0.5, useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y');
    g.addEdge('a', 'b', 'bag');
    g._edges[0].weight = 0.001;
    const result = g.optimize();
    assert.ok(result.pruned > 0);
  });

  it('optimize scopes pruning to the requested workspace', () => {
    g = new Graph(isolatedGraphOptions('graph', { pruneThreshold: 0.3, useSQLite: false }));
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

  it('optimize keeps an isolated node that is only minutes old', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('orphan', 'orphan');
    Object.values(g._nodes)[0].lastAccessed = Date.now() - 120 * 1000;

    const result = g.optimize();

    assert.strictEqual(result.removedNodes, 0);
    assert.ok(g.getNode('orphan'));
  });

  it('optimize does not delete nodes made isolated by its own prune pass', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'a'); g.addNode('b', 'b');
    g.addEdge('a', 'b', 'weak', { weight: 0.005 });
    for (const node of Object.values(g._nodes)) node.lastAccessed = Date.now() - 90 * 24 * 60 * 60 * 1000;

    const result = g.optimize();

    assert.strictEqual(result.pruned, 1);
    assert.strictEqual(result.removedNodes, 0);
    assert.ok(g.getNode('a'));
    assert.ok(g.getNode('b'));
  });

  it('optimize audits removal of a decayed isolated node', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('orphan', 'orphan');
    Object.values(g._nodes)[0].lastAccessed = Date.now() - 90 * 24 * 60 * 60 * 1000;

    const result = g.optimize();
    const events = g.getAuditEvents({ eventType: 'DELETE', targetType: 'node', targetId: 'orphan' });

    assert.strictEqual(result.removedNodes, 1);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].actor, 'graph.optimize');
    assert.strictEqual(events[0].details.reason, 'decayed_isolated_node');
  });
});

describe('Graph - Prune (Budama)', () => {
  let g;

  it('prune: eşik altı kenarları temizler', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    g.addNode('a', 'x'); g.addNode('b', 'y'); g.addNode('c', 'z');
    g.addEdge('a', 'b', 'bag');
    g.addEdge('a', 'c', 'zayif');
    g._edges[g._edges.length - 1].weight = 0.1;
    const pruned = g.prune(0.3);
    assert.strictEqual(pruned, 1);
    assert.strictEqual(g.getEdge('a', 'c', 'zayif'), null);
  });

  it('prune keeps edges outside the default workspace', () => {
    g = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
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

describe('Graph - JSON save is atomic', { concurrency: false }, () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');

  function tempMemoryPath(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    return path.join(dir, 'memory.json');
  }

  it('leaves no leftover .tmp- file after a successful save', () => {
    const memoryPath = tempMemoryPath('axiom-graph-atomic-ok-');
    const g = new Graph({ memoryPath, useSQLite: false });
    g.addNode('kedi', 'hayvan');
    g.save();

    const dirEntries = fs.readdirSync(path.dirname(memoryPath));
    assert.ok(!dirEntries.some(name => name.includes('.tmp-')), 'no temp file should remain after a successful save');
    assert.ok(fs.existsSync(memoryPath));
  });

  it('never leaves memoryPath truncated/corrupted if the write step fails mid-save', () => {
    const memoryPath = tempMemoryPath('axiom-graph-atomic-fail-');
    const g = new Graph({ memoryPath, useSQLite: false });
    g.addNode('kedi', 'hayvan');
    g.save();
    const originalContent = fs.readFileSync(memoryPath, 'utf8');

    g.addNode('kopek', 'hayvan');
    const originalWrite = fs.writeFileSync;
    fs.writeFileSync = (targetPath, ...rest) => {
      if (String(targetPath).includes('.tmp-')) {
        throw new Error('simulated crash mid-write');
      }
      return originalWrite(targetPath, ...rest);
    };
    try {
      assert.throws(() => g.save(), /simulated crash mid-write/);
    } finally {
      fs.writeFileSync = originalWrite;
    }

    const afterContent = fs.readFileSync(memoryPath, 'utf8');
    assert.strictEqual(afterContent, originalContent, 'memoryPath must be untouched (old content), never a partial/torn write');
    const dirEntries = fs.readdirSync(path.dirname(memoryPath));
    assert.ok(!dirEntries.some(name => name.includes('.tmp-')), 'the failed temp file should not be left dangling either way once the process would clean up on retry');
  });

  it('rename step failing also leaves memoryPath at its prior content, not a torn write', () => {
    const memoryPath = tempMemoryPath('axiom-graph-atomic-rename-fail-');
    const g = new Graph({ memoryPath, useSQLite: false });
    g.addNode('kedi', 'hayvan');
    g.save();
    const originalContent = fs.readFileSync(memoryPath, 'utf8');

    g.addNode('kopek', 'hayvan');
    const originalRename = fs.renameSync;
    fs.renameSync = (source, dest) => {
      if (String(dest) === memoryPath) throw new Error('simulated rename failure');
      return originalRename(source, dest);
    };
    try {
      assert.throws(() => g.save(), /simulated rename failure/);
    } finally {
      fs.renameSync = originalRename;
    }

    const afterContent = fs.readFileSync(memoryPath, 'utf8');
    assert.strictEqual(afterContent, originalContent, 'memoryPath must reflect the last successful save, not a half-applied write');
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

  it('load rejects malformed JSON, retains the prior view and blocks persistence', () => withTempGraph(root => {
    const memoryPath = path.join(root, 'malformed.json');
    fs.writeFileSync(memoryPath, '{ invalid json', 'utf8');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('stale', 'stale');
    assert.throws(() => graph.load(), { code: 'GRAPH_JSON_LOAD_FAILED' });
    assert.ok(graph.getNode('stale'));
    assert.throws(() => graph.save(), { code: 'GRAPH_JSON_LOAD_FAILED' });
    assert.strictEqual(fs.readFileSync(memoryPath, 'utf8'), '{ invalid json');
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

  it('save persists without implicitly pruning any workspace', () => withTempGraph(root => {
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
    assert.ok(graph.getEdge('source', 'target', 'relates', 'default'));
    assert.ok(graph.getEdge('source', 'target', 'relates', 'other'));

    const reloaded = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
    reloaded.load();
    assert.ok(reloaded.getEdge('source', 'target', 'relates', 'default'));
    assert.ok(reloaded.getEdge('source', 'target', 'relates', 'other'));
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
    const graph = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
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

  it('temporal edge metadata touches only edges this operation wrote, per workspace (#733)', () => {
    const graph = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    for (const workspaceId of ['one', 'two']) {
      graph.addNode('source', 'source', null, { workspaceId });
      graph.addNode('target', 'target', null, { workspaceId });
      graph.addEdge('source', 'target', 'relates', { workspaceId });
    }
    // Same from|relation|to triple in both workspaces: the scope key has to
    // keep them apart, which the old workspace-blind key could not.
    const preExisting = graph._edges.slice();
    const preExistingUpdatedAt = preExisting[0].updated_at;
    const otherPreExistingUpdatedAt = preExisting[1].updated_at;
    preExisting[0].created_at = '2020-01-01T00:00:00.000Z';
    preExisting[0].evidence = 'legacy';
    preExisting[0].source = 'source-a';
    preExisting[1].evidence = ['source:source-b'];
    preExisting[1].source = 'source-b';

    const scope = graph._captureTemporalEdgeKeys();
    assert.deepStrictEqual([...scope.touched], [], 'a fresh scope has touched nothing');

    // Only this edge is written inside the scope.
    graph.addNode('fresh', 'fresh', null, { workspaceId: 'one' });
    graph.addEdge('source', 'fresh', 'relates', { workspaceId: 'one' });
    const created = graph._edges[graph._edges.length - 1];

    let saveCalls = 0;
    graph.save = () => { saveCalls += 1; };

    const stamped = graph._applyTemporalEdgeMetadata('contract', '2026-07-21T00:00:00.000Z', scope, { workspaceId: 'one' });
    assert.strictEqual(stamped, 1);

    // The newly written edge carries the operation's metadata.
    assert.strictEqual(created.source, 'contract');
    assert.strictEqual(created.updated_at, '2026-07-21T00:00:00.000Z');
    assert.strictEqual(created.created_at, '2026-07-21T00:00:00.000Z');
    assert.deepStrictEqual(created.evidence, ['source:contract']);

    // Pre-existing edges keep their own provenance, in both workspaces.
    assert.strictEqual(preExisting[0].source, 'source-a');
    assert.strictEqual(preExisting[1].source, 'source-b');
    assert.strictEqual(preExisting[0].updated_at, preExistingUpdatedAt);
    assert.strictEqual(preExisting[1].updated_at, otherPreExistingUpdatedAt);
    assert.strictEqual(preExisting[0].created_at, '2020-01-01T00:00:00.000Z');
    assert.strictEqual(preExisting[0].evidence, 'legacy');
    assert.deepStrictEqual(preExisting[1].evidence, ['source:source-b']);

    // Identity and order are untouched, and stamping never saves.
    assert.strictEqual(graph._edges[0], preExisting[0]);
    assert.strictEqual(graph._edges[1], preExisting[1]);
    assert.strictEqual(saveCalls, 0);
  });

  it('temporal edge metadata does not cross into another workspace (#733)', () => {
    const graph = new Graph(isolatedGraphOptions('graph', { useSQLite: false }));
    for (const workspaceId of ['w1', 'w2']) {
      graph.addNode('a', 'a', null, { workspaceId });
      graph.addNode('b', 'b', null, { workspaceId });
    }
    graph.addEdge('a', 'b', 'relates', { workspaceId: 'w2', source: 'source-b' });

    const scope = graph._captureTemporalEdgeKeys();
    graph.addEdge('a', 'b', 'relates', { workspaceId: 'w1', source: 'source-a' });
    graph._applyTemporalEdgeMetadata('source-c', '2026-07-21T00:00:00.000Z', scope, { workspaceId: 'w1' });

    assert.strictEqual(graph.getEdge('a', 'b', 'relates', 'w1').source, 'source-c');
    assert.strictEqual(graph.getEdge('a', 'b', 'relates', 'w2').source, 'source-b');
  });
});

// #369: embeddings live only in memory as Float64Array between the strip and
// the restore in save(), and only as JSON-shaped data inside a rollback
// snapshot. Both windows lost them, in different ways.
describe('Graph - embedding survival across save failure and rollback (#369)', { concurrency: false }, () => {
  function withTempRoot(run) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-graph-369-'));
    try {
      return run(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('keeps embeddings in memory when the JSON write throws mid-save', () => withTempRoot(root => {
    const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
    graph.addNode('kedi', 'hayvan');
    const [storageKey] = Object.keys(graph._nodes);
    const vector = new Float64Array([0.5, 0.25, 0.125]);
    graph._assignEmbedding(storageKey, vector);

    // Fail after _stripEmbeddings() has already deleted the live copies.
    graph._writeStrippedState = () => { throw new Error('disk full'); };

    assert.throws(() => graph.save(), /disk full/);

    const restored = graph._nodes[storageKey].embedding;
    assert.ok(restored instanceof Float64Array, 'a failed save must not erase the in-memory embedding');
    assert.deepStrictEqual(Array.from(restored), [0.5, 0.25, 0.125]);
  }));

  it('restores embeddings as Float64Array after a successful save', () => withTempRoot(root => {
    const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
    graph.addNode('kedi', 'hayvan');
    const [storageKey] = Object.keys(graph._nodes);
    graph._assignEmbedding(storageKey, new Float64Array([1, 2]));

    graph.save();

    assert.ok(graph._nodes[storageKey].embedding instanceof Float64Array);
    assert.deepStrictEqual(Array.from(graph._nodes[storageKey].embedding), [1, 2]);
    // The serialized form still must not carry the vector inline.
    const persisted = JSON.parse(fs.readFileSync(path.join(root, 'memory.json'), 'utf-8'));
    assert.ok(!persisted.nodes[storageKey].embedding, 'embeddings belong in the sidecar file, not memory.json');
  }));

  // #609: the sidecar is part of the saved state, so every save() has to bring
  // it to the current truth -- including the truth "there are none left".
  it('does not resurrect a deleted embedding from a stale sidecar on reload', () => withTempRoot(root => {
    const memoryPath = path.join(root, 'memory.json');
    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.addNode('kedi', 'hayvan');
    const [storageKey] = Object.keys(graph._nodes);
    graph._assignEmbedding(storageKey, new Float64Array([9, 9]));
    graph.save();

    delete graph._nodes[storageKey].embedding;
    graph.save();

    const reloaded = new Graph({ memoryPath, useSQLite: false });
    reloaded.load();
    assert.ok(
      !reloaded._nodes[storageKey].embedding,
      'a deleted embedding must stay deleted; the stale sidecar used to bring it back',
    );
  }));

  it('clears the sidecar when prune() removes the last embedded node (#609)', () => withTempRoot(root => {
    const memoryPath = path.join(root, 'memory.json');
    const graph = new Graph({ memoryPath, useSQLite: false, pruneThreshold: 0.9 });
    graph.addNode('kedi', 'hayvan');
    const [storageKey] = Object.keys(graph._nodes);
    graph._assignEmbedding(storageKey, new Float64Array([9, 9]));
    graph.save();
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'memory.embeddings.json'), 'utf-8')),
      { [storageKey]: [9, 9] },
    );

    delete graph._nodes[storageKey];
    graph.save();

    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(path.join(root, 'memory.embeddings.json'), 'utf-8')),
      {},
      'the sidecar must be emptied, not left holding the removed node',
    );
  }));

  it('rolls a failed mutation back to a real Float64Array, not a JSON-shaped object', () => withTempRoot(root => {
    const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
    graph.addNode('kedi', 'hayvan');
    const [storageKey] = Object.keys(graph._nodes);
    graph._assignEmbedding(storageKey, new Float64Array([0.5, 0.25]));

    assert.throws(
      () => graph.runMutationOnce('op-369', () => { throw new Error('mutation blew up'); }),
      /mutation blew up/,
    );

    const rolledBack = graph._nodes[storageKey].embedding;
    // Before the fix this was `{"0":0.5,"1":0.25}`: truthy, so every
    // `if (node.embedding)` guard still passed, but `.length` was undefined.
    assert.ok(rolledBack instanceof Float64Array, 'rollback must not downgrade the embedding to a plain object');
    assert.strictEqual(rolledBack.length, 2);
    assert.deepStrictEqual(Array.from(rolledBack), [0.5, 0.25]);
  }));

  it('keeps nodeSimilarity meaningful after a rolled-back mutation (#369 downstream effect)', () => withTempRoot(root => {
    const Dream = require('./dream');
    const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
    graph.addNode('kedi', 'hayvan');
    graph.addNode('köpek', 'hayvan');
    const keys = Object.keys(graph._nodes);
    graph._assignEmbedding(keys[0], new Float64Array([1, 0]));
    graph._assignEmbedding(keys[1], new Float64Array([1, 0]));

    const dream = new Dream({ graph });
    const before = dream.nodeSimilarity(keys[0], keys[1]);
    assert.ok(before > 0.99, 'identical vectors should score ~1 to begin with');

    assert.throws(
      () => graph.runMutationOnce('op-369-similarity', () => { throw new Error('boom'); }),
      /boom/,
    );

    // The corrupted shape scored 0.0 here while looking perfectly healthy.
    assert.ok(
      dream.nodeSimilarity(keys[0], keys[1]) > 0.99,
      'similarity must survive a rollback; a silent drop to 0 is the #369 symptom',
    );
  }));
});
