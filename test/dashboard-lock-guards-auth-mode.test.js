'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const DASHBOARD = path.join(__dirname, '..', 'public', 'index.html');

// The dashboard short-circuits two surfaces before it ever calls the server,
// on the assumption that no key means no access. On a server running with
// HUQAN_DISABLE_API_AUTH there is no key to hold, so that assumption strands
// the surface on LOCKED and points the operator at a Settings field that the
// same build now hides. Every such guard must consult the auth mode too.
function guards(html) {
  return [...html.matchAll(/if\(([^)]*state\.key[^)]*)\)\{[\s\S]{0,160}?surface\('([a-z]+)','locked'/g)]
    .map((match) => ({ surface: match[2], condition: match[1] }));
}

test('the dashboard still short-circuits at least one surface on a missing key', () => {
  assert.ok(guards(fs.readFileSync(DASHBOARD, 'utf8')).length > 0, 'guard shape changed; update this contract');
});

test('every pre-request lock guard consults the auth mode', () => {
  const offenders = guards(fs.readFileSync(DASHBOARD, 'utf8'))
    .filter((guard) => !guard.condition.includes('state.authRequired'))
    .map((guard) => `${guard.surface}: ${guard.condition}`);

  assert.deepEqual(
    offenders,
    [],
    'these surfaces lock themselves without asking whether the server requires a key at all',
  );
});
