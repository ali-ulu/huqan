'use strict';

/**
 * approval-decision UI surface (#1878).
 *
 * The decision route is where a reviewer approves or rejects. It is reached
 * through the manifest template (a POST to /api/v2/approvals/{id}/decision),
 * not through a hand-built path, and it must read the v2 projection rather than
 * the legacy top-level shape. These tests drive the assembled dashboard and
 * assert the request the page actually sends, so a refactor of the dispatcher
 * cannot pass by matching the old source text.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { boot } = require('./helpers/dashboard-boot');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const APPROVAL_ID = 'approval a/b?';
const DECISION_ROUTE = '/api/v2/approvals/approval%20a%2Fb%3F/decision?workspaceId=default';

const approval = () => ({ id: APPROVAL_ID, tool: 'graph.write', policy: { rule: 'operator' }, input: 'x', status: 'approved', sourceRef: 'source-1' });

const routes = () => ({
  '/api/v2/approvals?': { data: { approvals: [approval()] } },
  '/api/v2/approvals/': { data: { approval: approval() }, receiptId: 'receipt-1' },
});

test('manifest advertises approval decision only through its reachable v2 UI route', () => {
  const item = publicWorkflowManifest().workflows.find((entry) => entry.workflowId === 'approval-decision');
  assert.ok(item);
  assert.equal(item.availability.ui, true);
  assert.equal(item.method, 'POST');
  assert.equal(item.route, '/api/v2/approvals/{id}/decision');
});

test('approval decision fills and encodes the manifest route template', async () => {
  const { page } = await boot({ routes: routes() });
  const item = publicWorkflowManifest().workflows.find((entry) => entry.workflowId === 'approval-decision');
  const path = page.evaluate(`routeFor(${JSON.stringify(item)},{id:${JSON.stringify(APPROVAL_ID)}})`);
  assert.equal(path, '/api/v2/approvals/approval%20a%2Fb%3F/decision');
});

test('approval panel dispatches the decision through the manifest with workspace and v2 projection', async () => {
  const { page, calls } = await boot({ routes: routes() });
  await page.evaluate(`decide(${JSON.stringify(APPROVAL_ID)},'approved')`);

  const posted = calls.find((call) => call.method === 'POST' && call.url.startsWith('/api/v2/approvals/'));
  assert.ok(posted, 'decide must POST the manifest route');
  assert.equal(posted.url, DECISION_ROUTE, 'the request carries the encoded id and workspace');
  assert.equal(JSON.parse(posted.body).decision, 'approved', 'the body carries the decision');

  // The unversioned ingest path is the legacy route this capability replaced.
  assert.ok(!calls.some((call) => /\/api\/ingest\/approvals\//.test(call.url)),
    'decide must not fall back to the legacy ingest route');
});

test('a decision reads the v2 projection and refuses to guess when it is missing', async () => {
  const { page } = await boot({ routes: { ...routes(), '/api/v2/approvals/': { data: {} } } });
  await page.evaluate(`decide(${JSON.stringify(APPROVAL_ID)},'approved')`);
  assert.match(page.nodes.get('ahead').textContent, /approval_projection_missing/);
});
