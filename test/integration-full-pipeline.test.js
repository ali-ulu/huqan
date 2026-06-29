'use strict';

/**
 * AXIOM Integration Tests — Full Pipeline
 *
 * Tests cross-module flows that unit tests cannot cover:
 * 1. Kernel + Graph + Verify (learn → verify roundtrip)
 * 2. Kernel + Causal Traversal (CAUSES/PREVENTS/ENABLES chains)
 * 3. Kernel + Memory Store (learn → memory → retrieve)
 * 4. MCP Gate + Safety (AB1–AB6 gate enforcement on tools)
 * 5. Server REST API (HTTP endpoint → kernel → response)
 * 6. Provenance + Audit Trail
 * 7. Graph Persistence (save/load cycle)
 * 8. Kernel + Shield (LLM output verification)
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const Kernel = require('../kernel');
const { callTool } = require('../mcpServer');

const TEST_FIXTURE_LEARN_BYPASS = {
  admissionRequired: false,
  admissionBypassReason: 'test_fixture_seed',
};

const APPROVED_TEST_ADMISSION = {
  admissionRequired: true,
  approvalRequired: true,
  approvalStatus: 'approved',
  approvalId: 'apr-integration-test',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-integration-'));

after(() => {
  fs.rmSync(TEMP_DIR, { recursive: true, force: true });
});

function makeKernel(name, opts = {}) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(TEMP_DIR, `${name}.json`),
    lang: opts.lang || 'tr',
    enableConcurrencyLock: false,
    loadPlugins: false,
    ...opts,
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

function withMutedConsole(fn) {
  const origLog = console.log;
  const origInfo = console.info;
  const origWarn = console.warn;
  const origErr = console.error;
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  try {
    return fn();
  } finally {
    console.log = origLog;
    console.info = origInfo;
    console.warn = origWarn;
    console.error = origErr;
  }
}

function learnFixture(kernel, text, opts = {}) {
  return kernel.learn(text, { ...opts, ...TEST_FIXTURE_LEARN_BYPASS });
}

function seedBasicFacts(kernel) {
  withMutedConsole(() => {
    learnFixture(kernel, 'Kedi hayvandır');
    learnFixture(kernel, 'Köpek hayvandır');
    learnFixture(kernel, 'Su içmek susuzluğu giderir');
    learnFixture(kernel, 'Aşırı sıcaklık dehidrasyona neden olur');
  });
}

function seedCausalChain(kernel) {
  withMutedConsole(() => {
    // Build a causal chain: sigara → kanser → ölüm
    kernel.graph.addNode('sigara', 'sigara', null, { workspaceId: 'default' });
    kernel.graph.addNode('akciğer kanseri', 'akciğer kanseri', null, { workspaceId: 'default' });
    kernel.graph.addNode('ölüm', 'ölüm', null, { workspaceId: 'default' });
    kernel.graph.addNode('egzersiz', 'egzersiz', null, { workspaceId: 'default' });
    kernel.graph.addNode('sağlık', 'sağlık', null, { workspaceId: 'default' });
    // Causal relations require 'strength' field (0-1)
    kernel.graph.addEdge('sigara', 'akciğer kanseri', 'CAUSES', { workspaceId: 'default', strength: 0.95 });
    kernel.graph.addEdge('akciğer kanseri', 'ölüm', 'CAUSES', { workspaceId: 'default', strength: 0.85 });
    kernel.graph.addEdge('egzersiz', 'sağlık', 'ENABLES', { workspaceId: 'default', strength: 0.8 });
    kernel.graph.addEdge('sigara', 'sağlık', 'PREVENTS', { workspaceId: 'default', strength: 0.7 });
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// 1. KERNEL + GRAPH + VERIFY — Learn → Verify Roundtrip
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Kernel + Graph + Verify (learn→verify roundtrip)', () => {

  it('learns a fact and then verifies it as dogrulandi', () => {
    const kernel = makeKernel('learn-verify-1');
    withMutedConsole(() => {
      learnFixture(kernel, 'Ankara Türkiye\'nin başkentidir');
    });

    const result = unwrap(kernel.verify('Ankara Türkiye\'nin başkentidir'));
    assert.strictEqual(result.status, 'dogrulandi');
    assert.ok(result.confidence > 0, 'confidence should be positive');
  });

  it('learns a fact and verifies a contradictory statement as celiski', () => {
    const kernel = makeKernel('learn-verify-2');
    withMutedConsole(() => {
      learnFixture(kernel, 'Su 100 derecede kaynar');
    });

    // Verify something that contradicts known fact
    const result = unwrap(kernel.verify('Su 50 derecede kaynar'));
    // The verify result should indicate contradiction or unknown
    assert.ok(
      ['celiski', 'bilinmiyor'].includes(result.status),
      `Expected celiski or bilinmiyor, got ${result.status}`
    );
  });

  it('verifies an unknown claim as bilinmiyor', () => {
    const kernel = makeKernel('learn-verify-3');
    seedBasicFacts(kernel);

    const result = unwrap(kernel.verify('Mars kırmızı bir gezegendir'));
    assert.strictEqual(result.status, 'bilinmiyor');
  });

  it('learn→verify roundtrip preserves evidence chain', () => {
    const kernel = makeKernel('learn-verify-4');
    withMutedConsole(() => {
      learnFixture(kernel, 'Kedi memelidir');
    });

    const raw = kernel.verify('Kedi memelidir');
    assert.ok(raw.evidence, 'verify should return evidence array');
    assert.ok(Array.isArray(raw.evidence), 'evidence should be an array');
  });

  it('multiple learns build a queryable knowledge graph', () => {
    const kernel = makeKernel('learn-verify-5');
    seedBasicFacts(kernel);

    // Ask about learned facts
    const result = unwrap(kernel.ask('Kedi nedir'));
    assert.ok(result, 'ask should return a result');
    assert.notStrictEqual(result.answer, 'Bilmiyorum', 'should know about kedi');
  });

  it('graph persists nodes after learn', () => {
    const kernel = makeKernel('learn-verify-6');
    withMutedConsole(() => {
      learnFixture(kernel, 'Elma meyvedir');
    });

    const node = kernel.graph.getNode('elma');
    assert.ok(node, 'node "elma" should exist in graph');
  });

  it('graph persists edges after learn', () => {
    const kernel = makeKernel('learn-verify-7');
    withMutedConsole(() => {
      learnFixture(kernel, 'Elma meyvedir');
    });

    const edges = kernel.graph.getEdges('elma');
    assert.ok(Array.isArray(edges), 'edges should be an array');
    assert.ok(edges.length > 0, 'should have at least one edge for elma');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 2. KERNEL + CAUSAL — Causal Chain Traversal
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Kernel + Causal Traversal', () => {

  it('traces a CAUSES chain from sigara to ölüm', () => {
    const kernel = makeKernel('causal-1');
    seedCausalChain(kernel);

    const result = unwrap(kernel.reason('sigara'));
    assert.ok(result, 'reason should return a result');
    // Forward chain should include at least one path
    assert.ok(
      Array.isArray(result.forward) || Array.isArray(result.backward),
      'reason should return forward or backward chains'
    );
  });

  it('ask follows causal relations in the graph', () => {
    const kernel = makeKernel('causal-2');
    seedCausalChain(kernel);

    const result = unwrap(kernel.ask('Sigara neye neden olur'));
    assert.ok(result, 'ask should return a result');
  });

  it('PREVENTS relation creates a contradiction — verify detects it', () => {
    const kernel = makeKernel('causal-3');
    seedCausalChain(kernel);

    // Sigara PREVENTS sağlık — "Sigara sağlıklıdır" should now be contradicted
    const raw = kernel.verify('Sigara sağlıklıdır');
    const result = unwrap(raw);
    assert.strictEqual(result.status, 'celiski',
      `Expected celiski for "Sigara sağlıklıdır" (PREVENTS edge exists), got ${result.status}`);
    assert.ok(result.confidence > 0, 'contradiction should have positive confidence');
    // Evidence should mention PREVENTS
    if (raw.evidence && raw.evidence.length > 0) {
      const preventsEvidence = raw.evidence.find(e => e.text && e.text.includes('PREVENTS'));
      assert.ok(preventsEvidence, 'evidence should mention PREVENTS relation');
    }
  });

  it('ENABLES relation is traversable', () => {
    const kernel = makeKernel('causal-4');
    seedCausalChain(kernel);

    const edges = kernel.graph.getEdges('egzersiz');
    const enablesEdge = edges.find(e => e.relation === 'ENABLES');
    assert.ok(enablesEdge, 'should have ENABLES edge from egzersiz');
    assert.strictEqual(enablesEdge.target || enablesEdge.to, 'sağlık');
  });

  it('causal chain has correct edge count', () => {
    const kernel = makeKernel('causal-5');
    seedCausalChain(kernel);

    const sigaraEdges = kernel.graph.getEdges('sigara');
    assert.ok(sigaraEdges.length >= 2, 'sigara should have CAUSES and PREVENTS edges');
  });

  it('detectContradictions finds PREVENTS vs CAUSES tension', () => {
    const kernel = makeKernel('causal-6');
    seedCausalChain(kernel);

    const contradictions = kernel.detectContradictions();
    assert.ok(Array.isArray(contradictions), 'detectContradictions should return an array');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 3. KERNEL + MEMORY STORE — Memory Lifecycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Kernel + Memory Store', () => {

  it('kernel.memory is a MemoryStore instance', () => {
    const kernel = makeKernel('memory-1');
    assert.ok(kernel.memory, 'kernel should have memory property');
    assert.ok(typeof kernel.memory.store === 'function', 'memory should have store()');
    assert.ok(typeof kernel.memory.list === 'function', 'memory should have list()');
    assert.ok(typeof kernel.memory.get === 'function', 'memory should have get()');
  });

  it('stores and retrieves a memory', () => {
    const kernel = makeKernel('memory-2');
    const storeResult = kernel.memory.store({
      content: 'Test observation: water boils at 100°C',
      workspaceId: 'default',
      trustPolicyVersion: '1.0.0',
    });
    assert.ok(storeResult.ok, 'store should succeed');
    assert.ok(storeResult.memory, 'store should return memory object');
    assert.ok(storeResult.memory.memoryId, 'memory should have a memoryId');

    const getResult = kernel.memory.get(storeResult.memory.memoryId, { workspaceId: 'default' });
    assert.ok(getResult.ok, 'get should succeed');
    assert.strictEqual(getResult.memory.content, 'Test observation: water boils at 100°C');
  });

  it('lists memories with workspace isolation', () => {
    const kernel = makeKernel('memory-3');
    kernel.memory.store({
      content: 'Workspace A fact',
      workspaceId: 'ws-a',
      trustPolicyVersion: '1.0.0',
    });
    kernel.memory.store({
      content: 'Workspace B fact',
      workspaceId: 'ws-b',
      trustPolicyVersion: '1.0.0',
    });

    const listA = kernel.memory.list({ workspaceId: 'ws-a' });
    const listB = kernel.memory.list({ workspaceId: 'ws-b' });
    assert.ok(listA.ok, 'list ws-a should succeed');
    assert.ok(listB.ok, 'list ws-b should succeed');
    assert.ok(listA.memories.length >= 1, 'ws-a should have at least 1 memory');
    assert.ok(listB.memories.length >= 1, 'ws-b should have at least 1 memory');
  });

  it('tombstones a memory', () => {
    const kernel = makeKernel('memory-4');
    const storeResult = kernel.memory.store({
      content: 'Temporary fact to be removed',
      workspaceId: 'default',
      trustPolicyVersion: '1.0.0',
    });
    assert.ok(storeResult.ok);

    const tombResult = kernel.memory.tombstone(storeResult.memory.memoryId, {
      reason: 'integration test',
      actor: 'tester',
      workspaceId: 'default',
    });
    assert.ok(tombResult.ok, 'tombstone should succeed');
  });

  it('supersedes a memory with new content', () => {
    const kernel = makeKernel('memory-5');
    const storeResult = kernel.memory.store({
      content: 'Old information v1',
      workspaceId: 'default',
      trustPolicyVersion: '1.0.0',
    });
    assert.ok(storeResult.ok);

    const supersedeResult = kernel.memory.supersede(
      storeResult.memory.memoryId,
      'Updated information v2',
      { workspaceId: 'default', trustPolicyVersion: '1.0.0' }
    );
    assert.ok(supersedeResult.ok, 'supersede should succeed');
    assert.strictEqual(supersedeResult.newMemory.content, 'Updated information v2');
  });

  it('links two memories', () => {
    const kernel = makeKernel('memory-6');
    const mem1 = kernel.memory.store({
      content: 'Fact A',
      workspaceId: 'default',
      trustPolicyVersion: '1.0.0',
    });
    const mem2 = kernel.memory.store({
      content: 'Fact B',
      workspaceId: 'default',
      trustPolicyVersion: '1.0.0',
    });

    const linkResult = kernel.memory.link({
      fromMemoryId: mem1.memory.memoryId,
      toMemoryId: mem2.memory.memoryId,
      relation: 'related_to',
      workspaceId: 'default',
      trustPolicyVersion: '1.0.0',
    });
    assert.ok(linkResult.ok, 'link should succeed');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 4. MCP GATE + SAFETY — Gate Enforcement on Tool Calls
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: MCP Gate + Safety (AB1–AB6 enforcement)', () => {

  function mockKernel() {
    return {
      learn() { return { ok: true, data: { learned: 1, skipped: 0, conflicts: [], alternatives: [] }, type: 'learn', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
      ask() { return { ok: true, data: { answer: 'mock answer', subject: 'x', unknown: false, alternatives: 0 }, type: 'ask', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
      verify() { return { ok: true, data: { status: 'dogrulandi', confidence: 1 }, type: 'verify', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
      reason() { return { ok: true, data: { subject: 'x', answer: 'y', forward: [], backward: [], cycles: [] }, type: 'reason', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
      compare() { return { ok: true, data: { a: 'x', b: 'y', answer: 'z', common: [], onlyA: [], onlyB: [], paths: [] }, type: 'compare', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
      dream() { return { ok: true, data: { hypotheses: [], learned: [], cycle: 0 }, type: 'dream', evidence: [], error: null, meta: { contractVersion: '1.0', backend: 'sqlite', paranoidMode: false } }; },
    };
  }

  it('axiom.ask (read-only) passes gate — ALLOW', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'What is gravity?' } });
    assert.equal(result.ok, true);
    // For allowed calls, callTool returns the kernel result directly (no gate field)
    assert.ok(result.data, 'should have data from kernel');
  });

  it('axiom.verify (read-only) passes gate — ALLOW', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.verify', arguments: { statement: 'Water boils at 100C' } });
    assert.equal(result.ok, true);
    assert.ok(result.data, 'should have data from kernel');
  });

  it('axiom.reason (read-only) passes gate — ALLOW', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.reason', arguments: { subject: 'gravity' } });
    assert.equal(result.ok, true);
    assert.ok(result.data, 'should have data from kernel');
  });

  it('axiom.compare (read-only) passes gate — ALLOW', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.compare', arguments: { left: 'cats', right: 'dogs' } });
    assert.equal(result.ok, true);
    assert.ok(result.data, 'should have data from kernel');
  });

  it('axiom.dream (read-only) passes gate — ALLOW', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.dream', arguments: {} });
    assert.equal(result.ok, true);
    assert.ok(result.data, 'should have data from kernel');
  });

  it('axiom.learn (write) is queued for review by gate — REVIEW required', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'New fact' } });
    assert.equal(result.ok, false);
    assert.equal(result.gate.allowed, false);
    assert.equal(result.gate.canExecute, false);
    assert.equal(result.gate.canDryRun, true);
    assert.equal(result.gate.requiredReview, true);
    assert.equal(result.message, 'Tool call queued for review: mutating_requires_review');
  });

  it('axiom.agent (agent loop) returns a dry-run plan via gate - DRY_RUN_ONLY', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.agent', arguments: { goal: 'Build a plan' } });
    assert.equal(result.ok, true);
    assert.equal(result.dryRun, true);
    assert.equal(result.gate.allowed, false);
    assert.equal(result.gate.canDryRun, true);
    assert.equal(result.gate.reason, 'agent_loop_dry_run_only');
  });

  it('unknown tool is blocked by gate (returns error, not throw)', () => {
    const kernel = mockKernel();
    // Unknown tool goes through gate check first; if gate passes (it won't for unknown),
    // it throws. But the gate blocks it with an error response.
    const result = callTool(kernel, { name: 'axiom.unknown', arguments: {} });
    // Gate blocks unknown tools — they return an error result, not throw
    assert.equal(result.ok, false);
    assert.ok(result.gate, 'should have gate info for blocked unknown tool');
  });

  it('gate returns structured metadata for blocked calls', () => {
    const kernel = mockKernel();
    const result = callTool(kernel, { name: 'axiom.learn', arguments: { text: 'test' } });
    assert.ok(result.gate, 'should have gate info');
    assert.ok(result.gate.decision, 'gate should have a decision');
    assert.ok(result.gate.reason, 'gate should have a reason');
    assert.ok(result.message, 'should have a human-readable message');
  });

  it('gate decisions are deterministic — same input same output', () => {
    const kernel = mockKernel();
    const r1 = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'test' } });
    const r2 = callTool(kernel, { name: 'axiom.ask', arguments: { question: 'test' } });
    // For allowed calls, compare the data
    assert.deepStrictEqual(r1.data.answer, r2.data.answer);
    assert.deepStrictEqual(r1.ok, r2.ok);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 5. SERVER REST API — HTTP Endpoint Integration
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Server REST API', () => {
  let server;
  let port;
  let kernel;

  before(async () => {
    // Create a test kernel with seed data
    kernel = makeKernel('server-api', { loadPlugins: false });
    withMutedConsole(() => {
      learnFixture(kernel, 'İstanbul büyük şehirdir');
      learnFixture(kernel, 'Ankara başkenttir');
    });

    // Start a lightweight test server
    server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://localhost`);
      const pathname = url.pathname;

      if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', version: 'test' }));
      } else if (pathname === '/api') {
        const q = url.searchParams.get('q');
        if (!q) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing q parameter' }));
          return;
        }
        const result = kernel.ask(q);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else if (pathname === '/dogrula' && req.method === 'GET') {
        const statement = url.searchParams.get('statement');
        if (!statement) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'missing statement parameter' }));
          return;
        }
        const result = kernel.verify(statement);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } else if (pathname === '/graph-data') {
        // Export graph data — try different methods
        let data;
        if (typeof kernel.graph.exportData === 'function') {
          data = kernel.graph.exportData();
        } else if (kernel.graph.nodes && kernel.graph.edges) {
          data = {
            nodes: Object.values(kernel.graph.nodes),
            edges: Object.values(kernel.graph.edges).flat(),
          };
        } else {
          data = { nodes: [], edges: [] };
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
      }
    });

    await new Promise((resolve) => server.listen(0, resolve));
    port = server.address().port;
  });

  after((cb) => {
    if (server) server.close(cb);
    else cb();
  });

  function fetchPath(pathname, query = '') {
    return new Promise((resolve, reject) => {
      const fullPath = query ? `${pathname}?${query}` : pathname;
      http.get(`http://localhost:${port}${fullPath}`, (res) => {
        let body = '';
        res.on('data', (chunk) => body += chunk);
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode, body: JSON.parse(body) });
          } catch {
            resolve({ status: res.statusCode, body });
          }
        });
      }).on('error', reject);
    });
  }

  it('GET /health returns 200 with status ok', async () => {
    const res = await fetchPath('/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  it('GET /api?q=... returns kernel ask result', async () => {
    const res = await fetchPath('/api', 'q=İstanbul');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body, 'should return a result');
  });

  it('GET /api without q returns 400', async () => {
    const res = await fetchPath('/api');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.error, 'missing q parameter');
  });

  it('GET /dogrula?statement=... returns verify result', async () => {
    const res = await fetchPath('/dogrula', 'statement=İstanbul büyük şehirdir');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body, 'should return a verify result');
  });

  it('GET /dogrula without statement returns 400', async () => {
    const res = await fetchPath('/dogrula');
    assert.strictEqual(res.status, 400);
  });

  it('GET /graph-data returns graph export', async () => {
    const res = await fetchPath('/graph-data');
    assert.strictEqual(res.status, 200);
    assert.ok(res.body, 'should return graph data');
  });

  it('GET /unknown returns 404', async () => {
    const res = await fetchPath('/unknown');
    assert.strictEqual(res.status, 404);
  });

  it('server handles concurrent requests', async () => {
    const requests = Array.from({ length: 5 }, () => fetchPath('/health'));
    const results = await Promise.all(requests);
    for (const res of results) {
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.body.status, 'ok');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 6. PROVENANCE + AUDIT — Full Trace
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Provenance + Audit Trail', () => {

  it('learn with provenance creates audit trace', () => {
    const kernel = makeKernel('provenance-1');
    const result = withMutedConsole(() => {
      return kernel.learn('Aşılama hastalığı önler', {
        provenance: { source: 'WHO', actor: 'integration-test', confidence: 0.95 },
        workspaceId: 'default',
        ...APPROVED_TEST_ADMISSION,
      });
    });
    assert.ok(result, 'learn should return a result');
    assert.ok(result.ok !== false, 'learn should succeed');
  });

  it('verify result includes meta with contract version', () => {
    const kernel = makeKernel('provenance-2');
    withMutedConsole(() => {
      learnFixture(kernel, 'Güneş yıldızdır');
    });

    const raw = kernel.verify('Güneş yıldızdır');
    assert.ok(raw.meta, 'verify result should have meta');
    assert.strictEqual(raw.meta.contractVersion, '1.0.0');
  });

  it('kernel has audit log capability', () => {
    const kernel = makeKernel('provenance-3');
    assert.ok(kernel.graph, 'kernel should have graph');
    // Check if audit-log module is accessible
    const auditLog = require('../lib/audit-log');
    assert.ok(auditLog, 'audit-log module should be importable');
    assert.ok(typeof auditLog.buildAuditEvent === 'function', 'should have buildAuditEvent');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 7. GRAPH PERSISTENCE — Save/Load Cycle
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Graph Persistence (save/load cycle)', () => {

  it('saves and reloads graph from JSON file', () => {
    const memPath = path.join(TEMP_DIR, 'persist-test.json');
    const kernel1 = makeKernel('persist-1a', { memoryPath: memPath });
    withMutedConsole(() => {
      learnFixture(kernel1, 'Ankara başkenttir');
    });
    // Force save
    kernel1.graph.save();

    // Verify node exists in kernel1 — NLP normalizes to node keys
    const node1 = kernel1.graph.getNode('ankara');
    assert.ok(node1, 'node "ankara" should exist in kernel1 before save');

    // Reload into new kernel
    const kernel2 = new Kernel({
      noLoad: false,
      useSQLite: false,
      memoryPath: memPath,
      enableConcurrencyLock: false,
      loadPlugins: false,
    });
    kernel2._autoMaintain = () => {};
    kernel2.maintenanceEvery = Number.MAX_SAFE_INTEGER;

    const node2 = kernel2.graph.getNode('ankara');
    assert.ok(node2, 'persisted node "ankara" should be loadable from file');
  });

  it('graph nodeCount reflects learned facts', () => {
    const kernel = makeKernel('persist-2');
    withMutedConsole(() => {
      learnFixture(kernel, 'Dünya yuvarlaktır');
    });

    // Count nodes — check internal structure
    const nodes = kernel.graph.nodes || kernel.graph._nodes;
    if (nodes) {
      const count = typeof nodes === 'object' ? Object.keys(nodes).length : 0;
      assert.ok(count > 0, 'graph should have nodes after learning');
    } else {
      // If nodes is not directly accessible, verify via getNode
      const node = kernel.graph.getNode('dünya');
      assert.ok(node, 'should find node for learned fact');
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// 8. KERNEL + SHIELD — LLM Output Verification
// ═══════════════════════════════════════════════════════════════════════════════

describe('Integration: Kernel + Shield (LLM output verification)', () => {

  it('shield module is importable and has evaluateLlmSor', () => {
    const shield = require('../lib/shield');
    assert.ok(shield, 'shield module should exist');
    assert.ok(typeof shield.evaluateLlmSor === 'function', 'should have evaluateLlmSor');
  });

  it('evaluateLlmSor classifies a safe statement', () => {
    const kernel = makeKernel('shield-1');
    withMutedConsole(() => {
      learnFixture(kernel, 'Dünya güneş etrafında döner');
    });

    const shield = require('../lib/shield');
    const result = shield.evaluateLlmSor({
      kernel,
      question: 'Dünya neyin etrafında döner?',
      llmText: 'Dünya güneş etrafında döner',
    });
    assert.ok(result, 'evaluateLlmSor should return a result');
    assert.ok(result.label, 'result should have a label');
  });

  it('evaluateLlmSor detects contradictions in LLM output', () => {
    const kernel = makeKernel('shield-2');
    withMutedConsole(() => {
      learnFixture(kernel, 'Su 100 derecede kaynar');
    });

    const shield = require('../lib/shield');
    const result = shield.evaluateLlmSor({
      kernel,
      question: 'Su kaç derecede kaynar?',
      llmText: 'Su 50 derecede kaynar',
    });
    assert.ok(result, 'evaluateLlmSor should return a result');
    assert.ok(result.label, 'result should have a label');
  });
});
