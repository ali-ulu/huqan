'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { runReadWorkflow, searchMemory } = require('../lib/http/read-workflow-actions');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

test('UI capability manifest advertises only the implemented read workflows', () => {
  const enabled = publicWorkflowManifest().workflows
    .filter(item => item.availability.ui)
    .map(item => item.workflowId);
  assert.deepEqual(enabled, ['ask', 'verify', 'advocate', 'memory-search', 'trust-receipt']);
});

test('read workflow adapter reuses kernel reads and emits stable envelopes', async () => {
  const calls = [];
  const kernel = {
    ask(question) {
      calls.push(['ask', question]);
      return { data: { answer: 'graph answer', unknown: false }, evidence: [{ sourceRef: 'test:ask' }] };
    },
    verify(claim, options) {
      calls.push(['verify', claim, options.workspaceId]);
      return { data: { status: 'supported', confidence: 0.9 }, evidence: [] };
    },
    graph: { getNodes: () => ({}) },
  };

  const ask = await runReadWorkflow({ workflowId: 'ask', kernel, input: { question: 'q', workspaceId: 'default' } });
  const verify = await runReadWorkflow({ workflowId: 'verify', kernel, input: { claim: 'c', workspaceId: 'ws-1' } });

  assert.equal(ask.body.status, 'completed');
  assert.equal(ask.body.data.answer, 'graph answer');
  assert.match(ask.body.traceId, /^[0-9a-f-]{36}$/);
  assert.equal(verify.body.data.status, 'supported');
  assert.deepEqual(calls, [['ask', 'q'], ['verify', 'c', 'ws-1']]);
});

test('memory search is workspace-scoped, bounded, and projects trust handoff fields', () => {
  const graph = {
    getNodes(workspaceId) {
      assert.equal(workspaceId, 'team-a');
      return {
        alpha: {
          label: 'Alpha claim', confidence: 0.8,
          provenance: { sourceRef: 'doc:alpha', provenanceId: 'prov-alpha' },
        },
        beta: { label: 'Beta claim', confidence: 0.2 },
      };
    },
  };
  assert.deepEqual(searchMemory(graph, { workspaceId: 'team-a', query: 'alpha' }), [{
    id: 'alpha', label: 'Alpha claim', confidence: 0.8,
    sourceRef: 'doc:alpha', provenanceId: 'prov-alpha', workspaceId: 'team-a',
  }]);
});

test('Claim Workspace uses manifest routes, session-only auth, real search, and receipt handoff', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  assert.match(html, /fetch\('\/api\/v2\/workflows'/);
  assert.match(html, /sessionStorage\.setItem\('huqan-api-key'/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*api-key/);
  assert.match(html, /capability\.route/);
  assert.match(html, /data-result-action="receipt"/);
  assert.match(html, /renderMemoryResults\(workflowData\.items\)/);
  assert.doesNotMatch(html, /fetch\('\/api\?' \+ new URLSearchParams/);
});

test('Claim Workspace browser script compiles and wires unknown-to-review through the existing ingest approval runtime', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  assert.match(html, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(html, /fetch\('\/api\/ingest'/);
  assert.match(html, /fetch\('\/api\/ingest\/approvals\?limit=50'/);
  assert.match(html, /`\/api\/ingest\/approvals\/\$\{encodeURIComponent\(selectedReviewApproval\.id\)\}`/);
  assert.match(html, /idempotencyKey: `claim-workspace:\$\{hash\}`/);
  assert.match(html, /showReceiptHandoff\('', receiptId\)/);
  assert.doesNotMatch(html, /new (Map|Set)\(.*approval/i);
});
