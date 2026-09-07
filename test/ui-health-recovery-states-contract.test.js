'use strict';

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

// #1930: the dashboard must never show a bare surface-count status again.
// Every aggregate state has to name what happened and the next user action,
// derived from the single aggregateStatus helper, with keyboard-accessible
// recovery actions rendered next to every status projection.
const { dashboardSource, dashboardScript } = require('./helpers/dashboard-source');

const script = dashboardScript();
const html = dashboardSource();

const match = script.match(/function aggregateStatus\(surfaces\)\{([\s\S]*?)\}function renderHealth/);
assert.ok(match, 'aggregate status helper must be present in the dashboard script');
const aggregateStatus = vm.runInNewContext(`(function aggregateStatus(surfaces){${match[1]}})`);

function surfacesWith(map) {
  return {
    status: { s: map.status || 'ok' },
    workflows: { s: map.workflows || 'ok' },
    graph: { s: map.graph || 'ok' },
    approvals: { s: map.approvals || 'ok' },
    activity: { s: map.activity || 'ok' },
  };
}

test('every aggregate state names what happened and the next action', () => {
  const cases = [
    [{}, 'HEALTHY', 'All surfaces are live.', 'Refresh anytime.', null],
    [{ status: 'checking', workflows: 'checking', graph: 'checking', approvals: 'checking', activity: 'checking' },
      'CHECKING', 'Checking surfaces \u2014 results have not come back yet.', 'Wait a moment, then refresh.', { kind: 'refresh' }],
    [{ activity: 'locked' },
      'PARTIAL', 'Some surfaces are locked \u2014 an API key is required.', 'Open Settings and add your API key.', { kind: 'settings' }],
    [{ activity: 'err' },
      'DEGRADED', 'At least one surface failed to load.', 'Retry the failed surfaces.', { kind: 'refresh' }],
    [{ graph: 'empty', approvals: 'empty' },
      'PARTIAL', 'Some surfaces are not live yet.', 'Open Surfaces to review each one.', { kind: 'surfaces' }],
    [{ status: 'err', workflows: 'err', graph: 'err', approvals: 'err', activity: 'err' },
      'OFFLINE', 'At least one surface failed to load.', 'Retry the failed surfaces.', { kind: 'refresh' }],
    [{ status: 'empty', workflows: 'empty', graph: 'empty', approvals: 'empty', activity: 'empty' },
      'OFFLINE', 'No surfaces responded.', 'Retry all surfaces.', { kind: 'refresh' }],
    [{ activity: 'locked', graph: 'err' },
      'DEGRADED', 'Some surfaces are locked \u2014 an API key is required.', 'Open Settings and add your API key.', { kind: 'settings' }],
  ];
  for (const [map, label, message, nextAction, recovery] of cases) {
    const result = aggregateStatus(surfacesWith(map));
    assert.equal(result.label, label, 'label for ' + JSON.stringify(map));
    assert.equal(result.message, message, 'message for ' + JSON.stringify(map));
    assert.equal(result.nextAction, nextAction, 'nextAction for ' + JSON.stringify(map));
    assert.equal(result.recovery ? result.recovery.kind : null, recovery ? recovery.kind : null, 'recovery for ' + JSON.stringify(map));
  }
});

test('no false healthy state: any non-ok surface keeps the aggregate unhealthy', () => {
  for (const state of ['locked', 'err', 'empty', 'checking']) {
    const result = aggregateStatus(surfacesWith({ activity: state }));
    assert.notEqual(result.label, 'HEALTHY', 'state ' + state + ' must never look healthy');
  }
});

test('status projections stay aligned and carry the recovery action', () => {
  assert.match(script, /aggregate=aggregateStatus\(state\.surfaces\)/);
  assert.match(script, /\$\('sys'\)\.textContent=aggregate\.label/);
  assert.match(script, /\$\('healthsum'\)\.textContent=`\$\{aggregate\.label\} \u00B7 \$\{aggregate\.message\}`/);
  assert.match(script, /\$\('footstatus'\)\.textContent=`\$\{aggregate\.label\} \u00B7 \$\{aggregate\.message\}`/);
  assert.match(script, /\$\('healthcta'\)\.innerHTML=rcta/);
  assert.match(script, /\$\('footcta'\)\.innerHTML=rcta/);
  assert.match(script, /<button type="button" class="btn"/);
  assert.match(script, /data-go="settings"/);
  assert.match(script, /data-go="integrations"/);
  assert.match(script, /data-action="refresh"/);
  assert.match(html, /id="healthcta"/);
  assert.match(html, /id="footcta"/);
});

test('the raw surface-count status text is gone from the whole public surface', () => {
  const banned = 'surfaces available';
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!/\.(html|js|css|mjs|json|svg)$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf8');
      assert.ok(!text.includes(banned), path.relative(path.join(__dirname, '..', 'public'), full) + ' still contains the banned surface-count copy');
    }
  };
  walk(path.join(__dirname, '..', 'public'));
});

test('the patched dashboard script still compiles', () => {
  assert.doesNotThrow(() => new vm.Script(script));
});
