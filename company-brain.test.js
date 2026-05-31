const test = require('node:test');
const assert = require('node:assert/strict');

const Kernel = require('./kernel');
const createRepoMemoryPlugin = require('./plugins/repo-memory').create;
const createCompanyBrainPlugin = require('./plugins/company-brain').create;

function makeKernel() {
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    capabilities: {
      companyMode: true,
      pluginCapabilities: true,
      evidenceRanking: true,
      temporal: true,
    },
  });
}

function makeResponse({ ok = true, status = 200, json, text, headers = {} }) {
  return {
    ok,
    status,
    json: async () => (typeof json === 'function' ? json() : json),
    text: async () => (typeof text === 'function' ? text() : text),
    headers: {
      get(name) {
        return headers[String(name).toLowerCase()] || null;
      },
    },
  };
}

test('company-brain: manual ingest creates company metadata edges', async () => {
  const k = makeKernel();
  k.usePlugin(createCompanyBrainPlugin());

  const result = await k.runCapability('companyBrain', {
    action: 'manual',
    sourceType: 'manual',
    author: 'sonfi',
    date: '2026-05-31',
    text: 'kedi hayvandir',
  });

  assert.equal(result.ok, true);
  const edges = k.graph.getEdges('kedi');
  assert.equal(edges.length > 0, true);
  assert.equal(edges.some(edge => edge.source_type === 'manual'), true);
  assert.equal(edges.some(edge => edge.company_mode === 1), true);
});

test('company-brain: decision log writes decides edges', async () => {
  const k = makeKernel();
  k.usePlugin(createCompanyBrainPlugin());

  const result = await k.runCapability('companyBrain', {
    action: 'decision',
    sourceType: 'decision',
    title: 'Graph fallback strategy',
    rationale: 'Need deterministic fallback',
    decidedBy: 'team',
    date: '2026-05-31',
    links: ['repo:ai-ulu/axiom:README.md'],
  });

  assert.equal(result.ok, true);
  const decisionEdges = k.graph.getEdges(result.decisionId);
  assert.equal(decisionEdges.some(edge => edge.relation === 'decides'), true);
});

test('company-brain: repo-memory ingests github markdown and updates ingest status', async () => {
  const k = makeKernel();
  k.usePlugin(createRepoMemoryPlugin());
  k.usePlugin(createCompanyBrainPlugin());

  const fetchImpl = async (url) => {
    if (url.includes('/git/trees/')) {
      return makeResponse({
        json: {
          tree: [
            { type: 'blob', path: 'README.md' },
            { type: 'blob', path: '.github/SECURITY.md' },
            { type: 'blob', path: 'src/index.js' },
          ],
        },
      });
    }
    return makeResponse({
      text: '# Header\ncontent',
      headers: { 'last-modified': 'Mon, 01 Jan 2024 00:00:00 GMT' },
    });
  };

  const ingest = await k.runCapability('repoMemory', {
    action: 'ingest',
    sourceType: 'github',
    repoUrl: 'https://github.com/ai-ulu/axiom',
    fetchImpl,
  });

  assert.equal(ingest.ok, true);
  assert.equal(ingest.files, 2);

  const status = await k.runCapability('ingestStatus', {});
  assert.equal(status.ok, true);
  assert.equal(status.distribution.repo > 0, true);
});

test('company-brain: graph-backed query returns source refs', async () => {
  const k = makeKernel();
  k.usePlugin(createCompanyBrainPlugin());
  await k.runCapability('companyBrain', {
    action: 'manual',
    sourceType: 'manual',
    author: 'sonfi',
    date: '2026-05-31',
    text: 'axiom motordur',
  });

  const query = await k.runCapability('companyBrain', {
    action: 'query',
    question: 'axiom ne icin',
  });

  assert.equal(query.ok, true);
  assert.equal(query.source, 'graph');
  assert.equal(Array.isArray(query.sourceRefs), true);
});
