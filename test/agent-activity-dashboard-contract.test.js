const assert = require('node:assert/strict');
const vm = require('node:vm');
const { describe, it } = require('node:test');

// This file keeps the markup and the script apart on purpose: it is the one
// place that asserts the extraction itself happened, so it must be able to tell
// which half a string came from. Everywhere else uses dashboardSource().
const { readHtml, dashboardScript } = require('./helpers/dashboard-source');

const dashboard = readHtml();
const script = dashboardScript(dashboard);

describe('Agent Activity dashboard contract', () => {
  it('references the extracted dashboard script from index.html', () => {
    assert.match(dashboard, /<script src="\/js\/app\.js"><\/script>/);
    assert.doesNotMatch(dashboard, /<script>'use strict'/);
  });

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
    assert.match(script, /Tools:/);
  });

  it('renders the workspace tool usage donut and accessible legend', () => {
    assert.match(dashboard, /id="obstooldonut"/);
    assert.match(dashboard, /id="obstoollegend"/);
    assert.match(script, /function renderToolUsage\(metrics\)/);
    assert.match(script, /metrics\.toolUsage/);
    assert.match(script, /conic-gradient/);
    assert.match(script, /aria-label/);
    assert.match(script, /Tool usage distribution/);
  });

  it('uses consistent English copy for dashboard states and formatting', () => {
    for (const legacyCopy of [
      'Araçlar:',
      'Araç kullanım dağılımı',
      'Activity erişimi kilitli.',
      'Bu workspace’te henüz ajan eylemi yok.',
      'Activity okunamadı. Tekrar deneyin.',
      'Sistem Sağlıklı',
      'Son senkronizasyon:',
      'tr-TR',
    ]) {
      assert.doesNotMatch(dashboard, new RegExp(legacyCopy.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')));
    }
    assert.match(dashboard, /Search: receipt ID, claim, source…/);
    assert.ok(script.includes("new Intl.DateTimeFormat('en-US'"));
  });

  it('keeps the dashboard script syntactically valid', () => {
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
  });
});

// The dashboard is a static runtime surface; this test intentionally checks
// its source contract without creating a browser or making network requests.
