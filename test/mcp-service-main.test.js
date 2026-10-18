'use strict';

/**
 * The MCP service entry point (ADR-018 §3, #3999): the pin is written once,
 * serve refuses a process that loaded code outside its app root, refuses a
 * pin disagreement, and really listens behind the envelope check when the
 * configuration agrees.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

const { deriveWorkspaceId } = require('../lib/protected-store-path');
const { initService, loadedOutsideRoot, parseOptions, serveService } = require('../lib/mcp/service-main');

const ROOT = path.join(__dirname, '..');
const MAIN = path.join(ROOT, 'lib', 'mcp', 'service-main.js');
const { NODE_TEST_CONTEXT: _parent, ...CHILD_ENV } = process.env;

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-servicemain-'));
  t.after(() => {
    // A serving child's cwd holds a directory handle; a not-yet-dead child
    // must not fail the whole file over leftover temp junk.
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* OS temp cleanup sweeps leftovers */ }
  });
  return dir;
}

function freePort() {
  return new Promise((resolve) => {
    const blocker = net.createServer();
    blocker.listen(0, '127.0.0.1', () => {
      const port = blocker.address().port;
      blocker.close(() => resolve(port));
    });
  });
}

test('init writes the endpoint pin once and refuses to run again or on bad ground', (t) => {
  const dir = tempDir(t);
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  const workspaceRoot = fs.mkdtempSync(path.join(dir, 'workspace-'));
  const init = () => initService({ name: 'levh', publicDir, port: 47921, operator: 'DESKTOP\\operator', workspaceRoot });
  const pin = init();
  assert.equal(pin.v, 'huqan.mcp.endpoint.v1');
  assert.equal(pin.url, 'http://127.0.0.1:47921');
  assert.equal(pin.operator, 'DESKTOP\\operator');
  assert.equal(pin.workspaceId, deriveWorkspaceId(workspaceRoot));
  assert.throws(init, /pin_exists/);
  assert.throws(() => initService({ name: 'levh', publicDir, port: 0, operator: 'DESKTOP\\operator', workspaceRoot }), /fixed --port/);
  assert.throws(() => initService({ name: 'levh', publicDir, port: 47921, operator: 'DESKTOP\\operator', workspaceRoot }), /pin_exists/);
  assert.throws(() => initService({ name: 'levh', publicDir: path.join(dir, 'absent'), port: 47921, operator: 'DESKTOP\\operator', workspaceRoot }), /does not exist/);
  assert.throws(() => initService({ name: 'levh', publicDir, port: 47921, operator: '', workspaceRoot }), /--operator/);
  assert.throws(() => initService({ name: 'LEVH', publicDir, port: 47921, operator: 'DESKTOP\\operator', workspaceRoot }), /name_invalid/);
});

test('options are strict', () => {
  assert.throws(() => parseOptions(['--name', 'levh', '--port', '70000']), /port/);
  assert.throws(() => parseOptions(['--port', '1']), /--name/);
  assert.throws(() => parseOptions(['--name', 'levh', '--workspace-root', 'x', '--eval', 'y']), /unknown/);
});

test('the app-root check names anything loaded from outside the app root', () => {
  assert.deepEqual(loadedOutsideRoot([path.join(ROOT, 'lib/mcp/client-envelope.js')], ROOT), []);
  const outside = loadedOutsideRoot([path.join(os.tmpdir(), 'elsewhere.js')], ROOT);
  assert.equal(outside.length, 1);
  assert.ok(outside[0].endsWith('elsewhere.js'), outside[0]);
});

test('serve refuses to start in a process that has loaded code outside the app root', (t) => {
  const dir = tempDir(t);
  // This test process has loaded node:test and this test file: exactly the
  // situation of a service started from a user-writable checkout.
  assert.throws(() => serveService({ name: 'levh', stateDir: path.join(dir, 'state'), publicDir: path.join(dir, 'public'),
    port: 47921, workspaceRoot: dir, appRoot: path.join(dir, 'app') }, () => {}),
  /refusing to start: loaded code outside the app root: .*test\/mcp-service-main\.test\.js/);
});

test('serve refuses a pin disagreement before opening the store or the listener', (t) => {
  const dir = tempDir(t);
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(publicDir);
  fs.writeFileSync(path.join(publicDir, 'endpoint.json'), `${JSON.stringify({ v: 'huqan.mcp.endpoint.v1', name: 'other', port: 1, operator: 'a\\b', workspaceId: '0123456789abcdef', url: 'http://127.0.0.1:1' })}\n`);
  assert.throws(() => serveService({ name: 'levh', stateDir: path.join(dir, 'state'), publicDir,
    port: 47921, workspaceRoot: dir, appRoot: ROOT }, () => {}), /the pin names/);
});

test('a serving child really listens behind the envelope check and fails closed', async (t) => {
  const dir = tempDir(t);
  const publicDir = path.join(dir, 'public');
  const stateDir = path.join(dir, 'state');
  const workspaceRoot = fs.mkdtempSync(path.join(dir, 'workspace-'));
  fs.mkdirSync(publicDir);
  fs.mkdirSync(stateDir);
  const port = await freePort();
  const init = spawnSync(process.execPath, [MAIN, 'init', '--name', 'levh', '--state-dir', stateDir,
    '--public-dir', publicDir, '--port', String(port), '--operator', 'DESKTOP\\operator', '--workspace-root', workspaceRoot],
  { encoding: 'utf8', env: CHILD_ENV, cwd: dir });
  assert.equal(init.status, 0, init.stderr);

  const child = spawn(process.execPath, [MAIN, 'serve', '--name', 'levh', '--state-dir', stateDir,
    '--public-dir', publicDir, '--port', String(port), '--workspace-root', workspaceRoot, '--app-root', ROOT],
  { env: CHILD_ENV, cwd: dir });
  // The child's cwd holds a directory handle: wait for its exit before the
  // cleanup hook removes the tree, or Windows answers EBUSY.
  t.after(() => new Promise((resolve) => {
    child.once('exit', () => resolve());
    child.kill();
    setTimeout(resolve, 3000);
  }));
  await new Promise((resolve, reject) => {
    let text = '';
    child.stderr.on('data', (chunk) => {
      text += chunk;
      if (text.includes('"listening"')) resolve();
      if (text.includes('"fatal"')) reject(new Error(text));
    });
    child.on('exit', (code) => reject(new Error(`service exited ${code}: ${text}`)));
  });
  const response = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/' }, (answer) => {
      let text = '';
      answer.on('data', (chunk) => { text += chunk; });
      answer.on('end', () => resolve({ status: answer.statusCode, text }));
    });
    request.on('error', reject);
    request.end('{}');
  });
  assert.equal(response.status, 403, 'the child serves fail-closed');
  assert.equal(JSON.parse(response.text).error.code, 'malformed');
});

test('a port already in use is reported as fatal with a failing exit code', async (t) => {
  const dir = tempDir(t);
  const publicDir = path.join(dir, 'public');
  const stateDir = path.join(dir, 'state');
  const workspaceRoot = fs.mkdtempSync(path.join(dir, 'workspace-'));
  fs.mkdirSync(publicDir);
  fs.mkdirSync(stateDir);
  const blocker = http.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  t.after(() => blocker.close());
  const port = blocker.address().port;
  spawnSync(process.execPath, [MAIN, 'init', '--name', 'levh', '--state-dir', stateDir, '--public-dir', publicDir,
    '--port', String(port), '--operator', 'DESKTOP\\operator', '--workspace-root', workspaceRoot], { env: CHILD_ENV, cwd: dir });
  const run = spawnSync(process.execPath, [MAIN, 'serve', '--name', 'levh', '--state-dir', stateDir, '--public-dir', publicDir,
    '--port', String(port), '--workspace-root', workspaceRoot, '--app-root', ROOT],
  { encoding: 'utf8', env: CHILD_ENV, cwd: dir, timeout: 20000 });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /"event":"fatal".*EADDRINUSE/);
});

