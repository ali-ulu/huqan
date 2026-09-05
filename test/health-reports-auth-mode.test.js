'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { createRuntimeStatusHandlers } = require('../lib/http/runtime-status');

// The key field is markup, but reading the auth mode and hiding the field are
// script -- and #1895 moved the script into public/js/app.js. Each half is read
// from where the browser gets it.
const { readHtml, dashboardScript } = require('./helpers/dashboard-source');

const DISABLE_VAR = 'HUQAN_DISABLE_API_AUTH';

function handlers() {
  return createRuntimeStatusHandlers({
    kernel: { graph: { getStats: () => ({ backend: 'memory', nodes: 0, edges: 0 }) } },
    pkg: { version: '0.0.0-test' },
    kernelVersion: 'v2',
    agentVersion: 'v2',
    agentRuntimeMode: 'test',
    phases: [],
  });
}

function withDisableFlag(value, run) {
  const previous = process.env[DISABLE_VAR];
  if (value === undefined) delete process.env[DISABLE_VAR];
  else process.env[DISABLE_VAR] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[DISABLE_VAR];
    else process.env[DISABLE_VAR] = previous;
  }
}

test('health reports that auth is required by default', () => {
  withDisableFlag(undefined, () => {
    assert.equal(handlers().getHealthData().apiAuthRequired, true);
  });
});

test('health reports that auth is not required once the opt-out is set', () => {
  withDisableFlag('true', () => {
    assert.equal(handlers().getHealthData().apiAuthRequired, false);
  });
});

test('health never carries the configured key', () => {
  withDisableFlag(undefined, () => {
    const body = JSON.stringify(handlers().getHealthData());
    assert.equal(body.includes('apiKey'), false);
    assert.equal(body.toLowerCase().includes('bearer'), false);
  });
});

test('the dashboard asks health for the auth mode and can hide the key field', () => {
  const html = readHtml();
  const script = dashboardScript(html);
  assert.ok(html.includes('id="keyfield"'), 'the API key field needs an id so it can be hidden');
  assert.ok(script.includes('apiAuthRequired'), 'the dashboard must read the auth mode from /health');
  assert.ok(
    script.includes("$('keyfield').hidden=open"),
    'the dashboard must hide the key field when the server requires no auth',
  );
});
