const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const repoMemoryModule = require('../plugins/repo-memory');

function makeKernel() {
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      temporal: true,
    },
  });
}

function makeProvenance(overrides = {}) {
  return {
    provenanceId: 'prov-connector-test',
    sourceRef: 'github://owner/repo/source',
    sourceTitle: 'Connector admission test',
    sourceType: 'github',
    sourceSubType: 'repository_document',
    actor: 'connector:repo-memory',
    timestamp: '2026-06-23T00:00:00.000Z',
    confidence: 0.8,
    workspaceId: 'workspace-a',
    ...overrides,
  };
}

function makeResponse({ json, text, headers = {} }) {
  return {
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => text,
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
  };
}

test('connector edge without valid provenance is rejected before canonical graph mutation', () => {
  const kernel = makeKernel();

  const result = repoMemoryModule._test.addCompanyEdge(
    kernel,
    'repo:owner/repo',
    'repo:owner/repo:README.md',
    'CONTAINS',
    { workspaceId: 'workspace-a' },
  );

  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'CONNECTOR_PROVENANCE_REQUIRED');
  assert.equal(kernel.graph.getEdge('repo:owner/repo', 'repo:owner/repo:README.md', 'CONTAINS', 'workspace-a'), null);
});

test('connector edge with invalid provenance is rejected before canonical graph mutation', () => {
  const kernel = makeKernel();
  const result = repoMemoryModule._test.addCompanyEdge(
    kernel,
    'repo:owner/repo',
    'repo:owner/repo:SECURITY.md',
    'CONTAINS',
    {
      workspaceId: 'workspace-a',
      provenance: makeProvenance({ sourceType: 'untrusted-custom-source', confidence: 2 }),
      source: 'repo',
      sourceRef: 'github://owner/repo/source',
      sourceType: 'untrusted-custom-source',
      evidence: ['SECURITY.md'],
      confidence: 2,
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.admitted, false);
  assert.equal(kernel.graph.getEdge('repo:owner/repo', 'repo:owner/repo:SECURITY.md', 'CONTAINS', 'workspace-a'), null);
});

test('conflicting connector edge remains pending and does not enter canonical graph', () => {
  const kernel = makeKernel();
  kernel.graph.addNode('service-a', 'service-a', null, { workspaceId: 'workspace-a' });
  kernel.graph.addNode('service-b', 'service-b', null, { workspaceId: 'workspace-a' });
  kernel.graph.addEdge('service-a', 'service-b', 'SUPPORTS', { workspaceId: 'workspace-a' });

  const result = repoMemoryModule._test.addCompanyEdge(
    kernel,
    'service-a',
    'service-b',
    'OPPOSES',
    {
      workspaceId: 'workspace-a',
      provenance: makeProvenance(),
      source: 'repo',
      sourceRef: 'github://owner/repo/source',
      sourceType: 'github',
      evidence: ['conflicting connector claim'],
      confidence: 0.8,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.admitted, false);
  assert.equal(result.candidate.status, 'pending');
  assert.equal(result.candidate.recommendation, 'flag');
  assert.equal(kernel.graph.getEdge('service-a', 'service-b', 'OPPOSES', 'workspace-a'), null);
});

test('admitted connector edge preserves provenance and source evidence', () => {
  const kernel = makeKernel();
  const provenance = makeProvenance();

  const result = repoMemoryModule._test.addCompanyEdge(
    kernel,
    'repo:owner/repo',
    'repo:owner/repo:README.md',
    'CONTAINS',
    {
      workspaceId: 'workspace-a',
      provenance,
      source: 'repo',
      sourceRef: provenance.sourceRef,
      sourceType: 'github',
      sessionId: 'session-1',
      evidenceType: 'docs',
      companyMode: true,
      evidence: ['README.md'],
      confidence: 0.8,
    },
  );

  assert.equal(result.ok, true);
  assert.equal(result.admitted, true);
  assert.equal(result.candidate.status, 'accepted');
  const edge = kernel.graph.getEdge('repo:owner/repo', 'repo:owner/repo:README.md', 'CONTAINS', 'workspace-a');
  assert.ok(edge);
  assert.equal(edge.provenance.provenanceId, provenance.provenanceId);
  assert.equal(edge.provenance.sourceRef, provenance.sourceRef);
  assert.equal(edge.source_type, 'github');
  assert.equal(edge.session_id, 'session-1');
  assert.equal(edge.evidence_type, 'docs');
  assert.equal(edge.company_mode, 1);
  assert.deepEqual(edge.evidence, ['README.md']);
});

test('repo-memory GitHub and Markdown paths route through candidate admission', async (t) => {
  const kernel = makeKernel();
  kernel.usePlugin(repoMemoryModule.create());

  const fetchImpl = async (url) => {
    if (url.includes('/git/trees/')) {
      return makeResponse({ json: { tree: [{ type: 'blob', path: 'README.md' }] } });
    }
    return makeResponse({
      text: '# Header\ncontent',
      headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    });
  };

  const github = await kernel.runCapability('repoMemory', {
    action: 'ingest',
    sourceType: 'github',
    repoUrl: 'https://github.com/owner/repo',
    workspaceId: 'workspace-a',
    fetchImpl,
  });
  assert.equal(github.ok, true);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-connector-admission-'));
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }));
  const markdownPath = path.join(tempDir, 'notes.md');
  fs.writeFileSync(markdownPath, '# Note\ntrusted connector text', 'utf8');

  const markdown = await kernel.runCapability('repoMemory', {
    action: 'ingest',
    sourceType: 'markdown',
    path: markdownPath,
    workspaceId: 'workspace-a',
  });
  assert.equal(markdown.ok, true);

  const candidates = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' });
  assert.ok(candidates.length >= 3);
  assert.ok(candidates.every(candidate => candidate.provenance));
  assert.ok(candidates.some(candidate => candidate.provenance.sourceType === 'github'));
  assert.ok(candidates.some(candidate => candidate.provenance.sourceType === 'document'));
});
