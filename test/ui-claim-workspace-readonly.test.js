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
  // searchMemory now reports whether the result was trimmed alongside the rows
  // (#1269), so the caller can tell 50 results from the first 50 of 20 000.
  assert.deepEqual(searchMemory(graph, { workspaceId: 'team-a', query: 'alpha' }), {
    items: [{
      id: 'alpha', label: 'Alpha claim', confidence: 0.8,
      sourceRef: 'doc:alpha', provenanceId: 'prov-alpha', workspaceId: 'team-a',
    }],
    truncated: false,
  });
});

test('Claim Workspace uses manifest routes, session-only auth, real search, and receipt handoff', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  // capability manifest'ten türetilen gerçek ajan çağrısı: manifest fetch + route dispatch
  assert.match(html, /json\('\/api\/v2\/workflows'/);
  assert.match(html, /state\.manifest/);
  assert.match(html, /c\.route/);
  // session-only auth: API key yalnız sessionStorage; kalıcı localStorage değil
  assert.match(html, /sessionStorage\.setItem\('huqan-(api-key|workspace)'/);
  assert.doesNotMatch(html, /localStorage\.setItem\([^)]*api-key/);
  // gerçek, workspace-scoped graph arama (sahte connector box değil)
  assert.match(html, /\/graph-data\?workspaceId=/);
  // receipt handoff: trust-receipt lookup + son receipt akışı
  assert.match(html, /\/api\/trust-receipt/);
});

test('Claim Workspace derives all aggregate dashboard status labels from one helper', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const match = html.match(/function aggregateStatus\(surfaces\)\{([\s\S]*?)\}function renderHealth/);
  assert.ok(match, 'aggregate status helper must be present');
  const aggregateStatus = vm.runInNewContext(`(function aggregateStatus(surfaces){${match[1]}})`);
  const surfaces = {
    status: { s: 'ok' }, workflows: { s: 'ok' }, graph: { s: 'ok' },
    approvals: { s: 'ok' }, activity: { s: 'ok' },
  };
  const healthy = aggregateStatus(surfaces);
  assert.equal(healthy.label, 'HEALTHY');
  assert.equal(healthy.online, 5);
  assert.equal(healthy.total, 5);
  surfaces.activity.s = 'locked';
  assert.equal(aggregateStatus(surfaces).label, 'PARTIAL');
  surfaces.status.s = 'err';
  surfaces.workflows.s = 'err';
  surfaces.graph.s = 'checking';
  surfaces.approvals.s = 'checking';
  surfaces.activity.s = 'checking';
  assert.equal(aggregateStatus(surfaces).label, 'CHECKING');
  surfaces.graph.s = 'err';
  surfaces.approvals.s = 'err';
  surfaces.activity.s = 'err';
  assert.equal(aggregateStatus(surfaces).label, 'OFFLINE');
  surfaces.status.s = 'ok';
  surfaces.workflows.s = 'ok';
  assert.equal(aggregateStatus(surfaces).label, 'DEGRADED');
  assert.match(html, /aggregate=aggregateStatus\(state\.surfaces\)/);
  assert.match(html, /\$\('sys'\)\.textContent=aggregate\.label/);
  assert.match(html, /\$\('healthsum'\)\.textContent=`\$\{aggregate\.label\} · \$\{n\}\/\$\{a\.length\} surfaces available`/);
  assert.match(html, /\$\('footstatus'\)\.textContent=`\$\{aggregate\.label\} · \$\{n\}\/\$\{a\.length\} surfaces available`/);
  assert.doesNotMatch(html, /\$\('sys'\)\.textContent='ONLINE'/);
  assert.doesNotMatch(html, /\$\('footstatus'\)\.textContent='System Healthy'/);
});

test('Claim Workspace browser script compiles and wires unknown-to-review through the existing ingest approval runtime', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script);
  assert.doesNotThrow(() => new vm.Script(script));
  // bilinmeyen iddia -> review: SHA-256 hash + ingest POST + scoped idempotency key
  assert.match(html, /crypto\.subtle\.digest\('SHA-256'/);
  assert.match(html, /json\('\/api\/ingest'/);
  assert.match(html, /idempotencyKey:\`command-center:\$\{h\}\`/);
  // approval/review kuyruğu okunur ve karar ingest'e postanır
  assert.match(html, /json\('\/api\/ingest\/approvals\?limit=50&workspaceId='/);
  assert.match(html, /encodeURIComponent\(state\.ws\)/);
  assert.match(html, /await refresh\(\);const failed=/);
  assert.match(html, /`\/api\/ingest\/approvals\/\$\{encodeURIComponent\(id\)\}`/);
});
