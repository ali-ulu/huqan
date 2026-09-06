'use strict';

/**
 * approval-detail UI surface (#1878).
 *
 * The detail route is the only place the panel can show WHAT is being
 * approved: the list projection carries sourceRef/status/snapshot, while
 * formatApprovalRecord additionally carries the tool, its input and the policy
 * that demanded approval. A reviewer approving without those is deciding
 * blind, which is why this capability earns a surface rather than a flag.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { dashboardSource } = require('./helpers/dashboard-source');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const source = () => dashboardSource();

const capability = () => publicWorkflowManifest().workflows
  .find((entry) => entry.workflowId === 'approval-detail');

test('manifest advertises approval detail through its reachable v2 UI route', () => {
  const item = capability();
  assert.ok(item);
  assert.equal(item.availability.ui, true);
  assert.equal(item.method, 'GET');
  assert.equal(item.route, '/api/v2/approvals/{id}');
});

test('approval detail fills and encodes the manifest route template', () => {
  const match = source().match(/function routeFor\(c,params\)\{([\s\S]*?)\}const AGENT_ACTIONS/);
  assert.ok(match, 'route template helper must be present');
  const routeFor = vm.runInNewContext(`(function routeFor(c,params){${match[1]}})`, {});
  assert.equal(routeFor(capability(), { id: 'approval a/b?' }), '/api/v2/approvals/approval%20a%2Fb%3F');
});

test('the approvals list offers an inspect affordance bound to each row', () => {
  const page = source();
  assert.match(page, /data-detail="\$\{esc\(x\.id\)\}"/);
  assert.match(page, /data-detail-for="\$\{esc\(x\.id\)\}"/);
  // Decide still wins the click; inspect only handles what decide did not.
  assert.match(page, /if\(b\)\{decide\(b\.dataset\.id,b\.dataset\.dec\);return\}/);
  assert.match(page, /closest\('\[data-detail\]'\)/);
});

test('inspect dispatches through the manifest and reads the v2 projection', () => {
  const page = source();
  assert.match(page, /const c=capability\('approval-detail'\)/);
  assert.match(page, /if\(!c\?\.availability\?\.ui\)/);
  assert.match(page, /const path=routeFor\(c,\{id\}\)/);
  assert.match(page, /json\(`\$\{path\}\?workspaceId=\$\{encodeURIComponent\(state\.ws\|\|'default'\)\}`/);
  assert.match(page, /const approval=d\.data\?\.approval/);
  assert.match(page, /approval_projection_missing/);
});

test('the detail surfaces the fields the list cannot show', () => {
  // Without these the panel would duplicate the list and justify nothing.
  const page = source();
  for (const field of ['approval.tool', 'approval.policy', 'approval.input']) {
    assert.ok(page.includes(field), `detail must render ${field}`);
  }
});

test('inspect renders as text, never as markup', () => {
  // The detail carries operator-supplied tool input. innerHTML here would turn
  // an approval request into a script injection against the reviewer.
  const page = source();
  const say = page.match(/const say=t=>\{[^}]*\}/);
  assert.ok(say, 'inspect must funnel output through one sink');
  assert.match(say[0], /textContent/);
  assert.doesNotMatch(say[0], /innerHTML/);
});
