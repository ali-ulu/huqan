const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const repoMemory = require('./repo-memory');

function makeKernel() {
  const edges = [];
  const nodes = [];
  return {
    edges,
    nodes,
    graph: {
      addNode(id, label, provenance, opts) {
        nodes.push({ id, label, provenance, opts });
      },
      addEdge(from, to, relation, meta) {
        const edge = { from, to, relation, meta };
        edges.push(edge);
        return edge;
      },
    },
    proposeNode(id, label, provenance, opts) {
      nodes.push({ id, label, provenance, opts });
      return { id };
    },
    proposeEdge(from, to, relation, opts) {
      const edge = { from, to, relation, meta: opts };
      edges.push(edge);
      return { decision: 'allow', edge, audit: { eventType: 'LEARN' } };
    },
    hasCapability(name) {
      return name === 'temporal' ? false : true;
    },
  };
}

test('repo-memory markdown ingest requires an explicit root and stays inside it', async () => {
  const kernel = makeKernel();
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-repo-root-'));
  const nestedDir = path.join(rootDir, 'docs');
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-repo-outside-'));
  const insideFile = path.join(nestedDir, 'safe.md');
  const outsideFile = path.join(outsideDir, 'secret.md');
  fs.mkdirSync(nestedDir, { recursive: true });
  fs.writeFileSync(insideFile, '# Safe\ninside text', 'utf8');
  fs.writeFileSync(outsideFile, '# Secret\noutside text', 'utf8');

  try {
    const missingRoot = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: insideFile,
    });
    assert.equal(missingRoot.ok, false);
    assert.equal(missingRoot.code, 'MARKDOWN_ROOT_REQUIRED');

    const safe = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: insideFile,
      rootPath: rootDir,
      workspaceId: 'workspace-a',
      actor: 'repo-bot',
    });
    assert.equal(safe.ok, true);
    assert.equal(safe.admission.outcome, 'admitted');
    assert.ok(Array.isArray(safe.admission.entries));
    assert.ok(safe.admission.entries.length >= 3);
    assert.ok(safe.admission.entries.every((entry) => entry.outcome === 'admitted'));
    assert.equal(safe.files, 1);
    assert.ok(safe.added >= 1);
    assert.ok(kernel.nodes.some((node) => node.provenance
      && node.provenance.sourceType === 'document'
      && node.provenance.actor === 'repo-bot'
      && node.provenance.workspaceId === 'workspace-a'));
    assert.ok(kernel.edges.some((edge) => edge.meta
      && edge.meta.provenance
      && edge.meta.provenance.sourceType === 'document'
      && edge.meta.provenance.actor === 'repo-bot'
      && edge.meta.provenance.workspaceId === 'workspace-a'));

    const beforeEdges = kernel.edges.length;
    const escaped = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: path.join(rootDir, '..', path.basename(outsideFile)),
      rootPath: rootDir,
    });
    assert.equal(escaped.ok, false);
    assert.equal(escaped.code, 'PATH_OUTSIDE_ALLOWED_ROOT');
    assert.equal(kernel.edges.length, beforeEdges);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test('repo-memory github ingest preserves provenance on nodes and edges', async () => {
  const kernel = makeKernel();
  const result = await repoMemory.run(kernel, {
    action: 'ingest',
    sourceType: 'github',
    repoUrl: 'https://github.com/owner/repo',
    workspaceId: 'workspace-b',
    actor: 'connector-bot',
    fetchRepoFiles: async () => [{
      owner: 'owner',
      repo: 'repo',
      branch: 'main',
      path: 'docs/claim.md',
      content: '# Claim\nHello world',
      lastModified: '2026-06-15T10:00:00Z',
    }],
    parseRepoUrl: () => ({ owner: 'owner', repo: 'repo' }),
  });

  assert.equal(result.ok, true);
  assert.equal(result.admission.outcome, 'admitted');
  assert.ok(Array.isArray(result.admission.entries));
  assert.ok(result.admission.entries.some((entry) => entry.targetType === 'graph_node' && entry.targetId === 'repo:owner/repo'));
  assert.ok(result.admission.entries.some((entry) => entry.targetType === 'graph_edge' && /repo:owner\/repo:docs\/claim\.md/.test(entry.sourceRef || '')));
  assert.ok(kernel.nodes.some((node) => node.id === 'repo:owner/repo'));
  assert.ok(kernel.nodes.some((node) => node.provenance
    && node.provenance.sourceType === 'github'
    && node.provenance.actor === 'connector-bot'
    && node.provenance.workspaceId === 'workspace-b'));
  assert.ok(kernel.edges.some((edge) => edge.meta
    && edge.meta.provenance
    && edge.meta.provenance.sourceType === 'github'
    && edge.meta.provenance.actor === 'connector-bot'
    && edge.meta.provenance.workspaceId === 'workspace-b'));
  assert.ok(kernel.edges.some((edge) => /repo:owner\/repo:docs\/claim\.md/.test(edge.meta?.provenance?.sourceRef || '')));
});

test('repo-memory forwards proposal receipts without generating connector audit or operation ids', async () => {
  const kernel = makeKernel();
  let receiptSequence = 0;
  let auditCalls = 0;
  kernel.appendAuditEvent = () => {
    auditCalls += 1;
  };
  kernel._appendAuditEvent = () => {
    auditCalls += 1;
  };
  kernel.proposeNode = (id, label, provenance, opts) => {
    kernel.nodes.push({ id, label, provenance, opts });
    receiptSequence += 1;
    return {
      decision: 'allow',
      node: { id },
      admission: { receiptId: `receipt-node-${receiptSequence}` },
    };
  };
  kernel.proposeEdge = (from, to, relation, opts) => {
    const edge = { from, to, relation, meta: opts };
    kernel.edges.push(edge);
    return {
      decision: 'allow',
      edge,
      admission: { receiptId: 'receipt-edge-1' },
    };
  };

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-repo-receipt-'));
  const file = path.join(rootDir, 'claim.md');
  fs.writeFileSync(file, '# Claim\nreceipt forwarding', 'utf8');

  try {
    const result = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'markdown',
      path: file,
      rootPath: rootDir,
      workspaceId: 'workspace-receipt',
      timestamp: '2026-07-31T00:00:00.000Z',
    });
    const githubResult = await repoMemory.run(kernel, {
      action: 'ingest',
      sourceType: 'github',
      repoUrl: 'https://github.com/owner/repo',
      workspaceId: 'workspace-receipt',
      actor: 'connector-test',
      fetchRepoFiles: async () => [{
        path: 'README.md',
        content: '# Repository\nreceipt forwarding',
        lastModified: '2026-07-31T00:00:00.000Z',
      }],
      parseRepoUrl: () => ({ owner: 'owner', repo: 'repo' }),
    });

    assert.equal(result.admission.outcome, 'admitted');
    assert.equal(githubResult.admission.outcome, 'admitted');
    assert.ok(result.admissions.some((entry) => /^receipt-node-/.test(entry.receiptId || '')));
    assert.ok(result.admissions.some((entry) => entry.receiptId === 'receipt-edge-1'));
    assert.ok(githubResult.admissions.some((entry) => /^receipt-node-/.test(entry.receiptId || '')));
    assert.ok(githubResult.admissions.some((entry) => entry.receiptId === 'receipt-edge-1'));
    assert.ok([...result.admissions, ...githubResult.admissions]
      .every((entry) => !Object.hasOwn(entry, 'mutationOperationId')));
    assert.equal(Object.hasOwn(result, 'mutationOperationId'), false);
    assert.equal(Object.hasOwn(githubResult, 'mutationOperationId'), false);
    assert.equal(auditCalls, 0);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
