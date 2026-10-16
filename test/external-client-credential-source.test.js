'use strict';

/**
 * The external client's bearer credential never travels on argv (#771).
 *
 * `admit --api-key <key>` put the secret in the process command line, where
 * other local users can read it out of /proc, and where it is copied into
 * shell history, CI command logs, job metadata and crash diagnostics -- all
 * before the request is even made. A credential that admits external trust
 * packages was being disclosed outside the protocol boundary as a matter of
 * normal use.
 *
 * The secret now arrives through HUQAN_API_KEY, a mode-checked file, or stdin.
 * argv may carry a *reference* to the credential, never the credential.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const CLIENT = path.join(__dirname, '..', 'scripts', 'external-client.js');
const SECRET = 'super-secret-bearer-value';

function run(args, { env = {}, stdin } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...args], {
      stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, ...env },
    });
    if (stdin !== undefined) child.stdin.end(stdin);
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status) => resolve({ status, stdout, stderr }));
  });
}

let dir;
let input;
let output;

function setup(name) {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-client-cred-'));
  input = path.join(dir, 'request.json');
  output = path.join(dir, `${name}-response.json`);
  fs.writeFileSync(input, JSON.stringify({ package: {}, signature: {} }));
  return { dir, input, output };
}

/**
 * A URL that is syntactically valid and refuses every connection, so the run
 * gets past credential resolution and stops at the network. Reaching that
 * point is the proof the credential was accepted; the request itself is the
 * standalone test's job, not this one's.
 */
const DEAD_URL = 'http://127.0.0.1:1/api/external-client/packages/admit';

function admitArgs(extra = []) {
  return ['admit', '--url', DEAD_URL, '--input', input, '--output', output, ...extra];
}

test('the removed --api-key flag is refused, and its value is not echoed', async () => {
  setup('argv');
  const result = await run(admitArgs(['--api-key', SECRET]), { env: {} });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /--api-key is not supported/);
  assert.match(result.stderr, /HUQAN_API_KEY|--api-key-file/);
  assert.doesNotMatch(result.stderr + result.stdout, new RegExp(SECRET));
});

test('with no credential source at all, it says so instead of sending nothing', async () => {
  setup('none');
  const result = await run(admitArgs(), { env: {} });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no credential/);
  assert.match(result.stderr, /HUQAN_API_KEY/);
  assert.equal(fs.existsSync(output), false);
});

test('two credential sources are rejected rather than silently ranked', async () => {
  const { dir: base } = setup('ambiguous');
  const keyFile = path.join(base, 'key');
  fs.writeFileSync(keyFile, SECRET, { mode: 0o600 });

  const result = await run(admitArgs(['--api-key-file', keyFile]), { env: { HUQAN_API_KEY: SECRET } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /ambiguous credential/);
  assert.doesNotMatch(result.stderr, new RegExp(SECRET));
});

test('a group- or world-readable key file is refused', async () => {
  const { dir: base } = setup('mode');
  const keyFile = path.join(base, 'loose-key');
  fs.writeFileSync(keyFile, SECRET, { mode: 0o644 });

  const result = await run(admitArgs(['--api-key-file', keyFile]), { env: {} });

  assert.notEqual(result.status, 0);
  if (process.platform === 'win32') {
    assert.match(result.stderr, /credential file permissions cannot be verified on Windows/);
  } else {
    assert.match(result.stderr, /group- or world-readable/);
  }
  assert.doesNotMatch(result.stderr, new RegExp(SECRET));
});

test('an empty credential is refused rather than sent as an empty bearer', async () => {
  setup('empty');
  const result = await run(admitArgs(), { env: { HUQAN_API_KEY: '   ' } });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /no credential|credential is empty/);
});

// The three accepted sources each get far enough to attempt the request, which
// is only reachable once the credential resolved.
for (const [label, makeCall] of [
  ['the environment', () => ({ args: admitArgs(), options: { env: { HUQAN_API_KEY: SECRET } } })],
  ['a mode-600 file', () => {
    const keyFile = path.join(dir, 'good-key');
    fs.writeFileSync(keyFile, `${SECRET}\n`, { mode: 0o600 });
    return { args: admitArgs(['--api-key-file', keyFile]), options: { env: {} } };
  }],
  ['stdin', () => ({ args: admitArgs(['--api-key-file', '-']), options: { env: {}, stdin: `${SECRET}\n` } })],
]) {
  test(`a credential from ${label} is accepted`, async (t) => {
    if (label === 'a mode-600 file' && process.platform === 'win32') {
      return t.skip('Windows file ACLs are not verified by this CLI; use environment or stdin');
    }
    setup(label.replace(/\s+/g, '-'));
    const { args, options } = makeCall();
    const result = await run(args, options);

    // The connection is refused, which is the point: resolution succeeded and
    // the client moved on to the network.
    assert.notEqual(result.status, 0);
    assert.doesNotMatch(result.stderr, /credential|api-key|usage/i);
    assert.doesNotMatch(result.stderr, new RegExp(SECRET));
    assert.equal(fs.existsSync(output), false);
  });
}

test('usage text documents no way to put the secret on the command line', async () => {
  setup('usage');
  const result = await run(['admit', '--url', DEAD_URL], { env: {} });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /^usage: admit/m);
  assert.doesNotMatch(result.stderr, /--api-key </);
  assert.match(result.stderr, /--api-key-file <path\|->/);
});
