'use strict';

/**
 * #1677: the PR Guardian workflow must not send its payload over cleartext.
 *
 * The destination comes from the `PR_GUARDIAN_WEBHOOK_URL` repository
 * variable, and the request carries pull-request metadata plus the
 * `x-hub-signature-256` HMAC. A cleartext remote destination exposes both.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const {
  checkWebhookUrl,
  isLoopbackHost,
  runningOnActions,
} = require('../scripts/check-pr-guardian-webhook-url');

const CHECKER = path.join(__dirname, '..', 'scripts', 'check-pr-guardian-webhook-url.js');
const WORKFLOW = path.join(__dirname, '..', '.github', 'workflows', 'pr-guardian-webhook.yml');

test('an HTTPS destination is accepted, on a runner and off it', () => {
  for (const onActions of [true, false]) {
    for (const url of [
      'https://huqan.example.com',
      'https://huqan.example.com/guardian',
      'https://huqan.example.com:8443/guardian',
      'https://192.0.2.10:8443',
    ]) {
      assert.equal(checkWebhookUrl(url, { onActions }).ok, true, `${url} (onActions=${onActions})`);
    }
  }
});

test('a cleartext remote destination is refused', () => {
  for (const url of [
    'http://huqan.example.com',
    'http://192.0.2.10:8080/guardian',
    'http://10.0.0.5',
    // Hosts that merely look loopback-adjacent.
    'http://127.0.0.1.attacker.example',
    'http://localhost.attacker.example',
    'http://128.0.0.1',
  ]) {
    const result = checkWebhookUrl(url, { onActions: false });
    assert.equal(result.ok, false, url);
    assert.match(result.reason, /cleartext HTTP/);
  }
});

test('loopback HTTP is a local-development mode only, never on a runner', () => {
  for (const url of ['http://127.0.0.1:3000', 'http://localhost:3000', 'http://[::1]:3000']) {
    assert.equal(checkWebhookUrl(url, { onActions: false }).ok, true, `${url} off a runner`);

    const onRunner = checkWebhookUrl(url, { onActions: true });
    assert.equal(onRunner.ok, false, `${url} on a runner`);
    assert.match(onRunner.reason, /local development only/);
  }
});

test('credentials, fragments, queries and malformed origins are refused', () => {
  const cases = [
    ['https://user:pass@huqan.example.com', /credentials/],
    ['https://user@huqan.example.com', /credentials/],
    ['https://huqan.example.com/guardian#section', /fragment/],
    ['https://huqan.example.com/guardian?token=abc', /query string/],
    ['//huqan.example.com', /not an absolute URL/],
    ['huqan.example.com', /not an absolute URL/],
    ['ftp://huqan.example.com', /unsupported scheme/],
    ['file:///etc/passwd', /unsupported scheme/],
    ['javascript:fetch(1)', /unsupported scheme/],
    ['https://huqan.example.com\tevil', /whitespace or control characters/],
    ['https://huqan.example.com\nevil', /whitespace or control characters/],
    [' https://huqan.example.com', /whitespace/],
    ['https://huqan.example.com ', /whitespace/],
    ['', /empty/],
    ['   ', /empty/],
  ];

  for (const [url, pattern] of cases) {
    const result = checkWebhookUrl(url, { onActions: true });
    assert.equal(result.ok, false, `${JSON.stringify(url)} should be refused`);
    assert.match(result.reason, pattern, JSON.stringify(url));
  }

  assert.equal(checkWebhookUrl(undefined).ok, false);
  assert.equal(checkWebhookUrl(null).ok, false);
  assert.equal(checkWebhookUrl(42).ok, false);
});

test('loopback detection covers 127.0.0.0/8 and the IPv6 forms', () => {
  for (const host of ['127.0.0.1', '127.255.255.254', 'localhost', 'LOCALHOST', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, host);
  }
  for (const host of ['126.0.0.1', '128.0.0.1', '127.0.0.256', 'example.com', '::2', '', undefined]) {
    assert.equal(isLoopbackHost(host), false, String(host));
  }
});

test('runningOnActions reads GITHUB_ACTIONS', () => {
  assert.equal(runningOnActions({ GITHUB_ACTIONS: 'true' }), true);
  assert.equal(runningOnActions({ GITHUB_ACTIONS: 'TRUE' }), true);
  assert.equal(runningOnActions({ GITHUB_ACTIONS: 'false' }), false);
  assert.equal(runningOnActions({}), false);
});

function runCli(url, extraEnv = {}) {
  return spawnSync(process.execPath, [CHECKER], {
    encoding: 'utf8',
    env: { ...process.env, GITHUB_ACTIONS: 'true', PR_GUARDIAN_WEBHOOK_URL: url, ...extraEnv },
  });
}

test('the CLI fails closed with an Actions error annotation', () => {
  const refused = runCli('http://huqan.example.com');
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^::error::PR Guardian webhook destination rejected: /m);
  assert.match(refused.stderr, /cleartext HTTP/);
});

test('the CLI accepts HTTPS and echoes only the origin', () => {
  const accepted = runCli('https://huqan.example.com/deploy/guardian');
  assert.equal(accepted.status, 0, accepted.stderr);
  assert.match(accepted.stdout, /accepted: https:\/\/huqan\.example\.com$/m);
  assert.doesNotMatch(accepted.stdout, /deploy\/guardian/);
});

test('the workflow runs the check before it builds or sends the payload', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  const checkIndex = workflow.indexOf('node scripts/check-pr-guardian-webhook-url.js');
  const buildIndex = workflow.indexOf('- name: Build signed GitHub pull_request payload');
  const sendIndex = workflow.indexOf('- name: Send signed payload to HUQAN');

  assert.ok(checkIndex > -1, 'the workflow must run the destination check');
  assert.ok(checkIndex < buildIndex, 'the check must precede the payload build');
  assert.ok(buildIndex < sendIndex);
});

test('the fail-closed signature and response handling are untouched', () => {
  const workflow = fs.readFileSync(WORKFLOW, 'utf8');
  assert.match(workflow, /openssl dgst -sha256 -hmac/);
  assert.match(workflow, /x-hub-signature-256/);
  assert.match(workflow, /HUQAN PR Guardian webhook returned HTTP/);
  assert.match(workflow, /did not contain a recognized decision/);
});
