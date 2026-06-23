const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Kernel = require('../kernel');
const repoMemory = require('../plugins/repo-memory');
const { AUDIT_EVENTS } = require('../lib/audit-log');

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-connector-admission-'));

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

function makeKernel(name) {
  const dir = fs.mkdtempSync(path.join(tempRoot, `${name}-`));
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(dir, 'memory.json'),
    dbPath: path.join(dir, 'memory.db'),
  });
}

function markdownFixture(name, body) {
  const dir = fs.mkdtempSync(path.join(tempRoot, `${name}-`));
  const file = path.join(dir, 'README.md');
  fs.writeFileSync(file, body, 'utf8');
  return file;
}

function edgeCount(kernel, from, workspaceId = 'default') {
  return kernel.graph.getEdges(from, workspaceId).length;
}

test('repo-memory markdown ingest routes connector data to pending candidate, not canonical graph', async () => {
  const kernel = makeKernel('markdown-pending');
  const file = markdownFixture('pending-doc', '# Runtime\n\nHUQAN records trust decisions.');

  const result = await repoMemory.run(kernel, {
    sourceType: 'markdown',
    path: file,
    workspaceId: 'workspace-a',
    actor: 'connector:test',
  });

  assert.equal(result.ok, true);
  assert.equal(result.admission.status, 'pending');
  assert.equal(result.added, 1);

  const claims = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, 'pending');
  assert.equal(claims[0].provenance.sourceType, 'document');
  assert.equal(claims[0].provenance.sourceSubType, 'markdown_section');
  assert.match(claims[0].provenance.sourceRef, /README\.md:Runtime$/);
  assert.equal(edgeCount(kernel, `file:${file}`, 'workspace-a'), 0);
});

test('repo-memory github ingest routes connector data to pending candidate, not canonical graph', async () => {
  const kernel = makeKernel('github-pending');
  let fetchCount = 0;

  const result = await repoMemory.run(kernel, {
    sourceType: 'github',
    repoUrl: 'https://github.com/acme/demo',
    workspaceId: 'workspace-a',
    actor: 'connector:test',
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return {
          ok: true,
          json: async () => ({
            tree: [{
              path: 'README.md',
              type: 'blob',
              url: 'https://api.github.local/blob/1',
            }],
          }),
        };
      }
      return {
        ok: true,
        headers: { get: () => '2026-06-24T00:00:00Z' },
        text: async () => '# Runtime\n\nHUQAN records trust decisions.',
      };
    },
    branch: 'main',
    paths: ['README.md'],
  });

  assert.equal(result.ok, true);
  assert.equal(result.admission.status, 'pending');

  const claims = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' });
  assert.equal(claims.length, 2);
  assert.ok(claims.every(claim => claim.status === 'pending'));
  assert.ok(claims.every(claim => claim.provenance.sourceType === 'github'));
  assert.ok(claims.some(claim => claim.provenance.sourceRef === 'github://acme/demo/blob/main/README.md'));
  assert.ok(claims.some(claim => claim.provenance.sourceRef === 'github://acme/demo/blob/main/README.md#Runtime'));
  assert.equal(edgeCount(kernel, 'repo:acme/demo', 'workspace-a'), 0);
});

test('repo-memory accepted connector candidate writes canonical graph with provenance and audit', async () => {
  const kernel = makeKernel('accepted');
  const file = markdownFixture('accepted-doc', '# Accepted\n\nApproved connector data.');

  const result = await repoMemory.run(kernel, {
    sourceType: 'markdown',
    path: file,
    workspaceId: 'workspace-a',
    actor: 'connector:test',
    accept: true,
  });

  assert.equal(result.ok, true);
  assert.equal(result.admission.status, 'accepted');

  const claims = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].status, 'accepted');

  const edges = kernel.graph.getEdges(`file:${file}`, 'workspace-a');
  assert.equal(edges.length, 1);
  assert.equal(edges[0].relation, 'özellik');
  assert.equal(edges[0].provenance.sourceType, 'document');
  assert.equal(edges[0].provenance.sourceSubType, 'markdown_section');
  assert.match(edges[0].provenance.sourceRef, /README\.md:Accepted$/);

  const accepted = kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.CLAIM_ACCEPTED, workspaceId: 'workspace-a' });
  assert.equal(accepted.length, 1);
});

test('repo-memory conflicting connector candidate stays pending and does not write canonical graph', async () => {
  const kernel = makeKernel('conflict');
  kernel.graph.addNode('connector:source', 'connector:source', null, { workspaceId: 'workspace-a' });
  kernel.graph.addNode('canonical-target', 'canonical-target', null, { workspaceId: 'workspace-a' });
  kernel.graph.addEdge('connector:source', 'canonical-target', 'SUPPORTS', {
    workspaceId: 'workspace-a',
    confidence: 0.95,
  });

  const result = await repoMemory.run(kernel, {
    sourceType: 'admission',
    workspaceId: 'workspace-a',
    actor: 'connector:test',
    sourceRef: 'connector://conflict/1',
    sourceTitle: 'conflicting claim',
    claim: 'connector source opposes canonical target',
    proposedEdge: {
      from: 'connector:source',
      relation: 'OPPOSES',
      to: 'canonical-target',
      confidence: 0.2,
      workspaceId: 'workspace-a',
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.admission.status, 'pending');
  assert.equal(result.admission.recommendation, 'flag');
  assert.equal(kernel.graph.getEdge('connector:source', 'canonical-target', 'OPPOSES', 'workspace-a'), null);

  const conflictEvents = kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.CONFLICT_DETECTED, workspaceId: 'workspace-a' });
  assert.equal(conflictEvents.length, 1);
});

test('repo-memory malformed connector payload fails closed without canonical graph write', async () => {
  const kernel = makeKernel('malformed');

  const result = await repoMemory.run(kernel, {
    sourceType: 'admission',
    workspaceId: 'workspace-a',
    actor: 'connector:test',
    sourceTitle: 'missing source ref',
    claim: 'bad connector claim',
    proposedEdge: {
      from: 'bad',
      relation: 'reports',
      to: 'claim',
      workspaceId: 'workspace-a',
    },
    strictProvenance: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.code, 'INGEST_FAILED');
  assert.equal(kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' }).length, 0);
  assert.equal(edgeCount(kernel, 'bad', 'workspace-a'), 0);
});
