'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const createCompanyBrainPlugin = require('../plugins/company-brain').create;
const createRepoMemoryPlugin = require('../plugins/repo-memory').create;

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-company-brain-evidence-'));

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

function usePlugins(kernel) {
  kernel.usePlugin(createCompanyBrainPlugin());
  kernel.usePlugin(createRepoMemoryPlugin());
  return kernel;
}

test('companyBrain query collects incoming markdown section evidence and preserves workspace boundaries', async () => {
  const kernel = usePlugins(makeKernel('markdown-bidirectional'));
  const workspaceADir = path.join(tempDir, 'workspace-a');
  const workspaceBDir = path.join(tempDir, 'workspace-b');
  const workspaceAFile = path.join(workspaceADir, 'notes.md');
  const workspaceBFile = path.join(workspaceBDir, 'notes.md');

  fs.mkdirSync(workspaceADir, { recursive: true });
  fs.mkdirSync(workspaceBDir, { recursive: true });
  fs.writeFileSync(workspaceAFile, '# Trust Kernel\nA path.\n\n# Workspace Izolasyonu\nB path.\n', 'utf8');
  fs.writeFileSync(workspaceBFile, '# Trust Kernel\nLeak path.\n', 'utf8');

  const ingestA = await kernel.runCapability('repoMemory', {
    action: 'ingest',
    sourceType: 'markdown',
    path: workspaceAFile,
    rootPath: workspaceADir,
    workspaceId: 'workspace-a',
    actor: 'repo-bot-a',
    timestamp: '2026-06-16T10:00:00Z',
  });
  assert.equal(ingestA.ok, true);

  const ingestB = await kernel.runCapability('repoMemory', {
    action: 'ingest',
    sourceType: 'markdown',
    path: workspaceBFile,
    rootPath: workspaceBDir,
    workspaceId: 'workspace-b',
    actor: 'repo-bot-b',
    timestamp: '2026-06-16T10:05:00Z',
  });
  assert.equal(ingestB.ok, true);

  const trustResult = await kernel.runCapability('companyBrain', {
    question: 'Trust Kernel',
    workspaceId: 'workspace-a',
  });
  assert.equal(trustResult.ok, true);
  assert.equal(trustResult.mode, 'graph');
  assert.ok(trustResult.evidence.length > 0);

  const trustIncoming = trustResult.evidence.find((edge) =>
    edge.relation === 'özellik'
    && edge.to.includes('Trust Kernel')
    && edge.from.startsWith('file:')
  );
  assert.ok(trustIncoming);
  assert.equal(trustIncoming.source_type, 'document');
  assert.ok(trustIncoming.source_ref);
  assert.equal(trustIncoming.workspaceId, 'workspace-a');
  assert.equal(trustIncoming.provenance?.sourceType, 'document');
  assert.equal(trustIncoming.provenance?.workspaceId, 'workspace-a');
  assert.equal(typeof trustIncoming.confidence, 'number');
  assert.ok(trustIncoming.confidence > 0);
  assert.equal(trustResult.sourceRefs.includes(trustIncoming.source_ref), true);
  assert.equal(trustResult.evidence.some((edge) => edge.workspaceId === 'workspace-b'), false);

  const izolasyonResult = await kernel.runCapability('companyBrain', {
    question: 'Workspace Izolasyonu',
    workspaceId: 'workspace-a',
  });
  assert.equal(izolasyonResult.ok, true);
  assert.equal(izolasyonResult.mode, 'graph');
  assert.ok(izolasyonResult.evidence.some((edge) =>
    edge.relation === 'özellik'
    && edge.to.includes('Workspace Izolasyonu')
    && edge.from.startsWith('file:')
  ));

  const trustWorkspaceB = await kernel.runCapability('companyBrain', {
    question: 'Trust Kernel',
    workspaceId: 'workspace-b',
  });
  assert.equal(trustWorkspaceB.ok, true);
  assert.equal(trustWorkspaceB.mode, 'graph');
  assert.equal(trustWorkspaceB.evidence.every((edge) => edge.workspaceId === 'workspace-b'), true);
  assert.equal(trustWorkspaceB.evidence.some((edge) => (edge.source_ref || '').includes('workspace-a')), false);
});

test('companyBrain decision query keeps outgoing evidence and dedupes repeated matched edges', async () => {
  const kernel = usePlugins(makeKernel('decision-regression'));

  const ingested = await kernel.runCapability('companyBrain', {
    action: 'decision',
    sourceType: 'decision',
    title: 'SQLite kullan',
    rationale: 'Yerel kalicilik gerekli',
    alternatives: ['JSON kullan', 'Sadece memory kullan'],
    links: ['kalicilik', 'veri'],
    decidedBy: 'sonfi',
    date: '2026-06-16',
  });
  assert.equal(ingested.ok, true);

  const result = await kernel.runCapability('companyBrain', {
    question: 'SQLite kullan',
    workspaceId: 'default',
  });

  assert.equal(result.ok, true);
  assert.equal(result.mode, 'graph');
  assert.ok(result.evidence.length >= 3);
  assert.ok(result.evidence.some((edge) => edge.from.startsWith('decision:sqlite-kullan')));
  assert.ok(result.evidence.some((edge) => edge.relation === 'açıklar'));
  assert.ok(result.evidence.some((edge) => edge.relation === 'alternatif'));
  assert.ok(result.evidence.some((edge) => edge.relation === 'decides'));

  const uniqueKeys = new Set(result.evidence.map((edge) => [
    edge.from,
    edge.relation,
    edge.to,
    edge.source_ref,
    edge.workspaceId,
  ].join('|')));
  assert.equal(uniqueKeys.size, result.evidence.length);
});

test('companyBrain ranking preserves normalized default scope and insertion order without node touches', async () => {
  const kernel = makeKernel('ranking-read-baseline');
  kernel.usePlugin(createCompanyBrainPlugin());

  try {
    for (let index = 0; index < 9; index += 1) {
      const nodeId = `match-${index}`;
      const targetId = `target-${index}`;
      kernel.graph.addNode(nodeId, `shared match ${index}`);
      kernel.graph.addNode(targetId, `target ${index}`);
      kernel.graph.addEdge(nodeId, targetId, 'supports', {
        evidence: [`evidence-${index}`],
      });
    }
    kernel.graph.addNode('match-0', 'shared tenant match', null, { workspaceId: 'tenant-a' });
    kernel.graph.addNode('tenant-target', 'tenant target', null, { workspaceId: 'tenant-a' });
    kernel.graph.addEdge('match-0', 'tenant-target', 'supports', {
      workspaceId: 'tenant-a',
      evidence: ['tenant-evidence'],
    });

    let accessValue = 100;
    for (const node of Object.values(kernel.graph._nodes)) {
      node.lastAccessed = accessValue;
      accessValue += 1;
    }
    const before = JSON.parse(JSON.stringify(kernel.graph._nodes));

    const result = await kernel.runCapability('companyBrain', {
      question: 'shared',
      workspaceId: '   ',
    });

    assert.equal(result.ok, true);
    assert.equal(result.mode, 'graph');
    assert.deepEqual(
      result.evidence.map(edge => edge.from),
      Array.from({ length: 8 }, (_value, index) => `match-${index}`),
    );
    assert.equal(result.evidence.some(edge => edge.workspaceId === 'tenant-a'), false);
    assert.ok(kernel.graph._nodes['tenant-a::match-0']);
    assert.deepEqual(kernel.graph._nodes, before);
  } finally {
    kernel.graph.close?.();
    kernel.memory.close?.();
  }
});
