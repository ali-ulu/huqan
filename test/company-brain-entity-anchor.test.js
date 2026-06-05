'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const createCompanyBrainPlugin = require('../plugins/company-brain').create;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-company-brain-anchor-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

function makeKernel(label, opts = {}) {
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${label}.json`),
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      evidenceRanking: true,
      temporal: true,
    },
    ...opts,
  });
}

function useCompanyBrain(kernel) {
  kernel.usePlugin(createCompanyBrainPlugin());
  return kernel;
}

async function runManual(kernel, text, domain) {
  return kernel.runCapability('companyBrain', {
    action: 'manual',
    sourceType: 'manual',
    author: 'sonfi',
    date: '2026-06-06',
    text,
    domain,
  });
}

function getEdgeByFrom(graph, fromId) {
  const edges = graph.getEdges(fromId, 'default') || [];
  return edges[0] || null;
}

test('companyBrain manual ingest writes entityResolution meta for aviation aliases and survives roundtrip', async () => {
  const writer = useCompanyBrain(makeKernel('persisted-b737'));

  const result = await runManual(writer, 'B737 güvenlidir', 'aviation');
  assert.equal(result.ok, true);

  const edge = getEdgeByFrom(writer.graph, 'b737');
  assert.ok(edge);
  assert.deepStrictEqual(edge.meta.entityResolution, {
    originalLiteral: 'B737',
    canonicalId: 'boeing_737',
    domain: 'aviation',
    matched: true,
    ambiguous: false,
    confidence: 1,
    reason: 'exact_alias',
    aliases: ['b737', 'boeing 737', 'boeing-737'],
  });

  writer.graph.save();

  const reader = useCompanyBrain(new Kernel({
    noLoad: false,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, 'persisted-b737.json'),
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      evidenceRanking: true,
      temporal: true,
    },
  }));

  const reloadedEdge = getEdgeByFrom(reader.graph, 'b737');
  assert.ok(reloadedEdge);
  assert.deepStrictEqual(reloadedEdge.meta.entityResolution, edge.meta.entityResolution);
});

test('companyBrain manual ingest anchors Boeing 737 and B737 to the same canonical id', async () => {
  const kernel = useCompanyBrain(makeKernel('same-canonical'));

  await runManual(kernel, 'B737 güvenlidir', 'aviation');
  kernel.graph.addNode('boeing 737', 'Boeing 737', null, { workspaceId: 'default' });
  await runManual(kernel, 'Boeing 737 güvenlidir', 'aviation');

  const b737Edge = getEdgeByFrom(kernel.graph, 'b737');
  const boeingEdge = getEdgeByFrom(kernel.graph, 'boeing 737');

  assert.ok(b737Edge);
  assert.ok(boeingEdge);
  assert.equal(b737Edge.meta.entityResolution.canonicalId, 'boeing_737');
  assert.equal(boeingEdge.meta.entityResolution.canonicalId, 'boeing_737');
  assert.equal(b737Edge.meta.entityResolution.originalLiteral, 'B737');
  assert.equal(boeingEdge.meta.entityResolution.originalLiteral, 'Boeing 737');
});

test('companyBrain manual ingest does not canonicalize without a domain', async () => {
  const kernel = useCompanyBrain(makeKernel('no-domain'));

  const result = await runManual(kernel, 'AI güvenlidir');
  assert.equal(result.ok, true);

  const edge = getEdgeByFrom(kernel.graph, 'ai');
  assert.ok(edge);
  assert.deepStrictEqual(edge.meta || {}, {});
});

test('companyBrain manual ingest canonicalizes AI only within an explicit domain', async () => {
  const aviation = useCompanyBrain(makeKernel('ai-aviation'));
  const tech = useCompanyBrain(makeKernel('ai-tech'));
  const design = useCompanyBrain(makeKernel('ai-design'));

  await runManual(aviation, 'AI güvenlidir', 'aviation');
  await runManual(tech, 'AI güvenlidir', 'tech');
  await runManual(design, 'AI güvenlidir', 'design');

  assert.equal(getEdgeByFrom(aviation.graph, 'ai').meta.entityResolution.canonicalId, 'air_india');
  assert.equal(getEdgeByFrom(tech.graph, 'ai').meta.entityResolution.canonicalId, 'artificial_intelligence');
  assert.equal(getEdgeByFrom(design.graph, 'ai').meta.entityResolution.canonicalId, 'adobe_illustrator');
});

test('companyBrain manual ingest leaves unknown and ambiguous aliases literal', async () => {
  const kernel = useCompanyBrain(makeKernel('unknown-ambiguous'));

  await runManual(kernel, 'MysteryCo güvenlidir', 'aviation');
  await runManual(kernel, 'AI güvenlidir');

  const unknownEdge = getEdgeByFrom(kernel.graph, 'mysteryco');
  const ambiguousEdge = getEdgeByFrom(kernel.graph, 'ai');

  assert.ok(unknownEdge);
  assert.ok(ambiguousEdge);
  assert.deepStrictEqual(unknownEdge.meta || {}, {});
  assert.deepStrictEqual(ambiguousEdge.meta || {}, {});
});
