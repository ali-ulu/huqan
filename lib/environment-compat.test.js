'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const yaml = require('js-yaml');
const {
  ENVIRONMENT_SUFFIXES,
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./environment-compat');
const { prepareContainerEnvironment } = require('../scripts/container-server');

const EXPECTED_SUFFIXES = Object.freeze([
  'A2A_AUTHORITY_FILE',
  'A2A_REPLAY_DIR',
  'AGENT_RUNTIME', 'AGENT_VERSION', 'API_KEY', 'BACKUP_DIR',
  'CLI_READ_ROOTS', 'DB_PATH', 'DEMO_MODE', 'DISABLE_AUTO_LISTEN',
  'EXTERNAL_CLIENT_ENDPOINT_ENABLED', 'EXTERNAL_CLIENT_REPLAY_DB_PATH',
  'EXTERNAL_CLIENT_TRUST_PROFILE_PATH', 'GITHUB_APP_BETA_ENABLED',
  // #694: Streaming Trust now reaches a production entry point, so its own
  // opt-in flag and the App credentials it needs join the inventory.
  'GITHUB_APP_HOST', 'GITHUB_APP_ID', 'GITHUB_APP_PORT',
  'GITHUB_APP_PRIVATE_KEY_PATH', 'GITHUB_APP_STORE_PATH',
  'GITHUB_APP_STREAMING_TRUST_ENABLED',
  'GITHUB_APP_WEBHOOK_SECRET', 'HOST', 'HUMAN_APPROVAL_DISABLED',
  'INGEST_APPROVAL_LEASE_MS', 'KERNEL_VERSION', 'LANG',
  'MCP_LEGACY_VERIFY_STATUS', 'MCP_OPERATOR_TOKEN', 'MEMORY_PATH',
  'PARANOID', 'PLUGIN_PRODUCTION_ENFORCEMENT', 'PLUGIN_SIGNING_KEY',
  'PLUGIN_STRICT', 'PORT', 'RUST_BIN', 'TRUST_POLICY_ROOTS', 'TRUST_PROXY',
  'USE_SQLITE', 'VIEWER_INSECURE_LOOPBACK',
]);

test('environment compatibility inventory includes the external-client profile and replay paths', () => {
  assert.deepEqual(ENVIRONMENT_SUFFIXES, EXPECTED_SUFFIXES);
  assert.equal(Object.isFrozen(ENVIRONMENT_SUFFIXES), true);
});

for (const suffix of EXPECTED_SUFFIXES) {
  test(`environment compatibility matrix: ${suffix}`, () => {
    const canonical = `HUQAN_${suffix}`;
    const legacy = `AXIOM_${suffix}`;

    assert.equal(readCompatibleEnvironmentVariable(suffix, {}), undefined);
    assert.equal(readCompatibleEnvironmentVariable(suffix, { [canonical]: 'canonical' }), 'canonical');
    assert.equal(readCompatibleEnvironmentVariable(suffix, { [legacy]: 'legacy' }), 'legacy');
    assert.equal(readCompatibleEnvironmentVariable(suffix, {
      [canonical]: 'same',
      [legacy]: 'same',
    }), 'same');

    assert.throws(
      () => readCompatibleEnvironmentVariable(suffix, {
        [canonical]: 'canonical',
        [legacy]: 'legacy',
      }),
      (error) => error.code === 'HUQAN_ENV_CONFLICT'
        && error.message.includes(canonical)
        && error.message.includes(legacy),
    );
  });
}

test('environment compatibility treats empty strings as present raw values', () => {
  assert.equal(readCompatibleEnvironmentVariable('API_KEY', {
    HUQAN_API_KEY: '',
    AXIOM_API_KEY: '',
  }), '');
  assert.throws(
    () => readCompatibleEnvironmentVariable('API_KEY', {
      HUQAN_API_KEY: '',
      AXIOM_API_KEY: ' ',
    }),
    { code: 'HUQAN_ENV_CONFLICT' },
  );
});

test('environment compatibility rejects unknown suffixes and invalid environments', () => {
  assert.throws(
    () => readCompatibleEnvironmentVariable('NOT_IN_INVENTORY', {}),
    { code: 'HUQAN_ENV_SUFFIX_UNKNOWN' },
  );
  assert.throws(() => validateEnvironmentCompatibility(null), { code: 'HUQAN_ENV_INVALID' });
});

test('conflict errors never retain or print secret values', () => {
  for (const suffix of ['API_KEY', 'PLUGIN_SIGNING_KEY']) {
    const canonicalSecret = `canonical-secret-${suffix}`;
    const legacySecret = `legacy-secret-${suffix}`;
    let captured;
    try {
      readCompatibleEnvironmentVariable(suffix, {
        [`HUQAN_${suffix}`]: canonicalSecret,
        [`AXIOM_${suffix}`]: legacySecret,
      });
    } catch (error) {
      captured = error;
    }
    assert.ok(captured);
    const serialized = `${captured.message}\n${captured.stack}\n${JSON.stringify(captured)}`;
    assert.equal(serialized.includes(canonicalSecret), false);
    assert.equal(serialized.includes(legacySecret), false);
  }
});

test('container defaults do not shadow legacy-only configuration', () => {
  const environment = {
    AXIOM_API_KEY: 'legacy-api-key',
    AXIOM_HOST: '192.0.2.10',
    AXIOM_MEMORY_PATH: '/legacy/memory.json',
  };
  prepareContainerEnvironment(environment);
  assert.equal(environment.HUQAN_HOST, undefined);
  assert.equal(environment.HUQAN_MEMORY_PATH, undefined);
  assert.equal(readCompatibleEnvironmentVariable('HOST', environment), '192.0.2.10');
  assert.equal(environment.HUQAN_DB_PATH, '/app/data/memory.db');
});

test('container defaults accept canonical-only and equal dual API keys', () => {
  for (const environment of [
    { HUQAN_API_KEY: 'canonical' },
    { HUQAN_API_KEY: 'same', AXIOM_API_KEY: 'same' },
  ]) {
    prepareContainerEnvironment(environment);
    assert.equal(environment.HUQAN_HOST, '0.0.0.0');
  }
});

test('container preparation fails closed for missing and conflicting API keys', () => {
  assert.throws(() => prepareContainerEnvironment({}), { code: 'HUQAN_API_KEY_REQUIRED' });
  assert.throws(() => prepareContainerEnvironment({
    HUQAN_API_KEY: 'canonical-secret',
    AXIOM_API_KEY: 'legacy-secret',
  }), { code: 'HUQAN_ENV_CONFLICT' });
});

test('container manifests preserve absent variables and use the compatibility bootstrap', () => {
  const root = path.resolve(__dirname, '..');
  const composeSource = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
  const compose = yaml.load(composeSource);
  const service = compose.services.axiom;
  assert.deepEqual(service.ports, ['${HUQAN_PORT:-${AXIOM_PORT:-3000}}:3000']);
  assert.ok(service.environment.includes('HUQAN_API_KEY'));
  assert.ok(service.environment.includes('AXIOM_API_KEY'));
  assert.ok(service.environment.includes('HUQAN_PORT'));
  assert.ok(service.environment.includes('AXIOM_PORT'));

  const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
  assert.doesNotMatch(dockerfile, /^ENV (?:HUQAN|AXIOM)_/m);
  assert.match(dockerfile, /CMD \["node", "scripts\/container-server\.js"\]/);
});

test('runtime entrypoints reject conflicts before module startup', () => {
  const root = path.resolve(__dirname, '..');
  for (const entrypoint of [
    'cli.js',
    'server.js',
    'mcpServer.js',
    'scripts/backup.js',
    'scripts/restore.js',
    'scripts/egitim-demo.js',
    'scripts/seed-demo.js',
  ]) {
    const result = spawnSync(process.execPath, [entrypoint], {
      cwd: root,
      env: {
        ...process.env,
        HUQAN_LANG: 'canonical-secret-sentinel',
        AXIOM_LANG: 'legacy-secret-sentinel',
      },
      encoding: 'utf8',
      timeout: 10_000,
    });
    assert.notEqual(result.status, 0, entrypoint);
    const output = `${result.stdout}${result.stderr}`;
    assert.match(output, /HUQAN_ENV_CONFLICT/);
    assert.equal(output.includes('canonical-secret-sentinel'), false);
    assert.equal(output.includes('legacy-secret-sentinel'), false);
  }
});

test('runtime source contains no direct branded process.env reads outside resolver', () => {
  const root = path.resolve(__dirname, '..');
  const runtimeFiles = [
    'agentRuntime.js', 'cli.js', 'kernel.js', 'mcpServer.js', 'persistencePaths.js',
    'plugin.js', 'requestGuards.js', 'server.js', 'lib/kernel-factory.js',
    'lib/trust-policy.js', 'lib/viewer/viewer-gateway.js',
    'scripts/egitim-demo.js', 'scripts/seed-demo.js',
  ];
  for (const file of runtimeFiles) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /process\.env\.AXIOM_[A-Z0-9_]+/, file);
  }
});

test('active operator documentation uses only canonical HUQAN environment names', () => {
  const root = path.resolve(__dirname, '..');
  for (const file of [
    'README.md',
    'THREAT_MODEL.md',
    'docs/SECURITY-GATE.md',
    'docs/adr/ADR-010-production-external-client-boundary.md',
    'docs/task-packs/external-client-endpoint-0-contract.md',
  ]) {
    const source = fs.readFileSync(path.join(root, file), 'utf8');
    assert.doesNotMatch(source, /AXIOM_[A-Z0-9_]+/, file);
  }
});
