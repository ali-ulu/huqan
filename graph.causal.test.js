const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Graph, CAUSAL_RELATIONS, STANDARD_RELATIONS } = require('./graph');

let Database;
try {
  Database = require('better-sqlite3');
} catch (_) {
  Database = null;
}

describe('Causal Relations - v0.7', () => {
  it('CAUSAL_RELATIONS sabitleri tanımlı', () => {
    assert.strictEqual(Array.isArray(CAUSAL_RELATIONS), true);
    assert.strictEqual(CAUSAL_RELATIONS.length, 5);
    assert.ok(CAUSAL_RELATIONS.includes('CAUSES'));
    assert.ok(CAUSAL_RELATIONS.includes('PREVENTS'));
    assert.ok(CAUSAL_RELATIONS.includes('ENABLES'));
    assert.ok(CAUSAL_RELATIONS.includes('DEPENDS_ON'));
    assert.ok(CAUSAL_RELATIONS.includes('LEADS_TO'));
  });

  it('STANDARD_RELATIONS causal relations içerir', () => {
    assert.ok(STANDARD_RELATIONS.includes('is_a'));
    assert.ok(STANDARD_RELATIONS.includes('has_property'));
    assert.ok(STANDARD_RELATIONS.includes('related_to'));
    CAUSAL_RELATIONS.forEach(rel => {
      assert.ok(STANDARD_RELATIONS.includes(rel));
    });
  });

  it('isCausalRelation doğru tanımları tespit eder', () => {
    const graph = new Graph({ noLoad: true });
    assert.strictEqual(graph.isCausalRelation('CAUSES'), true);
    assert.strictEqual(graph.isCausalRelation('PREVENTS'), true);
    assert.strictEqual(graph.isCausalRelation('ENABLES'), true);
    assert.strictEqual(graph.isCausalRelation('DEPENDS_ON'), true);
    assert.strictEqual(graph.isCausalRelation('LEADS_TO'), true);
    assert.strictEqual(graph.isCausalRelation('is_a'), false);
    assert.strictEqual(graph.isCausalRelation('has_property'), false);
  });

  it('getCausalRelations tüm causal relations döndürür', () => {
    const graph = new Graph({ noLoad: true });
    const relations = graph.getCausalRelations();
    assert.strictEqual(Array.isArray(relations), true);
    assert.strictEqual(relations.length, 5);
    // CAUSAL_RELATIONS Object.freeze olduğu için sort yapamayız, manuel kontrol
    CAUSAL_RELATIONS.forEach(rel => {
      assert.ok(relations.includes(rel));
    });
  });

  it('causal relation strength field zorunludur', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('node1', 'Node 1');
    graph.addNode('node2', 'Node 2');

    // Strength olmadan hata vermelidir
    assert.throws(() => {
      graph.addEdge('node1', 'node2', 'CAUSES', { weight: 0.8 });
    }, /Causal relation 'CAUSES' requires strength field/);

    // Strength ile çalışmalıdır
    const edge = graph.addEdge('node1', 'node2', 'CAUSES', { 
      strength: 0.8,
      weight: 0.7,
      confidence: 0.75
    });
    assert.ok(edge);
    assert.strictEqual(edge.strength, 0.8);
  });

  it('causal relation strength 0-1 arası olmalıdır', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('node1', 'Node 1');
    graph.addNode('node2', 'Node 2');

    assert.throws(() => {
      graph.addEdge('node1', 'node2', 'CAUSES', { strength: -0.5 });
    }, /Causal relation 'CAUSES' requires strength between 0 and 1/);

    assert.throws(() => {
      graph.addEdge('node1', 'node2', 'CAUSES', { strength: 1.5 });
    }, /Causal relation 'CAUSES' requires strength between 0 and 1/);
  });

  it('standart relation için strength zorunlu değildir', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('node1', 'Node 1');
    graph.addNode('node2', 'Node 2');

    const edge = graph.addEdge('node1', 'node2', 'is_a', { weight: 0.8 });
    assert.ok(edge);
    assert.strictEqual(edge.strength, undefined);
  });

  it('getCausalEdges sadece causal relations filtreler', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('node1', 'Node 1');
    graph.addNode('node2', 'Node 2');
    graph.addNode('node3', 'Node 3');

    graph.addEdge('node1', 'node2', 'CAUSES', { strength: 0.8 });
    graph.addEdge('node1', 'node3', 'is_a', { weight: 0.7 });
    graph.addEdge('node2', 'node3', 'PREVENTS', { strength: 0.6 });

    const causalEdges = graph.getCausalEdges('node1');
    assert.strictEqual(causalEdges.length, 1);
    assert.strictEqual(causalEdges[0].relation, 'CAUSES');
  });

  it('getCausalChain basit causal zinciri çıkarır', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');
    graph.addNode('C', 'C');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8, confidence: 0.75 });
    graph.addEdge('B', 'C', 'CAUSES', { strength: 0.7, confidence: 0.65 });

    const chain = graph.getCausalChain('A');
    assert.strictEqual(chain.length, 2);
    
    // İlk zincir: A -> B
    assert.strictEqual(chain[0].length, 1);
    assert.strictEqual(chain[0][0].from, 'A');
    assert.strictEqual(chain[0][0].to, 'B');
    assert.strictEqual(chain[0][0].relation, 'CAUSES');
    assert.strictEqual(chain[0][0].strength, 0.8);
    
    // İkinci zincir: A -> B -> C
    assert.strictEqual(chain[1].length, 2);
    assert.strictEqual(chain[1][0].from, 'A');
    assert.strictEqual(chain[1][0].to, 'B');
    assert.strictEqual(chain[1][1].from, 'B');
    assert.strictEqual(chain[1][1].to, 'C');
  });

  it('getCausalChain maxDepth ile sınırlanır', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');
    graph.addNode('C', 'C');
    graph.addNode('D', 'D');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8 });
    graph.addEdge('B', 'C', 'CAUSES', { strength: 0.7 });
    graph.addEdge('C', 'D', 'CAUSES', { strength: 0.6 });

    const chain = graph.getCausalChain('A', 2);
    // Max depth 2 olduğu için A->B->C kadar gider, D'ye ulaşamaz
    assert.ok(chain.length > 0);
    // En uzun zincir 2 adımdan uzun olmamalı
    for (const path of chain) {
      assert.ok(path.length <= 2);
    }
  });

  it('getCausalChain causal loop tespiti yapar', () => {
    const graph = new Graph({ noLoad: true });
    graph.addNode('A', 'A');
    graph.addNode('B', 'B');
    graph.addNode('C', 'C');

    graph.addEdge('A', 'B', 'CAUSES', { strength: 0.8 });
    graph.addEdge('B', 'C', 'CAUSES', { strength: 0.7 });
    graph.addEdge('C', 'A', 'CAUSES', { strength: 0.6 }); // Loop

    const chain = graph.getCausalChain('A');
    // Loop tespiti için visited set kullanılır, sonsuz döngü olmamalı
    assert.ok(chain.length > 0);
    assert.ok(chain.length < 10); // Sonsuz döngü değil
  });

  it('legacy JSON load keeps non-causal edges intact and defaults causal strength', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-graph-json-'));
    const memoryPath = path.join(tmpDir, 'memory.json');
    fs.writeFileSync(memoryPath, JSON.stringify({
      nodes: {
        a: { id: 'a', label: 'A', weight: 0.5, created: 1, lastAccessed: 1, vector: {} },
        b: { id: 'b', label: 'B', weight: 0.5, created: 1, lastAccessed: 1, vector: {} },
      },
      edges: [
        { from: 'a', to: 'b', relation: 'is_a', weight: 0.8 },
        { from: 'b', to: 'a', relation: 'CAUSES', weight: 0.7, confidence: 0.6 },
      ],
    }));

    const graph = new Graph({ memoryPath, useSQLite: false });
    graph.load();

    const legacyEdge = graph.getEdge('a', 'b', 'is_a');
    const causalEdge = graph.getEdge('b', 'a', 'CAUSES');

    assert.ok(legacyEdge);
    assert.strictEqual(legacyEdge.strength, undefined);
    assert.ok(causalEdge);
    assert.strictEqual(causalEdge.strength, 0.5);
    assert.strictEqual(graph.getEdgesBetween('a', 'b').length, 1);
    assert.strictEqual(graph.getEdgesBetween('b', 'a').length, 1);
  });

  it('SQLite migration smoke keeps old DB readable with causal defaults', () => {
    if (!Database) return;
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-graph-sqlite-'));
    const dbPath = path.join(tmpDir, 'memory.db');
    const memoryPath = path.join(tmpDir, 'memory.json');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        created INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT '',
        last_accessed INTEGER NOT NULL,
        last_seen TEXT NOT NULL DEFAULT '',
        vector TEXT NOT NULL DEFAULT '{}'
      );
      CREATE TABLE edges (
        from_id TEXT NOT NULL,
        to_id TEXT NOT NULL,
        relation TEXT NOT NULL,
        weight REAL NOT NULL DEFAULT 0.5,
        confidence REAL NOT NULL DEFAULT 0.5,
        source TEXT NOT NULL DEFAULT 'manual',
        source_ref TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        evidence TEXT NOT NULL DEFAULT '[]',
        evidence_type TEXT NOT NULL DEFAULT '',
        confidence_history TEXT NOT NULL DEFAULT '[]',
        company_mode INTEGER NOT NULL DEFAULT 0,
        source_type TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT '',
        created INTEGER NOT NULL,
        UNIQUE(from_id, to_id, relation)
      );
      INSERT INTO nodes (id, label, weight, created, created_at, last_accessed, last_seen, vector)
      VALUES ('a', 'A', 0.5, 1, '2026-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z', '{}');
      INSERT INTO nodes (id, label, weight, created, created_at, last_accessed, last_seen, vector)
      VALUES ('b', 'B', 0.5, 1, '2026-01-01T00:00:00.000Z', 1, '2026-01-01T00:00:00.000Z', '{}');
      INSERT INTO edges (from_id, to_id, relation, weight, confidence, source, source_ref, session_id, evidence, evidence_type, confidence_history, company_mode, source_type, updated_at, created_at, created)
      VALUES ('a', 'b', 'CAUSES', 0.7, 0.6, 'manual', '', '', '[]', '', '[]', 0, '', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', 1);
    `);
    db.close();

    const graph = new Graph({ memoryPath, dbPath, useSQLite: true });
    graph.load();

    const edge = graph.getEdge('a', 'b', 'CAUSES');
    assert.ok(edge);
    assert.strictEqual(edge.strength, 0.5);
    assert.strictEqual(graph.getEdgesBetween('a', 'b').length, 1);
    assert.strictEqual(graph.getEdgesBetween('a', 'b')[0].relation, 'CAUSES');
  });
});
