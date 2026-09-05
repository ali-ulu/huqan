'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
// These guards are script, and #1895 moved the script out of public/index.html
// into public/js/app.js. The helper follows the <script src>, so this contract
// keeps describing behaviour rather than which file the bytes sit in.
const { dashboardScript } = require('./helpers/dashboard-source');

// The dashboard short-circuits two surfaces before it ever calls the server,
// on the assumption that no key means no access. On a server running with
// HUQAN_DISABLE_API_AUTH there is no key to hold, so that assumption strands
// the surface on LOCKED and points the operator at a Settings field that the
// same build now hides. Every such guard must consult the auth mode too.
function guards(script) {
  return [...script.matchAll(/if\(([^)]*state\.key[^)]*)\)\{[\s\S]{0,160}?surface\('([a-z]+)','locked'/g)]
    .map((match) => ({ surface: match[2], condition: match[1] }));
}

test('the dashboard still short-circuits at least one surface on a missing key', () => {
  assert.ok(guards(dashboardScript()).length > 0, 'guard shape changed; update this contract');
});

test('every pre-request lock guard consults the auth mode', () => {
  const offenders = guards(dashboardScript())
    .filter((guard) => !guard.condition.includes('state.authRequired'))
    .map((guard) => `${guard.surface}: ${guard.condition}`);

  assert.deepEqual(
    offenders,
    [],
    'these surfaces lock themselves without asking whether the server requires a key at all',
  );
});
