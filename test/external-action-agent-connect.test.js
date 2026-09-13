'use strict';

/**
 * #2050 - `huqan-gate connect`: detect the agents on this machine and connect
 * the gate to each one, without asking the user which profile they are.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');

const { detectAgents, DETECTABLE_AGENTS } = require('../lib/external-action-agent-detection');
const { connectDetectedAgents, PROFILES } = require('../lib/external-action-gate-install');

function scratch(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2049-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, 'proj');
  const home = path.join(base, 'home');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  return { root, home, environment: { PATH: '', PATHEXT: '' } };
}

function byProfile(agents, profile) {
  return agents.find(agent => agent.profile === profile);
}

test('every detectable agent maps to an installable profile', () => {
  // A detection with no install behind it would offer the user a connection
  // that cannot be made.
  for (const agent of DETECTABLE_AGENTS) {
    assert.ok(PROFILES.includes(agent.profile), `${agent.profile} is detected but not installable`);
  }
});

test('nothing is detected on a machine with no agent', (t) => {
  const place = scratch(t);
  const detected = detectAgents(place).filter(agent => agent.detected);
  assert.deepEqual(detected, []);
});

test('the agent directory in the project is a detection signal', (t) => {
  const place = scratch(t);
  fs.mkdirSync(path.join(place.root, '.claude'), { recursive: true });

  const claude = byProfile(detectAgents(place), 'claude-code');
  assert.equal(claude.detected, true);
  assert.deepEqual(claude.signals, ['project']);
});

// The point of the whole surface: a first-time user has the agent installed but
// has never written a config for it. Waiting for `.claude/settings.json` to
// exist would refuse exactly that user -- install is what creates it.
test('an agent present only in the home directory is still detected', (t) => {
  const place = scratch(t);
  fs.mkdirSync(path.join(place.home, '.codex'), { recursive: true });

  const codex = byProfile(detectAgents(place), 'codex');
  assert.equal(codex.detected, true);
  assert.deepEqual(codex.signals, ['home']);
  assert.equal(fs.existsSync(path.join(place.root, '.codex', 'hooks.json')), false);
});

test('a launcher on PATH is a detection signal on its own', (t) => {
  const place = scratch(t);
  const binDir = path.join(place.root, 'fake-bin');
  fs.mkdirSync(binDir, { recursive: true });
  const name = process.platform === 'win32' ? 'opencode.CMD' : 'opencode';
  fs.writeFileSync(path.join(binDir, name), '');

  const opencode = byProfile(
    detectAgents({ ...place, environment: { PATH: binDir, PATHEXT: '.COM;.EXE;.BAT;.CMD' } }),
    'opencode',
  );
  assert.deepEqual(opencode.signals, ['path']);
});

test('connect --detect reports without writing anything', (t) => {
  const place = scratch(t);
  fs.mkdirSync(path.join(place.root, '.claude'), { recursive: true });

  const result = connectDetectedAgents({ ...place, detectOnly: true });

  assert.equal(byProfile(result.agents, 'claude-code').state, 'detected');
  assert.equal(result.connected, 0);
  assert.equal(
    fs.existsSync(path.join(place.root, '.claude', 'settings.json')),
    false,
    '--detect must not install',
  );
});

test('an undetected agent is reported, not omitted', (t) => {
  const place = scratch(t);
  const result = connectDetectedAgents({ ...place, detectOnly: true });

  assert.equal(result.agents.length, DETECTABLE_AGENTS.length);
  for (const agent of result.agents) assert.equal(agent.state, 'not-detected');
  assert.equal(result.connected, 0);
});

test('an ancestor huqan install is valid dependency evidence for a detected agent', (t) => {
  const place = scratch(t);
  fs.mkdirSync(path.join(place.root, '.opencode'), { recursive: true });
  const packageRoot = path.join(path.dirname(place.root), 'node_modules', 'huqan');
  fs.mkdirSync(path.dirname(packageRoot), { recursive: true });
  fs.symlinkSync(path.resolve(__dirname, '..'), packageRoot, 'junction');

  const result = connectDetectedAgents(place);
  const opencode = byProfile(result.agents, 'opencode');

  assert.equal(opencode.state, 'connected');
  assert.equal(result.connected, 1);
  assert.equal(result.refused, 0);
});

// A connect run that hid a failure would be the fake green (#1792, #1797) this
// surface exists to avoid: the user would read "done" and be unprotected.
test('a refused install is reported with its reason, and does not stop the run', (t) => {
  const place = scratch(t);
  fs.mkdirSync(path.join(place.root, '.opencode'), { recursive: true });
  const resolveFilename = Module._resolveFilename;
  t.mock.method(Module, '_resolveFilename', function rejectHuqan(request, ...args) {
    if (request === 'huqan') {
      const error = new Error("Cannot find module 'huqan'");
      error.code = 'MODULE_NOT_FOUND';
      throw error;
    }
    return resolveFilename.call(this, request, ...args);
  });

  const result = connectDetectedAgents(place);
  const opencode = byProfile(result.agents, 'opencode');

  assert.equal(opencode.state, 'refused');
  assert.ok(opencode.reason && opencode.reason.length > 0, 'a refusal must say why');
  assert.equal(result.refused, 1);
  assert.equal(result.connected, 0);
  assert.equal(
    fs.existsSync(path.join(place.root, '.opencode', 'plugin', 'huqan.mjs')),
    false,
    'a refused install leaves nothing behind',
  );
});

test('connect always names the custom-agent path', (t) => {
  const place = scratch(t);
  const result = connectDetectedAgents({ ...place, detectOnly: true });

  assert.equal(result.customAgent.profile, 'generic');
  assert.match(result.customAgent.how, /huqan\.external-action\.v1/);
  assert.match(result.customAgent.verify, /status --profile generic/);
});
