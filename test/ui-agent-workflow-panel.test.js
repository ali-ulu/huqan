'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { dashboardSource } = require('./helpers/dashboard-source');
const { validateWorkflowHttpRequest } = require('../lib/http/workflow-request-validation');
const { publicWorkflowManifest } = require('../lib/workflow-contract');

// #1894 and #1895 moved the dashboard's CSS and script into linked files.
// `html()` has always meant everything the page is, so it reads the page the
// way a browser assembles it rather than the way it is stored.
const html = () => dashboardSource();

// #1878: agent-plan and agent-run had live HTTP routes and no panel surface.
// The workbench dispatcher is generic -- it reads `c.route` and `c.method` off
// the manifest -- so the only thing that can silently break is the request body
// it builds, and the way it reads back a result that did not complete.

test('the manifest advertises both agent workflows to the UI on their wired routes', () => {
  const byId = new Map(publicWorkflowManifest().workflows.map(item => [item.workflowId, item]));
  for (const [workflowId, route] of [['agent-plan', '/api/v2/agent/plan'], ['agent-run', '/api/v2/agent/runs']]) {
    const item = byId.get(workflowId);
    assert.ok(item, `${workflowId} must be in the manifest`);
    assert.equal(item.availability.ui, true, `${workflowId} must be ui-available`);
    assert.equal(item.route, route);
    assert.equal(item.method, 'POST');
  }
});

test('the agent request body the panel builds is the one the route schema accepts', () => {
  // Before #1878 the dispatcher fell through to `p.claim = text` for anything
  // that was not ask/memory-search. Both agent schemas are
  // additionalProperties:false and require `goal`, so that body is rejected at
  // the boundary -- the panel would have shown a 400 for every agent request.
  for (const workflowId of ['agent-plan', 'agent-run']) {
    assert.equal(validateWorkflowHttpRequest(workflowId, { workspaceId: 'default', goal: 'g', maxSteps: 4 }), null);
    assert.ok(validateWorkflowHttpRequest(workflowId, { workspaceId: 'default', claim: 'g' }),
      `${workflowId} must reject the claim-shaped body the old dispatcher sent`);
    // The select only offers values inside the contract's bounds.
    assert.ok(validateWorkflowHttpRequest(workflowId, { workspaceId: 'default', goal: 'g', maxSteps: 9 }));
  }

  const page = html();
  assert.match(page, /AGENT_ACTIONS\.has\(a\)\)\{p\.goal=text;p\.maxSteps=Number\(\$\('maxsteps'\)\.value\)\|\|4\}/);
  const offered = [...page.matchAll(/<option value="(\d)"[^>]*>\d+ steps?/g)].map(m => Number(m[1]));
  assert.deepEqual(offered, [1, 2, 4, 6, 8]);
});

test('a run that pauses, blocks, or stalls is reported as an outcome, not a failure', () => {
  // runBody sets ok:false for paused/blocked/partial -- they are real agent
  // states carrying nextAction / pauseReason / resumeToken, not transport
  // errors. The generic `!r.ok || d.ok === false` throw would have collapsed
  // all three into `failed: paused` and dropped the handoff fields.
  const page = html();
  const match = page.match(/const AGENT_SOFT_STATUS=new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, 'the soft-status set must be present');
  assert.deepEqual(
    match[1].split(',').map(part => part.trim().replace(/'/g, '')).sort(),
    ['blocked', 'partial', 'paused'],
  );
  // The guard is scoped to agent actions on an HTTP-ok response, so a real
  // error on any other workflow still throws. #1878 gave the ingest actions
  // their own soft status; the agent arm of the guard is unchanged.
  assert.match(page, /const soft=r\.ok&&\(\(AGENT_ACTIONS\.has\(a\)&&AGENT_SOFT_STATUS\.has\(st\)\)/);
  assert.match(page, /if\(!soft&&\(!r\.ok\|\|d\.ok===false\)\)throw Error/);
});

test('the panel renders the steps an agent response carries', () => {
  const page = html();
  const match = page.match(/function agentSteps\(d\)\{([\s\S]*?)\}function agentHandoff/);
  assert.ok(match, 'the step renderer must be present');
  const agentSteps = vm.runInNewContext(
    `(function agentSteps(d){${match[1]}})`,
    { esc: value => String(value ?? '') },
  );

  assert.equal(agentSteps({ data: { steps: [] } }), '');
  assert.equal(agentSteps({}), '');
  // Step shape as lib/mcp/response-builders.js projects it: id / action / tool.
  const rendered = agentSteps({ data: { steps: [{ id: 'context', action: 'ask', tool: 'ask' }] } });
  assert.match(rendered, /1\. ask/);
  assert.match(rendered, /context/);
});

test('the goal field replaces the claim field only for the agent actions', () => {
  const page = html();
  const match = page.match(/function agentFields\(\)\{([\s\S]*?)\}function ingestFields/);
  assert.ok(match, 'the field toggle must be present');

  const elements = {
    action: { value: 'verify' },
    stepsfield: { hidden: false },
    promptlabel: { textContent: '' },
    prompt: { placeholder: '' },
  };
  const agentFields = vm.runInNewContext(
    `(function agentFields(){${match[1]}})`,
    { $: id => elements[id], AGENT_ACTIONS: new Set(['agent-plan', 'agent-run']) },
  );

  agentFields();
  assert.equal(elements.stepsfield.hidden, true);
  assert.equal(elements.promptlabel.textContent, 'Claim / Query');

  elements.action.value = 'agent-run';
  agentFields();
  assert.equal(elements.stepsfield.hidden, false);
  assert.equal(elements.promptlabel.textContent, 'Goal');
  assert.match(elements.prompt.placeholder, /goal/i);

  // The step budget is hidden with el.hidden, and the page carries the
  // [hidden] rule that makes that inert-proof (see dashboard-hidden-attribute).
  assert.match(page, /id="stepsfield" hidden/);
  // #1878 added a second field family, so the select drives both toggles.
  assert.match(page, /function actionFields\(\)\{agentFields\(\);ingestFields\(\)\}\$\('action'\)\.onchange=actionFields;/);
});
