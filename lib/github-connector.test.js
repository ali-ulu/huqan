const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');
const Graph = require('../graph');
const { AUDIT_EVENTS } = require('./audit-log');
const {
  GITHUB_SOURCE_TYPES,
  buildGitHubProvenance,
  normalizeGitHubItem,
  ingestGitHubItem,
  ingestGitHubItems,
} = require('./github-connector');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-github-'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makePaths(name) {
  return {
    memoryPath: path.join(tempDir, `${name}.json`),
    dbPath: path.join(tempDir, `${name}.db`),
  };
}

function makeBaseItem(overrides = {}) {
  return {
    sourceSubType: GITHUB_SOURCE_TYPES.merged_pr,
    repo: 'owner/repo',
    number: 123,
    title: 'Add provenance schema',
    url: 'https://github.com/owner/repo/pull/123',
    actor: 'github:user',
    timestamp: '2026-06-02T10:00:00Z',
    body: 'PR body',
    labels: [],
    workspaceId: 'default',
    ...overrides,
  };
}

test('buildGitHubProvenance derives github provenance from trust policy', () => {
  const { provenance, warnings } = buildGitHubProvenance(makeBaseItem(), {});

  assert.strictEqual(provenance.sourceType, 'github');
  assert.strictEqual(provenance.sourceSubType, 'merged_pr');
  assert.strictEqual(provenance.sourceRef, 'github://owner/repo/pull/123');
  assert.strictEqual(provenance.sourceTitle, 'Add provenance schema');
  assert.strictEqual(provenance.actor, 'github:user');
  assert.strictEqual(provenance.workspaceId, 'default');
  assert.strictEqual(provenance.trustPolicyVersion, '0.8.0');
  assert.strictEqual(provenance.confidence, 0.8);
  assert.ok(Array.isArray(warnings));
});

test('buildGitHubProvenance supports release and unknown source subtypes', () => {
  const release = buildGitHubProvenance(makeBaseItem({
    sourceSubType: GITHUB_SOURCE_TYPES.release_tag,
    tag: 'v0.8.0',
    title: 'AXIOM v0.8.0',
    url: 'https://github.com/owner/repo/releases/tag/v0.8.0',
  }));
  assert.strictEqual(release.provenance.sourceRef, 'github://owner/repo/releases/tag/v0.8.0');
  assert.strictEqual(release.provenance.confidence, 0.9);

  const unknown = buildGitHubProvenance(makeBaseItem({
    sourceSubType: 'mystery_type',
    number: 77,
  }));
  assert.strictEqual(unknown.provenance.sourceRef, 'github://owner/repo/items/mystery_type/77');
  assert.ok(unknown.warnings.some((warning) => /unknown GitHub sourceSubType/i.test(warning)));
});

test('normalizeGitHubItem normalizes PR, issue, commit, and release items', () => {
  const pr = normalizeGitHubItem(makeBaseItem({ sourceSubType: GITHUB_SOURCE_TYPES.open_pr }));
  const issue = normalizeGitHubItem(makeBaseItem({
    sourceSubType: GITHUB_SOURCE_TYPES.closed_issue,
    number: 456,
    title: 'Bug fixed',
    url: 'https://github.com/owner/repo/issues/456',
  }));
  const commit = normalizeGitHubItem(makeBaseItem({
    sourceSubType: GITHUB_SOURCE_TYPES.commit_message,
    sha: 'abc123',
    number: undefined,
    title: 'feat: add audit log',
    url: 'https://github.com/owner/repo/commit/abc123',
  }));
  const release = normalizeGitHubItem(makeBaseItem({
    sourceSubType: GITHUB_SOURCE_TYPES.release_tag,
    tag: 'v0.8.0',
    number: undefined,
    title: 'AXIOM v0.8.0',
  }));

  assert.strictEqual(pr.claim, 'PR 123 opened in owner/repo: Add provenance schema');
  assert.strictEqual(issue.claim, 'Issue 456 closed in owner/repo: Bug fixed');
  assert.strictEqual(commit.claim, 'Commit abc123 in owner/repo: feat: add audit log');
  assert.strictEqual(release.claim, 'Release v0.8.0 published in owner/repo: AXIOM v0.8.0');
  assert.strictEqual(pr.proposedEdge.from, 'github:owner/repo');
  assert.strictEqual(pr.proposedEdge.relation, 'reports');
});

test('ingestGitHubItem creates candidate provenance and imported audit', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('import-basic') });

  const result = ingestGitHubItem(kernel, makeBaseItem({ workspaceId: 'workspace-a' }), { workspaceId: 'workspace-a' });

  assert.strictEqual(result.duplicate, false);
  assert.strictEqual(result.provenance.sourceType, 'github');
  assert.strictEqual(result.provenance.sourceRef, 'github://owner/repo/pull/123');
  assert.strictEqual(result.provenance.actor, 'github:user');
  assert.strictEqual(result.provenance.workspaceId, 'workspace-a');
  assert.strictEqual(result.candidate.workspaceId, 'workspace-a');
  assert.strictEqual(result.candidate.status, 'pending');
  assert.strictEqual(result.admission.outcome, 'candidate');
  assert.strictEqual(result.admission.targetType, 'candidate_claim');
  assert.strictEqual(result.admission.graphWrite, false);

  const stored = kernel.graph.getCandidateClaims({
    workspaceId: 'workspace-a',
    sourceRef: 'github://owner/repo/pull/123',
  });
  assert.strictEqual(stored.length, 1);

  const imported = kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.IMPORTED, workspaceId: 'workspace-a' });
  assert.strictEqual(imported.length, 1);
  assert.strictEqual(imported[0].sourceRef, 'github://owner/repo/pull/123');
  assert.strictEqual(imported[0].trustPolicyVersion, '0.8.0');
});

test('ingestGitHubItem accepts explicit canonical writes when requested', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('accept-write') });

  const result = ingestGitHubItem(kernel, makeBaseItem({ workspaceId: 'workspace-a' }), {
    workspaceId: 'workspace-a',
    accept: true,
  });

  assert.strictEqual(result.candidate.status, 'accepted');
  assert.strictEqual(result.admission.outcome, 'admitted');
  assert.strictEqual(result.admission.graphWrite, true);
  assert.ok(kernel.graph.getEdge('github:owner/repo', 'PR 123 merged in owner/repo: Add provenance schema', 'reports', 'workspace-a'));
  assert.strictEqual(kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.CLAIM_ACCEPTED, workspaceId: 'workspace-a' }).length, 1);
});

test('ingestGitHubItem flags conflicts and keeps them out of canonical graph', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('conflict-route') });
  kernel.graph.addNode('fire', 'fire', null, { workspaceId: 'workspace-a' });
  kernel.graph.addNode('smoke', 'smoke', null, { workspaceId: 'workspace-a' });
  kernel.graph.addEdge('fire', 'smoke', 'CAUSES', {
    workspaceId: 'workspace-a',
    strength: 0.9,
    confidence: 0.9,
  });

  const result = ingestGitHubItem(kernel, makeBaseItem({
    workspaceId: 'workspace-a',
    proposedEdge: {
      from: 'fire',
      relation: 'PREVENTS',
      to: 'smoke',
      confidence: 0.4,
    },
  }), {
    workspaceId: 'workspace-a',
  });

  assert.strictEqual(result.candidate.status, 'pending');
  assert.strictEqual(result.candidate.recommendation, 'flag');
  assert.strictEqual(result.admission.outcome, 'candidate');
  assert.strictEqual(kernel.graph.getEdge('fire', 'smoke', 'PREVENTS', 'workspace-a'), null);
  assert.strictEqual(kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.CONFLICT_DETECTED, workspaceId: 'workspace-a' }).length, 1);
  assert.strictEqual(kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.CLAIM_FLAGGED, workspaceId: 'workspace-a' }).length, 1);
});

test('ingestGitHubItem rejects invalid GitHub input when provenance cannot be built', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('strict-provenance') });

  assert.throws(() => ingestGitHubItem(kernel, {
    sourceSubType: GITHUB_SOURCE_TYPES.merged_pr,
    title: 'Missing repo',
  }, {
    strictProvenance: true,
  }), /repo is required/i);
});

test('ingestGitHubItem respects workspace scoping and idempotency', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('workspace-idempotency') });

  const first = ingestGitHubItem(kernel, makeBaseItem({ workspaceId: 'workspace-a' }), {
    workspaceId: 'workspace-a',
  });
  const duplicate = ingestGitHubItem(kernel, makeBaseItem({ workspaceId: 'workspace-a' }), {
    workspaceId: 'workspace-a',
  });
  const otherWorkspace = ingestGitHubItem(kernel, makeBaseItem({ workspaceId: 'workspace-b' }), {
    workspaceId: 'workspace-b',
  });

  assert.strictEqual(first.duplicate, false);
  assert.strictEqual(duplicate.duplicate, true);
  assert.strictEqual(duplicate.admission.outcome, 'skipped');
  assert.strictEqual(otherWorkspace.duplicate, false);

  const wsAClaims = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-a' });
  const wsBClaims = kernel.graph.getCandidateClaims({ workspaceId: 'workspace-b' });
  const importedA = kernel.graph.getAuditEvents({ eventType: AUDIT_EVENTS.IMPORTED, workspaceId: 'workspace-a' });

  assert.strictEqual(wsAClaims.length, 1);
  assert.strictEqual(wsBClaims.length, 1);
  assert.strictEqual(importedA.length, 2);
  assert.strictEqual(wsAClaims[0].provenance.confidence, 0.8);
});

test('ingestGitHubItems processes multiple items deterministically', () => {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, ...makePaths('batch') });
  const results = ingestGitHubItems(kernel, [
    makeBaseItem({ number: 1, title: 'First PR', workspaceId: 'workspace-a' }),
    makeBaseItem({ number: 2, title: 'Second PR', workspaceId: 'workspace-a' }),
  ], {
    workspaceId: 'workspace-a',
  });

  assert.strictEqual(results.length, 2);
  assert.strictEqual(results[0].candidate.provenance.sourceRef, 'github://owner/repo/pull/1');
  assert.strictEqual(results[1].candidate.provenance.sourceRef, 'github://owner/repo/pull/2');
  assert.strictEqual(results[0].admission.outcome, 'candidate');
  assert.strictEqual(results[1].admission.outcome, 'candidate');
});

test('connector can persist candidate claims in SQLite when graph backend is available', (t) => {
  const kernel = new Kernel({ noLoad: true, useSQLite: true, ...makePaths('sqlite') });
  if (kernel.graph.getStats().backend !== 'sqlite') {
    kernel.graph.close();
    return t.skip('better-sqlite3 is unavailable');
  }

  t.after(() => kernel.graph.close());

  ingestGitHubItem(kernel, makeBaseItem({
    workspaceId: 'workspace-a',
    number: 321,
    title: 'Persisted PR',
  }), {
    workspaceId: 'workspace-a',
  });
  kernel.graph.save();

  const reopened = new Graph({ useSQLite: true, ...makePaths('sqlite') });
  if (reopened.getStats().backend !== 'sqlite') {
    reopened.close();
    return t.skip('better-sqlite3 reopened backend unavailable');
  }

  t.after(() => reopened.close());
  reopened.load();
  const claims = reopened.getCandidateClaims({ workspaceId: 'workspace-a', sourceRef: 'github://owner/repo/pull/321' });
  assert.strictEqual(claims.length, 1);
  assert.strictEqual(claims[0].provenance.sourceType, 'github');
});
