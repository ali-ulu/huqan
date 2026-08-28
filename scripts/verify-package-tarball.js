#!/usr/bin/env node
'use strict';

/**
 * Pack the package, install it into an empty project, and check that it works.
 *
 * This is the one pre-publish check that cannot be done by reading the source
 * tree. `npm test` and scripts/check-package-closure.js both run against a
 * clone, where every relative path resolves whether or not package.json#files
 * ships it. v0.10.0 shipped three modules that way -- present in the repo,
 * absent from the tarball, `Cannot find module` from inside node_modules.
 *
 * The failure mode this is built around is quiet. A plugin or adapter that
 * fails to load prints a line and the run still exits 0, so a check that only
 * looked at exit codes would have passed the broken tarball. Every assertion
 * here reads the output.
 *
 * Both supported install shapes are covered. `--omit=optional` is a documented
 * install (pdfjs-dist and pdfkit are optional), so it has to keep working: the
 * two PDF paths may go unavailable, nothing else may.
 *
 * Usage:  node scripts/verify-package-tarball.js
 * Exit 0 = the published tarball behaves, exit 1 = it does not.
 */

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
// npm and package bins are .cmd files on Windows.  PowerShell resolves their
// extension interactively, but child_process does not add it for us.
const NPM_COMMAND = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function packageBin(binDir, name) {
  return path.join(binDir, process.platform === 'win32' ? `${name}.cmd` : name);
}

/** Output that means a module did not load, whatever the exit code said. */
const LOAD_FAILURE_PATTERNS = [
  /Plugin failed to load/i,
  /Cannot find module/i,
  /MODULE_NOT_FOUND/,
];

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
}

function ok(message) {
  console.log(`  ok: ${message}`);
}

function run(command, args, options = {}) {
  const isWindowsCmd = process.platform === 'win32' && command.toLowerCase().endsWith('.cmd');
  const result = cp.spawnSync(isWindowsCmd ? process.env.ComSpec : command, isWindowsCmd
    ? ['/d', '/s', '/c', command, ...args]
    : args, {
    encoding: 'utf8',
    timeout: options.timeoutMs || 10 * 60 * 1000,
    ...options,
  });
  return {
    status: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    output: `${result.stdout || ''}${result.stderr || ''}`,
  };
}

/**
 * @param {string} label human name for this install shape
 * @param {string} tarball absolute path to the packed tarball
 * @param {string[]} installFlags extra flags for `npm install`
 */
function verifyInstall(label, tarball, installFlags) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);

  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-tarball-'));
  // A home of its own: quickstart writes under HOME, and a verification run
  // must not touch the operator's real memory.
  const home = path.join(consumer, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  try {
    const init = run(NPM_COMMAND, ['init', '-y'], { cwd: consumer });
    if (init.status !== 0) {
      fail(`${label}: could not initialise the consumer project`);
      return;
    }

    const install = run(NPM_COMMAND, ['install', tarball, '--no-audit', '--no-fund', ...installFlags], {
      cwd: consumer,
      env,
    });
    if (install.status !== 0) {
      fail(`${label}: npm install failed\n${install.output.slice(-2000)}`);
      return;
    }
    ok(`installs (${installFlags.join(' ') || 'default'})`);

    const binDir = path.join(consumer, 'node_modules', '.bin');
    for (const binName of Object.keys(pkg.bin || {})) {
      const binPath = packageBin(binDir, binName);
      if (fs.existsSync(binPath)) ok(`bin present: ${binName}`);
      else fail(`${label}: declared bin is missing from the install: ${binName}`);
    }

    const version = run(packageBin(binDir, 'huqan'), ['--version'], { cwd: consumer, env });
    if (version.stdout.trim() === pkg.version) ok(`huqan --version reports ${pkg.version}`);
    else fail(`${label}: huqan --version said "${version.stdout.trim()}", expected "${pkg.version}"`);

    const quickstart = run(packageBin(binDir, 'huqan'), ['quickstart'], { cwd: consumer, env });
    if (quickstart.status !== 0) {
      fail(`${label}: quickstart exited ${quickstart.status}\n${quickstart.output.slice(-2000)}`);
    } else {
      // The point of the whole script: read the output, not the exit code.
      const loadErrors = quickstart.output.split(/\r?\n/)
        .filter((line) => LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(line)));
      if (loadErrors.length > 0) {
        fail(`${label}: quickstart succeeded but ${loadErrors.length} module(s) failed to load:\n`
          + loadErrors.map((line) => `      ${line.trim()}`).join('\n'));
      } else {
        ok('quickstart runs with no module load failures');
      }

      if (/status\s+:\s*canonical/.test(quickstart.output)) ok('quickstart produces a canonical Trust Receipt');
      else fail(`${label}: quickstart did not produce a canonical Trust Receipt`);
    }

    verifyMcp(label, binDir, consumer, env);
    verifyA2aRuntime(label, consumer, env);
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
}

/**
 * The HTTP boundary loads the evaluator and replay store dynamically so the
 * static package-closure check cannot see this dependency chain. Load the
 * evaluator from the installed tarball to prove every A2A/V5 dependency was
 * actually published.
 */
function verifyA2aRuntime(label, cwd, env) {
  const probe = run(process.execPath, [
    '-e',
    "const a2a = require('huqan/lib/a2a/bounded-exchange'); if (typeof a2a.evaluateBoundedExchange !== 'function') process.exit(2);",
  ], { cwd, env });

  if (probe.status === 0) ok('installed A2A evaluator loads with its V5 dependency closure');
  else fail(`${label}: installed A2A evaluator cannot load\n${probe.output.slice(-2000)}`);
}

/**
 * The MCP executable is what every editor integration starts, so a tarball
 * that installs but cannot answer `initialize` is broken for its main use.
 */
function verifyMcp(label, binDir, cwd, env) {
  const mcpBin = packageBin(binDir, 'huqan-mcp');
  if (!fs.existsSync(mcpBin)) return;

  const requests = [
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify-package-tarball', version: '1' } } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
  ].map((request) => JSON.stringify(request)).join('\n');

  const mcp = run(mcpBin, [], { cwd, env, input: `${requests}\n`, timeoutMs: 60 * 1000 });

  let serverInfo = null;
  let toolCount = 0;
  for (const line of mcp.stdout.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const result = message && message.result;
    if (!result) continue;
    if (result.serverInfo) serverInfo = result.serverInfo;
    if (Array.isArray(result.tools)) toolCount = result.tools.length;
  }

  if (!serverInfo) {
    fail(`${label}: huqan-mcp did not answer initialize\n${mcp.output.slice(-1000)}`);
    return;
  }
  if (serverInfo.name !== 'huqan' || serverInfo.version !== pkg.version) {
    fail(`${label}: huqan-mcp identified as ${JSON.stringify(serverInfo)}, expected `
      + `{"name":"huqan","version":"${pkg.version}"}`);
  } else {
    ok(`huqan-mcp answers initialize as huqan ${pkg.version}`);
  }

  if (toolCount > 0) ok(`huqan-mcp lists ${toolCount} tools`);
  else fail(`${label}: huqan-mcp listed no tools`);
}

function main() {
  console.log(`Verifying the ${pkg.name}@${pkg.version} tarball as an installed consumer sees it.`);

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pack-'));
  try {
    const pack = run(NPM_COMMAND, ['pack', '--pack-destination', packDir], { cwd: repoRoot });
    if (pack.status !== 0) {
      fail(`npm pack failed\n${pack.output.slice(-2000)}`);
      return 1;
    }
    const tarballName = fs.readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (!tarballName) {
      fail('npm pack produced no tarball');
      return 1;
    }
    const tarball = path.join(packDir, tarballName);
    console.log(`  packed: ${tarballName} (${(fs.statSync(tarball).size / 1024).toFixed(0)} KB)`);

    verifyInstall('full install', tarball, []);
    // Documented in README.md and docs/npm-publish.md, so it is a contract.
    verifyInstall('install with --omit=optional', tarball, ['--omit=optional']);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length === 0) {
    console.log('OK: the packed tarball installs and runs in both supported shapes.');
    return 0;
  }
  console.error(`FAIL: ${failures.length} problem(s) with the packed tarball. `
    + 'Publishing this would ship them.');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = { LOAD_FAILURE_PATTERNS };
