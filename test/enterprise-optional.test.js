'use strict';

// The core (Apache-2.0) must start and work with the LICENSE-ENTERPRISE files
// absent; each Enterprise feature then answers with a clear refusal instead of
// a crash. Every case runs in a child process with those paths made
// unresolvable by test/helpers/block-enterprise-modules.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const BLOCK = path.join(__dirname, 'helpers', 'block-enterprise-modules.js');

function runCore(args, { input, env = {} } = {}) {
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-core-only-'));
  return spawnSync(process.execPath, ['-r', BLOCK, ...args], {
    cwd: ROOT,
    input,
    encoding: 'utf8',
    env: { ...process.env, HUQAN_STATE_ROOT: stateRoot, NODE_ENV: '', ...env },
  });
}

test('every on-demand enterprise load is a declared entry point, and every entry point is used', () => {
  const { ENTERPRISE_ENTRY_POINTS, loadEnterpriseModule } = require('../lib/enterprise-module');
  const callers = ['lib/cli-evidence-commands.js', 'lib/http/viewer-mount.js', 'bin/huqan-gate-hook.js'];
  const loaded = callers.flatMap((file) => [...fs.readFileSync(path.join(ROOT, file), 'utf8')
    .matchAll(/loadEnterpriseModule\('\.\/([^']+)'\)/g)].map((match) => `lib/${match[1]}.js`));
  assert.deepEqual([...new Set(loaded)].sort(), [...ENTERPRISE_ENTRY_POINTS].sort());
  for (const entry of ENTERPRISE_ENTRY_POINTS) {
    const head = fs.readFileSync(path.join(ROOT, entry), 'utf8').split(/\r?\n/, 1)[0];
    assert.match(head, /LicenseRef-HUQAN-Enterprise/, `${entry} must be an Enterprise file`);
  }
  assert.throws(() => loadEnterpriseModule('./tool-call-gate'), /not an enterprise entry point/);
});

test('the preload really hides the enterprise files', () => {
  const run = runCore(['-e', "require('./lib/evidence-pack/collect')"]);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /MODULE_NOT_FOUND|Cannot find module/);
});

test('the core CLI starts without the enterprise files', () => {
  const run = runCore(['cli.js', '--version']);
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.trim(), require('../package.json').version);
});

test('the viewer mount claims no SSO path without the enterprise files', () => {
  const script = [
    "const { createViewerMount } = require('./lib/http/viewer-mount');",
    'const mount = createViewerMount({ readReceipt: () => null });',
    "console.log(JSON.stringify({ saml: mount.isViewerPath('/saml/acs'), oidc: mount.oidcMount.enabled }));",
    'mount.reset();',
  ].join('\n');
  const run = runCore(['-e', script]);
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), { saml: false, oidc: false });
});

test('a deployment that configures OIDC but lacks its files stays fail-closed', () => {
  const script = [
    "const { createViewerMount } = require('./lib/http/viewer-mount');",
    'const mount = createViewerMount({ readReceipt: () => null });',
    'const o = mount.oidcMount;',
    "console.log(JSON.stringify({ configured: o.configured, ok: o.ok, fallback: Boolean(o.apiKeyFallback), seam: typeof o.authorize }));",
    'mount.reset();',
  ].join('\n');
  // lib/environment-compat.js reads the OIDC_ISSUER suffix as HUQAN_OIDC_ISSUER.
  const run = runCore(['-e', script], { env: { HUQAN_OIDC_ISSUER: 'https://idp.example.test' } });
  assert.equal(run.status, 0, run.stderr);
  // configured + no fallback is what makes server.js refuse the API key.
  assert.deepEqual(JSON.parse(run.stdout.trim()), { configured: true, ok: false, fallback: false, seam: 'undefined' });
});

test('the core OIDC-configured check reads exactly the variables lib/oidc/config.js requires', () => {
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'http', 'viewer-mount.js'), 'utf8');
  const block = source.match(/const OIDC_CONFIG_ENV = Object\.freeze\(\[([\s\S]*?)\]\)/);
  assert.ok(block, 'viewer-mount.js must declare OIDC_CONFIG_ENV');
  const names = [...block[1].matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);
  assert.deepEqual(names.sort(), [...require('../lib/oidc/config').REQUIRED_ENV].sort());
});

test('the gate still decides without the enterprise files', () => {
  const payload = JSON.stringify({
    hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git status' }, cwd: ROOT, session_id: 's1',
  });
  const run = runCore(['bin/huqan-gate-hook.js', '--profile', 'claude-code', '--workspace-root', ROOT], {
    input: payload,
    env: { HUQAN_EXTERNAL_GUARD_REQUIRE_IDENTITY: '', HUQAN_EXTERNAL_GUARD_REQUIRE_SIGNED_IDENTITY: '' },
  });
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stdout, /"permissionDecision":"deny"/);
});

test('evidence commands refuse with ENTERPRISE_MODULE_MISSING', () => {
  const run = runCore(['cli.js', 'evidence', 'verify', path.join(os.tmpdir(), 'no-such-pack'), '--json']);
  assert.notEqual(run.status, 0);
  const envelope = JSON.parse(run.stdout.trim());
  assert.equal(envelope.error.code, 'ENTERPRISE_MODULE_MISSING');
  assert.match(envelope.error.message, /HUQAN Enterprise feature/);
});

test('siem-export refuses with a clear enterprise message', () => {
  const run = runCore(['bin/huqan-gate-hook.js', 'siem-export']);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /SIEM export is a HUQAN Enterprise feature/);
});
