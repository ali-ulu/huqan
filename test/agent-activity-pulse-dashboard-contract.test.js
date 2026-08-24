const assert = require('node:assert');
const fs = require('node:fs');
const vm = require('node:vm');
const test = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];

assert.ok(script, 'dashboard inline script must exist');

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
    assert.match(script, /r\.status===401\|\|r\.status===403\?'LOCKED':'ERROR'/);
    assert.match(script, /Activity erişimi kilitli\. Settings’ten API key ekleyin\./);
    assert.match(script, /Bu workspace’te henüz ajan eylemi yok\./);
    assert.match(script, /Activity okunamadı\. Tekrar deneyin\./);
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

  await t.test('keeps the inline dashboard script syntactically valid', () => {
    assert.doesNotThrow(() => new vm.Script(script));
  });
});
