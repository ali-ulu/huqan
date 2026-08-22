const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { describe, it } = require('node:test');

const dashboard = fs.readFileSync('public/index.html', 'utf8');
const script = dashboard.match(/<script>([\s\S]*)<\/script>/)?.[1];

describe('Agent Activity dashboard contract', () => {
  it('exposes the activity navigation and read-only timeline view', () => {
    assert.match(dashboard, /data-v="activity"/);
    assert.match(dashboard, /id="v-activity"/);
    assert.match(dashboard, /Agent Activity & Trust Receipts/);
    assert.match(dashboard, /id="activityactor"/);
    assert.match(dashboard, /id="activityevent"/);
    assert.match(dashboard, /id="activitynext"/);
    assert.match(dashboard, /id="activityjson"/);
  });

  it('keeps activity access workspace-scoped, bounded, and linked to receipt detail', () => {
    assert.match(script, /\/api\/workbench\/activity\?/);
    assert.match(script, /workspaceId:state\.ws/);
    assert.match(script, /limit:'25'/);
    assert.match(script, /cursor/);
    assert.match(script, /\/api\/workbench\/trust-receipt\//);
    assert.match(script, /activity failed/);
  });

  it('renders unique tools and call counts in run history', () => {
    assert.match(script, /Array\.isArray\(run\.tools\)/);
    assert.match(script, /tool\.name/);
    assert.match(script, /tool\.count/);
    assert.match(script, /toolCallCount/);
    assert.match(script, /Araçlar:/);
  });

  it('renders the workspace tool usage donut and accessible legend', () => {
    assert.match(dashboard, /id="obstooldonut"/);
    assert.match(dashboard, /id="obstoollegend"/);
    assert.match(script, /function renderToolUsage\(metrics\)/);
    assert.match(script, /metrics\.toolUsage/);
    assert.match(script, /conic-gradient/);
    assert.match(script, /aria-label/);
    assert.match(script, /Araç kullanım dağılımı/);
  });

  it('keeps the inline dashboard script syntactically valid', () => {
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
  });
});

// The dashboard is a static runtime surface; this test intentionally checks
// its source contract without creating a browser or making network requests.
