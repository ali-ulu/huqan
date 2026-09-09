'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { createCommandPolicyEditor } = require('../lib/command-policy-editor');
const { readAllowedCommands } = require('../lib/external-action-command-policy');
const { createCommandPolicyBoundary } = require('../lib/http/command-policy-route');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');

function fixture(t, value = { allowedCommands: ['npm test'], dataResidency: { allowedDestinations: ['eu'] } }) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-policy-editor-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const target = path.join(directory, 'policy.json');
  fs.writeFileSync(target, JSON.stringify(value));
  return { target, editor: createCommandPolicyEditor(target) };
}

test('save persists permissions for the hook and preserves other policy fields', t => {
  const { target, editor } = fixture(t);
  readAllowedCommands(target);
  const saved = editor.save({ revision: editor.snapshot().revision, allowedCommands: ['npm lint'] });
  assert.deepEqual(readAllowedCommands(target), ['npm lint']);
  assert.deepEqual(JSON.parse(fs.readFileSync(target)).dataResidency, { allowedDestinations: ['eu'] });
  assert.equal(saved.hostVerified, false);
  assert.deepEqual(createCommandPolicyEditor(target).snapshot(), saved);
});

test('stale save is refused without overwriting another operator edit', t => {
  const { target, editor } = fixture(t);
  const revision = editor.snapshot().revision;
  fs.writeFileSync(target, JSON.stringify({ allowedCommands: ['node --version'] }));
  assert.throws(() => editor.save({ revision, allowedCommands: [] }), { code: 'POLICY_CHANGED' });
  assert.deepEqual(readAllowedCommands(target), ['node --version']);
  assert.equal(fs.existsSync(`${target}.editor-lock`), false);
});

test('malformed files, invalid commands and busy writers cannot be overwritten', t => {
  const { target, editor } = fixture(t);
  assert.throws(() => editor.save({ revision: editor.snapshot().revision, allowedCommands: [42] }), { code: 'INVALID_COMMANDS' });
  fs.writeFileSync(`${target}.editor-lock`, 'busy');
  assert.throws(() => editor.save({ revision: editor.snapshot().revision, allowedCommands: [] }), { code: 'POLICY_BUSY' });
  fs.unlinkSync(`${target}.editor-lock`);
  fs.writeFileSync(target, '{invalid');
  assert.throws(() => editor.save({ revision: 'stale', allowedCommands: [] }), { code: 'POLICY_UNREADABLE' });
  assert.equal(fs.readFileSync(target, 'utf8'), '{invalid');
});

test('preview uses saved command classifier, never runs commands, and rejects stale revision', t => {
  const { editor } = fixture(t);
  const revision = editor.snapshot().revision;
  const preview = editor.preview({ revision, command: 'npm test -- --watch' });
  assert.equal(preview.matchedCommand, 'npm test');
  assert.equal(preview.executed, false);
  assert.equal(preview.hostVerified, false);
  assert.equal(editor.preview({ revision, command: 'npm testify' }).matchedCommand, '');
  assert.equal(editor.preview({ revision, command: 'npm test && git push' }).matchedCommand, '');
  assert.throws(() => editor.preview({ revision: 'old', command: 'npm test' }), { code: 'POLICY_CHANGED' });
});

test('legacy array and a missing file in an existing directory can be saved', t => {
  const { target, editor } = fixture(t, ['npm test']);
  editor.save({ revision: editor.snapshot().revision, allowedCommands: [] });
  assert.deepEqual(readAllowedCommands(target), []);
  fs.unlinkSync(target);
  editor.save({ revision: editor.snapshot().revision, allowedCommands: ['npm test'] });
  assert.deepEqual(readAllowedCommands(target), ['npm test']);
});

test('HTTP boundary requires separate operator authorization and refuses cross-origin writes', async t => {
  const { target } = fixture(t);
  const token = 'test-only-policy-operator-token-123456';
  const environment = { HUQAN_POLICY_EDITOR_TOKEN: token, HUQAN_API_KEY: 'agent-key', HUQAN_EXTERNAL_GUARD_POLICY: target };
  const boundary = createCommandPolicyBoundary({ environment });
  assert.equal(resolveRouteAuthPolicy('/api/command-policy', 'PUT', boundary.authContext).authRequired, true);
  assert.equal(createCommandPolicyBoundary({ environment: {} }).authContext.commandPolicyRouteEnabled, false);
  assert.equal(createCommandPolicyBoundary({ environment: { ...environment, HUQAN_API_KEY: token } }).authContext.commandPolicyRouteEnabled, false);
  assert.equal(createCommandPolicyBoundary({ environment: { ...environment, HUQAN_API_KEY: ` ${token} ` } }).authContext.commandPolicyRouteEnabled, false);
  const server = http.createServer((req, res) => boundary.route(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/api/command-policy`;
  assert.equal((await fetch(url, { headers: { 'X-API-Key': 'agent-key' } })).status, 403);
  const headers = { 'Content-Type': 'application/json', 'X-Huqan-Policy-Token': token };
  const snapshot = await (await fetch(url, { headers })).json();
  assert.equal((await fetch(url, { method: 'PUT', headers: { ...headers, Origin: 'https://other.example' }, body: JSON.stringify({ revision: snapshot.revision, allowedCommands: [] }) })).status, 403);
  const saved = await fetch(url, { method: 'PUT', headers, body: JSON.stringify({ revision: snapshot.revision, allowedCommands: ['npm run lint'] }) });
  assert.equal(saved.status, 200);
  const preview = await fetch(`${url}/preview`, { method: 'POST', headers, body: JSON.stringify({ revision: (await saved.json()).revision, command: 'npm run lint' }) });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).matchedCommand, 'npm run lint');
  assert.equal((await fetch(url, { method: 'PUT', headers, body: 'null' })).status, 400);
  assert.equal((await fetch(url, { method: 'DELETE', headers })).status, 405);
});
