'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { dashboardSource } = require('./helpers/dashboard-source');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

const source = () => dashboardSource();

test('manifest advertises approval decision only through its reachable v2 UI route', () => {
  const item = publicWorkflowManifest().workflows.find(entry => entry.workflowId === 'approval-decision');
  assert.ok(item);
  assert.equal(item.availability.ui, true);
  assert.equal(item.method, 'POST');
  assert.equal(item.route, '/api/v2/approvals/{id}/decision');
});

test('approval decision fills and encodes the manifest route template', () => {
  const match = source().match(/function routeFor\(c,params\)\{([\s\S]*?)\}const AGENT_ACTIONS/);
  assert.ok(match, 'route template helper must be present');
  const routeFor = vm.runInNewContext(`(function routeFor(c,params){${match[1]}})`, {});
  const item = publicWorkflowManifest().workflows.find(entry => entry.workflowId === 'approval-decision');
  assert.equal(routeFor(item, { id: 'approval a/b?' }), '/api/v2/approvals/approval%20a%2Fb%3F/decision');
});

test('approval panel dispatches the decision through the manifest with workspace and v2 projection', () => {
  const page = source();
  assert.match(page, /const c=capability\('approval-decision'\)/);
  assert.match(page, /if\(!c\?\.availability\?\.ui\)/);
  assert.match(page, /const path=routeFor\(c,\{id\}\)/);
  assert.match(page, /json\(`\$\{path\}\?workspaceId=\$\{encodeURIComponent\(state\.ws\|\|'default'\)\}`/);
  assert.match(page, /method:c\.method/);
  assert.match(page, /const approval=d\.data\?\.approval/);
  assert.match(page, /const rid=d\.receiptId\|\|approval\.receipt\?\.receiptId/);
  assert.match(page, /approval_projection_missing/);
  assert.doesNotMatch(page, /`\/api\/ingest\/approvals\/\$\{encodeURIComponent\(id\)\}`/);
});
