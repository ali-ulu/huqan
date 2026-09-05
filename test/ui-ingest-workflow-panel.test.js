'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const { dashboardSource } = require('./helpers/dashboard-source');
const { validateWorkflowHttpRequest } = require('../lib/http/workflow-request-validation');
const { publicWorkflowManifest } = require('../lib/workflow-contract');
const { buildIngestWorkflowPreview } = require('../lib/ingest-workflow-preview');

// #1894 and #1895 moved the dashboard's CSS and script into linked files, so
// the page has to be read the way a browser assembles it.
const html = () => dashboardSource();

// #1878 lists ten capabilities with live HTTP routes and `availability.ui:
// false`. This takes its second priority: ingest-preview and ingest-execute,
// the batch flow, which had no panel surface at all.

test('the manifest advertises both ingest workflows to the UI on their wired routes', () => {
  const byId = new Map(publicWorkflowManifest().workflows.map(item => [item.workflowId, item]));
  for (const [workflowId, route] of [['ingest-preview', '/api/v2/ingest/preview'], ['ingest-execute', '/api/v2/ingest/execute']]) {
    const item = byId.get(workflowId);
    assert.ok(item, `${workflowId} must be in the manifest`);
    assert.equal(item.availability.ui, true, `${workflowId} must be ui-available`);
    assert.equal(item.route, route);
    assert.equal(item.method, 'POST');
  }
});

test('the ingest request body the panel builds is the one the route schema accepts', () => {
  // The preview schema is additionalProperties:false and requires sourceType,
  // so the dispatcher's generic `p.claim = text` fallback is rejected at the
  // boundary: every preview would have come back 400 INVALID_INPUT.
  assert.equal(validateWorkflowHttpRequest('ingest-preview',
    { workspaceId: 'default', sourceType: 'manual', text: 'a note', author: 'ali' }), null);
  assert.equal(validateWorkflowHttpRequest('ingest-preview',
    { workspaceId: 'default', sourceType: 'decision', title: 't', rationale: 'why', decidedBy: 'ali' }), null);
  assert.ok(validateWorkflowHttpRequest('ingest-preview', { workspaceId: 'default', claim: 'a note' }),
    'preview must reject the claim-shaped body the generic dispatcher sent');
  assert.ok(validateWorkflowHttpRequest('ingest-preview', { workspaceId: 'default', text: 'a note' }),
    'sourceType is required, so a body without it must be rejected');

  // ingest-execute takes a permissive object at the HTTP boundary, so a
  // claim-shaped body passes validation and fails deeper, in the snapshot
  // builder, with a less legible error. The panel must not rely on that.
  assert.equal(validateWorkflowHttpRequest('ingest-execute', { workspaceId: 'default', claim: 'a note' }), null);
  assert.equal(buildIngestWorkflowPreview({ workspaceId: 'default', claim: 'a note' }).ok, false);
  assert.equal(buildIngestWorkflowPreview({ workspaceId: 'default', sourceType: 'manual', text: 'a note' }).ok, true);
});

test('the panel sends the fields each ingest source actually carries', () => {
  const page = html();
  const match = page.match(/else if\(INGEST_ACTIONS\.has\(a\)\)\{([\s\S]*?)\}else p\.claim=text;/);
  assert.ok(match, 'the ingest body mapping must be present');

  const build = (source, values) => {
    const elements = {
      ingestsource: { value: source },
      ingestauthor: { value: values.author || '' },
      ingesttitle: { value: values.title || '' },
    };
    const p = { workspaceId: 'default' };
    vm.runInNewContext(`(function(){${match[1]}})()`, {
      p, text: values.text, $: id => elements[id],
    });
    return p;
  };

  // What the panel builds must be what the route accepts -- asserted against
  // the schema itself, so a field renamed on either side turns this red.
  const manual = build('manual', { text: 'a note', author: 'ali' });
  assert.deepEqual(manual, { workspaceId: 'default', sourceType: 'manual', text: 'a note', author: 'ali' });
  assert.equal(validateWorkflowHttpRequest('ingest-preview', manual), null);

  const decision = build('decision', { text: 'because it is cheaper', title: 'use SQLite', author: 'ali' });
  assert.deepEqual(decision, {
    workspaceId: 'default', sourceType: 'decision', title: 'use SQLite',
    rationale: 'because it is cheaper', decidedBy: 'ali',
  });
  assert.equal(validateWorkflowHttpRequest('ingest-preview', decision), null);

  // An empty attribution field is omitted rather than sent as '', which would
  // overwrite the server's own 'unknown' default with something less true.
  assert.equal(Object.hasOwn(build('manual', { text: 'a note' }), 'author'), false);
});

test('a queued ingest is reported as an outcome, not a failure', () => {
  // ingest-execute answers ok:false with status review_required: the batch
  // reached the approval queue, which is what success looks like for a
  // mutation that needs a human. The generic `!r.ok || d.ok === false` throw
  // would have collapsed it into `failed: review_required` and dropped the
  // run id the operator needs to follow it.
  const page = html();
  const match = page.match(/const INGEST_SOFT_STATUS=new Set\(\[([^\]]*)\]\)/);
  assert.ok(match, 'the ingest soft-status set must be present');
  assert.deepEqual(match[1].split(',').map(part => part.trim().replace(/'/g, '')), ['review_required']);
  // Scoped to ingest actions on an HTTP-ok response: every other workflow,
  // and every other status, still throws.
  assert.match(page, /\|\|\(INGEST_ACTIONS\.has\(a\)&&INGEST_SOFT_STATUS\.has\(st\)\)\)/);
  assert.match(page, /if\(!soft&&\(!r\.ok\|\|d\.ok===false\)\)throw Error/);
});

test('the panel renders the handoff an ingest response carries', () => {
  const page = html();
  const match = page.match(/function ingestHandoff\(d\)\{([\s\S]*?)\}async function run/);
  assert.ok(match, 'the ingest handoff renderer must be present');
  const ingestHandoff = vm.runInNewContext(
    `(function ingestHandoff(d){${match[1]}})`,
    { esc: value => String(value ?? '') },
  );

  assert.equal(ingestHandoff({}), '');

  // The preview projection, as lib/ingest-workflow-preview.js builds it.
  const preview = buildIngestWorkflowPreview({ workspaceId: 'default', sourceType: 'manual', text: 'a note' });
  const previewed = ingestHandoff({ data: preview });
  assert.match(previewed, /digest /);
  assert.match(previewed, /submit_ingest_execute/);

  // The execute projection, as lib/http/workflow-data-routes.js writes it.
  const queued = ingestHandoff({ data: { runId: 'apr_1', statusRoute: '/api/v2/ingest/runs/apr_1' } });
  assert.match(queued, /run apr_1/);
  assert.match(queued, /\/api\/v2\/ingest\/runs\/apr_1/);
});

test('the ingest fields appear only for the ingest actions, and the title only for a decision', () => {
  const page = html();
  const match = page.match(/function ingestFields\(\)\{([\s\S]*?)\}function agentSteps/);
  assert.ok(match, 'the field toggle must be present');

  const elements = {
    action: { value: 'verify' },
    ingestsource: { value: 'manual' },
    ingestsourcefield: { hidden: false },
    ingestauthorfield: { hidden: false },
    ingesttitlefield: { hidden: false },
    promptlabel: { textContent: 'Claim / Query' },
    prompt: { placeholder: '' },
  };
  const ingestFields = vm.runInNewContext(
    `(function ingestFields(){${match[1]}})`,
    { $: id => elements[id], INGEST_ACTIONS: new Set(['ingest-preview', 'ingest-execute']) },
  );

  ingestFields();
  assert.equal(elements.ingestsourcefield.hidden, true);
  assert.equal(elements.ingesttitlefield.hidden, true);
  assert.equal(elements.promptlabel.textContent, 'Claim / Query', 'a non-ingest action keeps its own label');

  elements.action.value = 'ingest-preview';
  ingestFields();
  assert.equal(elements.ingestsourcefield.hidden, false);
  assert.equal(elements.ingestauthorfield.hidden, false);
  assert.equal(elements.ingesttitlefield.hidden, true, 'a manual note has no decision title');
  assert.equal(elements.promptlabel.textContent, 'Note text');

  elements.ingestsource.value = 'decision';
  ingestFields();
  assert.equal(elements.ingesttitlefield.hidden, false);
  assert.equal(elements.promptlabel.textContent, 'Rationale');

  // Fields are hidden with el.hidden, and the page carries the [hidden] rule
  // that makes that inert-proof (see dashboard-hidden-attribute).
  assert.match(page, /id="ingestsourcefield" hidden/);
  assert.match(page, /id="ingesttitlefield" hidden/);
  assert.match(page, /id="ingestauthorfield" hidden/);
  // The source select changes which fields apply, so it re-runs the toggle.
  assert.match(page, /\$\('ingestsource'\)\.onchange=actionFields;/);
});
