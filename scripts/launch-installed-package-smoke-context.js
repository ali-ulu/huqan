'use strict';

const { spawnSyncWindowsAware } = require('./spawn-windows-aware');
const { validateApprovedReceipt, cliVerifyIsVerified, mcpVerifyIsVerified } = require('./launch-smoke-receipts');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const SMOKE_WORKSPACE = 'launch-smoke';
const SMOKE_API_KEY = 'launch-smoke-local-key';
const SMOKE_CLAIM = 'launch-smoke-subject CAUSES launch-smoke-object';
const PARITY_WORKSPACE = 'default';
const PARITY_CLAIM = 'launch-parity-subject CAUSES launch-parity-object';
const SMOKE_OPERATOR_TOKEN = 'launch-smoke-operator-token-9f4f7bd6a2f3';

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
}

function ok(message) {
  console.log(`  ok: ${message}`);
}

function run(command, args, options = {}) {
  const result = spawnSyncWindowsAware(command, args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    ...options,
  });
  return {
    status: result.status,
    signal: result.signal,
    error: result.error || null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

function packageBin(binDir, name) {
  return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

function installedServerPath(consumer) {
  return path.join(consumer, 'node_modules', pkg.name, 'server.js');
}

function installedMcpPath(consumer) {
  return path.join(consumer, 'node_modules', pkg.name, 'mcpServer.js');
}

function parseJsonLines(stdout) {
  const messages = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch (_) {}
  }
  return messages;
}

function firstJson(result, label) {
  const value = parseJsonLines(result.stdout)[0] || null;
  if (!value) fail(`${label} emitted no JSON payload\n${result.output.slice(-2000)}`);
  return value;
}

function makeSurfaceEnv(baseEnv, consumer, name) {
  const home = path.join(consumer, `surface-${name}`);
  fs.mkdirSync(home, { recursive: true });
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    HUQAN_MEMORY_PATH: path.join(home, 'memory.json'),
    HUQAN_DB_PATH: path.join(home, 'memory.db'),
    HUQAN_MCP_CAPABILITY_NONCE_DIR: path.join(home, 'capability-nonces'),
    HUQAN_MCP_OPERATOR_TOKEN: SMOKE_OPERATOR_TOKEN,
    HUQAN_VIEWER_INSECURE_LOOPBACK: '1',
  };
}

module.exports = { repoRoot, pkg, NPM_COMMAND, SMOKE_WORKSPACE, SMOKE_API_KEY, SMOKE_CLAIM, PARITY_WORKSPACE, PARITY_CLAIM, SMOKE_OPERATOR_TOKEN, failures, fail, ok, run, packageBin, installedServerPath, installedMcpPath, parseJsonLines, firstJson, makeSurfaceEnv };
