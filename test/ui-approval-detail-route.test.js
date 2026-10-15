'use strict';

/**
 * approval-detail UI surface (#1878).
 *
 * The detail route is the only place the panel can show WHAT is being
 * approved: the list projection carries sourceRef/status/snapshot, while
 * formatApprovalRecord additionally carries the tool, its input and the policy
 * that demanded approval. A reviewer approving without those is deciding
 * blind, which is why this capability earns a surface rather than a flag.
 *
 * These tests drive the assembled dashboard in the shared vm harness and assert
 * what the page renders after a fetch, rather than matching the script as text.
 * A reformat can no longer break them, and a behavioural regression now can.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { boot } = require('./helpers/dashboard-boot');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const APPROVAL = {
  id: 'approval a/b?',
  tool: 'graph.write',
  policy: { rule: 'operator' },
  input: 'rm -rf /',
  status: 'pending',
  sourceRef: 'source-1',
};

const DETAIL_ROUTE = '/api/v2/approvals/approval%20a%2Fb%3F?workspaceId=default';

const withApproval = (approval = APPROVAL) => ({
  '/api/v2/approvals?': { data: { approvals: [approval] } },
  '/api/v2/approvals/': { data: { approval } },
});

test('manifest advertises approval detail through its reachable v2 UI route', () => {
  const item = publicWorkflowManifest().workflows.find((entry) => entry.workflowId === 'approval-detail');
  assert.ok(item);
  assert.equal(item.availability.ui, true);
  assert.equal(item.method, 'GET');
  assert.equal(item.route, '/api/v2/approvals/{id}');
});

test('approval detail fills and encodes the manifest route template', async () => {
  const { page } = await boot({ routes: withApproval() });
  const item = publicWorkflowManifest().workflows.find((entry) => entry.workflowId === 'approval-detail');
  const path = page.evaluate(`routeFor(${JSON.stringify(item)},{id:${JSON.stringify(APPROVAL.id)}})`);
  assert.equal(path, '/api/v2/approvals/approval%20a%2Fb%3F');
});

test('the approvals list offers an inspect affordance bound to each row', async () => {
  const { page } = await boot({ routes: withApproval() });
  const list = page.nodes.get('alist');
  assert.match(list.innerHTML, /data-detail="approval a\/b\?"/,
    'each row must render an inspect control carrying its id');
  assert.match(list.innerHTML, /data-detail-for="approval a\/b\?"/,
    'each row must render the node inspect fills');
});

test('inspect dispatches through the manifest and reads the v2 projection', async () => {
  const { page, calls } = await boot({ routes: withApproval() });
  await page.evaluate(`inspect(${JSON.stringify(APPROVAL.id)})`);
  assert.ok(calls.some((call) => call.url === DETAIL_ROUTE),
    `inspect must GET the manifest route template (${DETAIL_ROUTE})`);
});

test('the detail surfaces the fields the list cannot show', async () => {
  const { page } = await boot({ routes: withApproval() });
  await page.evaluate(`inspect(${JSON.stringify(APPROVAL.id)})`);
  const box = page.nodes.get('alist').querySelector(`[data-detail-for="${APPROVAL.id}"]`);
  assert.match(box.textContent, /tool graph\.write/);
  assert.match(box.textContent, /policy 1 rule\(s\)/);
  assert.match(box.textContent, /status pending/);
  assert.match(box.textContent, /input rm -rf \//);
});

test('inspect renders as text, never as markup', async () => {
  // The detail carries operator-supplied tool input. innerHTML here would turn
  // an approval request into a script injection against the reviewer.
  const { page } = await boot({ routes: withApproval() });
  await page.evaluate(`inspect(${JSON.stringify(APPROVAL.id)})`);
  const box = page.nodes.get('alist').querySelector(`[data-detail-for="${APPROVAL.id}"]`);
  assert.notEqual(box.textContent, '', 'inspect must write the projection');
  assert.equal(box.innerHTML, '', 'inspect output must go through textContent, not innerHTML');
});

test('inspect refuses when the manifest does not expose the detail UI', async () => {
  const { page, calls } = await boot({ routes: withApproval(), workflows: [] });
  await page.evaluate(`inspect(${JSON.stringify(APPROVAL.id)})`);
  const box = page.nodes.get('alist').querySelector(`[data-detail-for="${APPROVAL.id}"]`);
  assert.match(box.textContent, /capability_not_available/);
  assert.ok(!calls.some((call) => call.url === DETAIL_ROUTE), 'a gated capability must not be fetched');
});
