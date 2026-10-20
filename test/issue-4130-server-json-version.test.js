'use strict';

/**
 * #4130 — the MCP Registry entry must not drift from the npm package.
 *
 * `server.json` is the registry-facing copy of facts that already live in
 * `package.json` (package name, version, node requirement). Nothing in the
 * release flow copies them automatically, so this test pins the equality:
 * a release that bumps one without the other now fails `npm test` instead of
 * publishing a registry entry that points at the wrong version.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));

const MCP_NAME = 'io.github.ali-ulu/huqan';
const SCHEMA_URL = 'https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json';

function npmPackage() {
  const npm = (server.packages || []).find((entry) => entry.registryType === 'npm');
  assert.ok(npm, 'server.json must list the npm package');
  return npm;
}

test('server.json name matches the package.json mcpName (#4130)', () => {
  assert.equal(pkg.mcpName, MCP_NAME);
  assert.equal(server.name, pkg.mcpName);
});

test('server.json name follows the registry reverse-DNS pattern (#4130)', () => {
  // The registry schema pins this pattern; asserting it here catches a bad
  // rename before a submission attempt does.
  assert.match(server.name, /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/);
  assert.equal(server.name.split('/').length, 2, 'exactly one slash: namespace/server');
});

test('server.json version is pinned to the package.json version (#4130)', () => {
  assert.equal(server.version, pkg.version);
  assert.equal(npmPackage().version, pkg.version);
  assert.equal(npmPackage().identifier, pkg.name);
});

test('server.json declares the schema version it validates against (#4130)', () => {
  assert.equal(server.$schema, SCHEMA_URL);
});

test('the npm package exposes the huqan-mcp binary over stdio (#4130)', () => {
  const npm = npmPackage();
  assert.equal(npm.transport.type, 'stdio');
  assert.ok(
    (npm.packageArguments || []).some((arg) => arg.type === 'positional' && arg.value === 'huqan-mcp'),
    'the huqan-mcp binary must be a package argument',
  );
  assert.ok(pkg.bin['huqan-mcp'], 'package.json must keep the huqan-mcp bin');
});

test('the operator token env var is declared optional and secret (#4130)', () => {
  const env = (npmPackage().environmentVariables || []).find(
    (entry) => entry.name === 'HUQAN_MCP_OPERATOR_TOKEN',
  );
  assert.ok(env, 'HUQAN_MCP_OPERATOR_TOKEN must be declared');
  assert.equal(env.isSecret, true);
  assert.equal(env.isRequired, false);
});

test('description stays within the registry 100-character limit (#4130)', () => {
  assert.ok(server.description.length >= 1);
  assert.ok(server.description.length <= 100);
});

test('the node requirement matches the package.json engines field (#4130)', () => {
  assert.ok(pkg.engines && pkg.engines.node, 'package.json must declare engines.node');
  const requirements = server._meta && server._meta['io.github.ali-ulu/requirements'];
  assert.ok(requirements, 'the requirements _meta block must exist');
  assert.equal(requirements.node, pkg.engines.node);
});
