'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  createGitHubAppBetaServer,
  buildProductionBoundary,
  startGitHubAppBetaServer,
} = require('../github-app-server.js');

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

test('createGitHubAppBetaServer fails if boundary is missing or invalid', (t) => {
  assert.throws(
    () => createGitHubAppBetaServer(),
    (err) => err.code === 'GITHUB_APP_BETA_STARTUP_INVALID'
  );
  assert.throws(
    () => createGitHubAppBetaServer({ boundary: {} }),
    (err) => err.code === 'GITHUB_APP_BETA_STARTUP_INVALID'
  );
});

test('buildProductionBoundary fails if beta is disabled', (t) => {
  assert.throws(
    () => buildProductionBoundary({}),
    (err) => err.code === 'GITHUB_APP_BETA_STARTUP_INVALID'
  );
});

test('startGitHubAppBetaServer throws on invalid port', (t) => {
  const boundary = { path: '/test', handle: () => {} };
  assert.throws(
    () => startGitHubAppBetaServer({ boundary, environment: { HUQAN_GITHUB_APP_PORT: 'invalid' } }),
    (err) => err.code === 'GITHUB_APP_BETA_STARTUP_INVALID'
  );
  assert.throws(
    () => startGitHubAppBetaServer({ boundary, environment: { HUQAN_GITHUB_APP_PORT: '99999' } }),
    (err) => err.code === 'GITHUB_APP_BETA_STARTUP_INVALID'
  );
});

test('startGitHubAppBetaServer throws on invalid host', (t) => {
  const boundary = { path: '/test', handle: () => {} };
  assert.throws(
    () => startGitHubAppBetaServer({ boundary, environment: { HUQAN_GITHUB_APP_HOST: 'invalid host' } }),
    (err) => err.code === 'GITHUB_APP_BETA_STARTUP_INVALID'
  );
});

test('createGitHubAppBetaServer handles requests', async (t) => {
  const boundary = {
    path: '/webhook',
    handle: async () => ({ statusCode: 200, headers: {}, body: { ok: true } })
  };
  const server = startGitHubAppBetaServer({ boundary, port: 0 });
  t.after(() => closeServer(server));
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  
  // Test 404
  const res404 = await fetch(`http://127.0.0.1:${port}/wrong`);
  assert.equal(res404.status, 404);
  await res404.text();
  
  // Test 200
  const res200 = await fetch(`http://127.0.0.1:${port}/webhook`);
  assert.equal(res200.status, 200);
  await res200.text();
});

test('createGitHubAppBetaServer handles internal errors', async (t) => {
  const boundary = {
    path: '/webhook',
    handle: async () => { throw new Error('Internal'); }
  };
  const server = startGitHubAppBetaServer({ boundary, port: 0 });
  t.after(() => closeServer(server));
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  
  const res500 = await fetch(`http://127.0.0.1:${port}/webhook`);
  assert.equal(res500.status, 500);
  await res500.text();
});
