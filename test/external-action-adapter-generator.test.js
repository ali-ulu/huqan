'use strict';

/**
 * #2061 - `huqan-gate adapter` generates the custom agent's integration instead
 * of describing it. These tests run the generated file, because a generated
 * adapter that is never executed is a description with a filename.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  SENTINEL_REASON,
  writeCustomAgentAdapter,
} = require('../lib/external-action-adapter-generator');

const REPO_ROOT = path.resolve(__dirname, '..');

function project(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2061-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'scratch', version: '1.0.0' }));
  return root;
}

/** Runs one command through the generated adapter, in its own process. */
function throughAdapter(root, command, environment = {}) {
  const driver = path.join(root, 'driver.js');
  fs.writeFileSync(driver, `
    const { huqanCheck, HuqanBlocked } = require('./huqan-adapter.js');
    try {
      const decision = huqanCheck({
        agentName: 'my-agent', toolName: 'shell', kind: 'shell',
        args: { command: process.argv[2] }, cwd: __dirname,
      });
      process.stdout.write(JSON.stringify({ ran: true, reason: decision.reason }));
    } catch (error) {
      process.stdout.write(JSON.stringify({
        ran: false,
        blocked: error instanceof HuqanBlocked,
        decision: error.decision || null,
        reason: error.reason || error.message,
      }));
    }
  `);
  const run = spawnSync(process.execPath, [driver, command], {
    cwd: root,
    encoding: 'utf8',
    timeout: 60000,
    env: { ...process.env, ...environment },
  });
  return JSON.parse(run.stdout || '{}');
}

test('the gate command is proven against the denylist before it is written', (t) => {
  const root = project(t);
  const result = writeCustomAgentAdapter({ root });

  assert.equal(result.sentinel.decision, 'block');
  // Not merely "it blocked": a claude-code-shaped payload sent to the generic
  // profile also blocks, as malformed input, which proves the wrong path.
  assert.equal(result.sentinel.reason, SENTINEL_REASON);
  assert.equal(fs.existsSync(result.target), true);
});

// The Windows path bug this cost a round to find: written raw into the
// template, `C:\Users\...\bin\...` turns \U and \b into escape sequences. It
// failed closed -- and an adapter that blocks `git status` is a broken install,
// not enforcement.
test('the gate command is embedded as an escaped literal', (t) => {
  const root = project(t);
  const result = writeCustomAgentAdapter({ root });
  const source = fs.readFileSync(result.target, 'utf8');
  const line = source.split('\n').find(entry => entry.startsWith('const GATE_COMMAND'));

  assert.ok(line, 'the adapter must declare GATE_COMMAND');
  assert.equal(line.includes('__HUQAN_GATE_COMMAND__'), false, 'the placeholder must be replaced');
  // Whatever the path was, reading the literal back must give the command the
  // generator proved -- which a raw substitution does not.
  const embedded = JSON.parse(line.slice(line.indexOf('=') + 1, line.lastIndexOf(';')).trim());
  assert.equal(embedded, result.gateCommand);
});

test('an existing adapter is not overwritten without force', (t) => {
  const root = project(t);
  const first = writeCustomAgentAdapter({ root });
  fs.writeFileSync(first.target, '// hand-edited by the user\n');

  assert.throws(() => writeCustomAgentAdapter({ root }), (error) => {
    assert.equal(error.code, 'ADAPTER_EXISTS');
    return true;
  });
  assert.match(fs.readFileSync(first.target, 'utf8'), /hand-edited/);

  writeCustomAgentAdapter({ root, force: true });
  assert.doesNotMatch(fs.readFileSync(first.target, 'utf8'), /hand-edited/);
});

test('the generated adapter runs a benign command and stops a denylisted one', (t) => {
  const root = project(t);
  writeCustomAgentAdapter({ root });

  const benign = throughAdapter(root, 'git status');
  assert.equal(benign.ran, true, `git status must not be blocked, got: ${benign.reason}`);

  const destructive = throughAdapter(root, 'rm -rf /');
  assert.equal(destructive.ran, false);
  assert.equal(destructive.blocked, true);
  assert.equal(destructive.decision, 'block');
  assert.equal(destructive.reason, SENTINEL_REASON);
});

// Writing this wrong is the failure that matters, because it fails OPEN and
// looks fine. Two distinct branches, and the first version of this test only
// covered the second: `node missing-script.js` starts fine and merely produces
// no output, so it proved the unparsable-output path while claiming to prove
// the unstartable one. Mutation caught it -- making the adapter return allow on
// spawn failure left the suite green.
test('the generated adapter fails closed when the gate binary does not exist', (t) => {
  const root = project(t);
  writeCustomAgentAdapter({ root });

  const result = throughAdapter(root, 'git status', {
    HUQAN_GATE_PATH: 'huqan-gate-that-does-not-exist',
  });

  assert.equal(result.ran, false, 'a gate that cannot be started must not allow the action');
  assert.equal(result.blocked, true);
  assert.match(result.reason, /could not be started/);
});

test('the generated adapter fails closed when the gate produces no decision', (t) => {
  const root = project(t);
  writeCustomAgentAdapter({ root });

  const result = throughAdapter(root, 'git status', {
    HUQAN_GATE_PATH: `node ${path.join(root, 'no-such-gate.js')}`,
  });

  assert.equal(result.ran, false, 'unreadable output must not allow the action');
  assert.equal(result.blocked, true);
  assert.match(result.reason, /could not be parsed/);
});

test('a decision the adapter does not understand is not an allow', (t) => {
  const root = project(t);
  writeCustomAgentAdapter({ root });
  // A gate that answers allow under a schema this adapter has never seen. A
  // future contract change must stop the adapter, not slip past it.
  const impostor = path.join(root, 'impostor-gate.js');
  fs.writeFileSync(impostor, `process.stdout.write(JSON.stringify({ schemaVersion: 'huqan.guard-decision.v9', decision: 'allow', reason: 'from the future' }));`);

  const result = throughAdapter(root, 'git status', {
    HUQAN_GATE_PATH: `node ${impostor}`,
  });

  assert.equal(result.ran, false, 'an unknown decision schema must not be read as allow');
  assert.match(result.reason, /schema/i);
});

test('the result names the call site and how to verify it', (t) => {
  const root = project(t);
  const result = writeCustomAgentAdapter({ root, agentName: 'deploy-bot' });

  assert.match(result.callSite, /huqanCheck\(/);
  assert.match(result.callSite, /deploy-bot/);
  assert.match(result.verify, /status --profile generic/);
  assert.equal(result.testPayload.expect, 'block');
  assert.equal(result.testPayload.envelope.schemaVersion, 'huqan.external-action.v1');
  assert.equal(result.testPayload.envelope.agentName, 'deploy-bot');
});

test('the template in the repository still carries the placeholder', () => {
  const template = fs.readFileSync(
    path.join(REPO_ROOT, 'adapters', 'external-action', 'generic-adapter.js'),
    'utf8',
  );
  assert.match(template, /__HUQAN_GATE_COMMAND__/, 'a template without the placeholder would ship an unusable adapter');
});
