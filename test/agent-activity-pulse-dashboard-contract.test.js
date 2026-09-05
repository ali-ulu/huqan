const assert = require('node:assert');
const vm = require('node:vm');
const test = require('node:test');

// #1894 and #1895 moved the dashboard's CSS and JS out of public/index.html.
// The contract is about what the browser loads, not about which file the bytes
// sit in, so the helper follows the <link> and <script src>.
const { dashboardSource, dashboardScript } = require('./helpers/dashboard-source');

// `dashboard` has always meant everything the page is -- when the CSS and JS
// were inline, reading index.html gave exactly that. dashboardSource() is the
// faithful equivalent now that both live in linked files.
const dashboard = dashboardSource();
const script = dashboardScript(dashboard);

assert.ok(script.trim(), 'dashboard script must exist');

test('Agent Activity Pulse dashboard contract', async (t) => {
  await t.test('exposes an accessible Overview widget with bounded activity content', () => {
    for (const id of [
      'activitypulse',
      'activitypulse-title',
      'activitypulsestate',
      'activitypulsecount',
      'activitypulseactors',
      'activitypulsereceipts',
      'activitypulseitems',
      'activitypulsemeta',
      'agentpulserefresh',
      'agentpulseopen',
    ]) {
      assert.match(dashboard, new RegExp(`id="${id}"`), `missing ${id}`);
    }
    assert.match(dashboard, /aria-labelledby="activitypulse-title"/);
    assert.match(dashboard, /id="activitypulsestate"[^>]*role="status"/);
    assert.match(dashboard, /id="activitypulseitems"[^>]*aria-live="polite"/);
    assert.match(dashboard, /data-activity-pulse-id/);
  });

  await t.test('uses the existing workspace-scoped activity read surface without fake totals', () => {
    assert.match(script, /async function loadActivityPulse\(\)/);
    assert.match(script, /new URLSearchParams\(\{workspaceId:state\.ws,limit:'5',order:'desc'\}\)/);
    assert.match(script, /\/api\/workbench\/activity\?/);
    assert.match(script, /(?:state\.activityPulse\.hasMore|p\.hasMore)/);
    assert.match(script, /slice\(0,5\)/);
    assert.doesNotMatch(script, /activityPulse\.total/);
    assert.doesNotMatch(script, /activityPulse\.totalCount/);
  });

  await t.test('pins fail-closed, bounded and actionable UI states', () => {
    for (const state of ['LOADING', 'LOCKED', 'ERROR', 'EMPTY', 'LIVE']) {
      assert.match(script, new RegExp(`pulseStatus\\('${state}'`), `missing ${state} state`);
    }
    assert.match(script, /const locked=r\.status===401\|\|r\.status===403/);
    assert.match(script, /Activity access is locked\. Add an API key in Settings\./);
    assert.match(script, /No agent actions in this workspace yet\./);
    assert.match(script, /Activity could not be loaded\. Try again\./);
  });

  await t.test('pins refresh and keyboard/click-through wiring', () => {
    assert.match(script, /\$\('agentpulserefresh'\)\.onclick=loadActivityPulse/);
    assert.match(script, /\$\('agentpulseopen'\)\.onclick=\(\)=>openAgentActivity\(\)/);
    assert.match(script, /\$\('activitypulseitems'\)\.onclick/);
    assert.match(script, /\$\('activitypulseitems'\)\.onkeydown/);
    assert.match(script, /function openAgentActivity\(id\)/);
    assert.match(script, /go\('activity'\)/);
    assert.match(script, /showActivity\(id\)/);
  });

  await t.test('reflects the activity read surface in the Integration Surfaces registry', () => {
    assert.ok(script.includes("activity:{label:'Agent Activity',endpoint:'/api/workbench/activity',s:'checking',reason:'Waiting for activity."));
    assert.ok(script.includes("activity:'Workspace-scoped bounded agent activity read surface.'"));
    assert.ok(script.includes("async function loadActivityPulse(){surface('activity','checking',{reason:'Loading activity.'"));
    assert.match(script, /surface\('activity',locked\?'locked':'err',\{reason:/);
    assert.match(script, /surface\('activity',empty\?'empty':'ok',\{reason:/);
    assert.match(script, /surface\('activity','err',\{reason:/);
  });

  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
