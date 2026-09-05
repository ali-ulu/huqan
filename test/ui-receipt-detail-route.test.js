'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { dashboardSource } = require('./helpers/dashboard-source');
const { createWorkflowDataRoutes } = require('../lib/http/workflow-data-routes');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const html = () => dashboardSource();

// #1878: trust-receipt-detail had a live route and no panel surface -- the
// Evidence panel read receipts by id through the unversioned workbench route
// instead. Moving it onto the advertised route needs two things the dispatcher
// did not have: a way to fill a `{id}` template, and the projection the detail
// route actually returns.

// The real route, driven the way test/workflow-data-routes.test.js drives it,
// so the projection this test pins is the server's own rather than a guess.
function readReceiptThroughRoute(receiptId, workspaceId) {
  const writes = [];
  const handler = createWorkflowDataRoutes({
    getApprovalStore: () => ({ listUnresolvedToolApprovals: () => [], getToolApprovalById: () => null }),
    decideApproval: async () => ({ status: 200, json: {} }),
    readReceipt: (id, filters) => (id === 'receipt-1'
      ? { ok: true, receipt: { receiptId: id, workspaceId: filters.workspaceId, status: 'verified', claim: 'a claim' } }
      : { ok: false, status: 'not_found', error: { message: 'missing' } }),
    parseJsonRequest: async req => req.body,
    writeJson: (_req, _res, status, json) => writes.push({ status, json }),
    proposeLearn: async () => ({ approval: {} }),
    submitIngest: async () => ({}),
    createAgent: () => ({ plan: () => ({}), run: () => ({}) }),
  });
  const url = new URL(`/api/v2/trust-receipts/${encodeURIComponent(receiptId)}?workspaceId=${workspaceId}`, 'http://localhost');
  return handler({ method: 'GET' }, {}, url).then(() => writes.at(-1));
}

function extract(pattern, description) {
  const match = html().match(pattern);
  assert.ok(match, `${description} must be present`);
  return match;
}

test('the manifest advertises the receipt detail route to the UI as a template', () => {
  const item = publicWorkflowManifest().workflows.find(entry => entry.workflowId === 'trust-receipt-detail');
  assert.ok(item, 'trust-receipt-detail must be in the manifest');
  assert.equal(item.availability.ui, true);
  assert.equal(item.method, 'GET');
  assert.equal(item.route, '/api/v2/trust-receipts/{id}');
  // The point of the whole mechanic: this route cannot be fetched as written.
  assert.match(item.route, /\{id\}/);
});

test('the route template is filled per parameter, not by string concatenation', () => {
  const match = extract(/function routeFor\(c,params\)\{([\s\S]*?)\}const AGENT_ACTIONS/, 'the substitution helper');
  const routeFor = vm.runInNewContext(`(function routeFor(c,params){${match[1]}})`, {});

  const detail = publicWorkflowManifest().workflows.find(entry => entry.workflowId === 'trust-receipt-detail');
  assert.equal(routeFor(detail, { id: 'receipt-1' }), '/api/v2/trust-receipts/receipt-1');

  // An id is operator input: it reaches the path, so it is encoded there.
  assert.equal(routeFor(detail, { id: 'a b/c?d' }), '/api/v2/trust-receipts/a%20b%2Fc%3Fd');

  // A template the caller cannot fill yields null rather than a URL with an
  // empty segment, which would silently read a different route.
  assert.equal(routeFor(detail, {}), null);
  assert.equal(routeFor(detail, { wrong: 'receipt-1' }), null);
  assert.equal(routeFor({ route: '/api/v2/x/{a}/{b}' }, { a: '1' }), null);
  assert.equal(routeFor({ route: '/api/v2/x/{a}/{b}' }, { a: '1', b: '2' }), '/api/v2/x/1/2');

  // A capability with no route at all (cli- or mcp-only) is not fetchable.
  assert.equal(routeFor({}, { id: 'x' }), null);
  assert.equal(routeFor(undefined, { id: 'x' }), null);

  // A route with no parameters passes through unchanged.
  assert.equal(routeFor({ route: '/api/v2/approvals' }, {}), '/api/v2/approvals');
});

test('the panel reads the projection the detail route actually returns', async () => {
  const written = await readReceiptThroughRoute('receipt-1', 'alpha');
  assert.equal(written.status, 200);
  // The receipt is nested under data.receipt here, while the legacy read
  // returns it at the top level. Reading the wrong one renders a summary of
  // undefined fields under a "Receipt found." status -- a panel that looks
  // like it worked.
  assert.equal(written.json.data.receipt.receiptId, 'receipt-1');
  assert.equal(written.json.receiptId, 'receipt-1');
  assert.equal(written.json.data.receiptId, undefined, 'the receipt is not at the top of data');

  const match = extract(/const data=detail\?([\s\S]*?);if\(!data\)throw Error\('receipt_projection_missing'\)/,
    'the projection choice');
  const pick = vm.runInNewContext(`(function(detail,d){return detail?${match[1]}})`, {});

  assert.deepEqual(pick(true, written.json), written.json.data.receipt);
  // The legacy modes keep the projection they had.
  assert.deepEqual(pick(false, { receipt: { receiptId: 'legacy' } }), { receiptId: 'legacy' });

  // If the route ever stops carrying the receipt where the panel looks, the
  // read fails loudly instead of rendering an empty summary.
  assert.equal(pick(true, { data: { workspaceId: 'alpha' } }), undefined);
  assert.match(html(), /if\(!data\)throw Error\('receipt_projection_missing'\)/);
});

test('the receipt read refuses to guess when the manifest does not advertise the route', () => {
  const page = html();
  // The dispatcher already refuses a workflow the manifest does not mark
  // ui-available; the Evidence panel now says the same thing rather than
  // falling back to a route nobody advertised.
  assert.match(page, /if\(m==='receiptId'&&!detail\?\.availability\?\.ui\)return estatus\('trust-receipt-detail: capability_not_available',1\)/);
  assert.match(page, /if\(detail&&!path\)return estatus\('trust-receipt-detail: route_template_unsupported',1\)/);
  // The unversioned workbench route is no longer what the panel reads.
  assert.doesNotMatch(page, /\/api\/workbench\/trust-receipt\//);
});
