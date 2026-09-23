'use strict';

// #2230: installed-package verifiers (part 2) extracted from
// scripts/verify-package-tarball.js. One job: guard, MCP and A2A probes of an
// already-installed consumer. No pack/install orchestration.

const fs = require('node:fs');
const path = require('node:path');
const {
  fail,
  ok,
  packageBin,
  pkg,
  run,
} = require('./verify-tarball-shared');

/**
 * H-10 (#1983): the decision-explainer plugin shipped in the repo but not in
 * the tarball, so the installed package silently lost the `explain`
 * capability. `quickstart` still exited 0 -- a missing plugin only prints a
 * line -- so only an explicit assertion locks the installed-package claim:
 * both files are present under node_modules/huqan/plugins AND a clean
 * consumer can run the capability end to end.
 */
function verifyDecisionExplainer(label, consumer, env) {
  const installedDir = path.join(consumer, 'node_modules', 'huqan', 'plugins');
  const missing = ['decision-explainer.js', 'decision-explainer.manifest.json']
    .filter((name) => !fs.existsSync(path.join(installedDir, name)));
  if (missing.length > 0) {
    fail(`${label}: installed package is missing: ${missing.map((name) => `plugins/${name}`).join(', ')}`);
    return;
  }
  ok('decision-explainer plugin files are present in the install');

  const probeSource = 'const Kernel = require(\'huqan/kernel\');'
    + '(async () => {'
    + ' const k = new Kernel({ noLoad: true });'
    + ' k.enableCapability(\'pluginCapabilities\');'
    + ' const cap = k.getCapability(\'explain\');'
    + ' if (!cap) { console.error(\'MISSING explain capability\'); process.exit(2); }'
    + ' const result = await k.runCapability(\'explain\','
    + ' { decision: { decision: \'allow\', reason: \'read_only_allow\' } });'
    + ' if (!result || result.ok !== true'
    + ' || typeof result.data?.explanation !== \'string\''
    + ' || !result.data.explanation.includes(\'Salt-okunur\')) process.exit(3);'
    + ' console.log(\'explain ok: \' + result.data.explanation);'
    + '})().catch((e) => { console.error((e && e.message) || e); process.exit(1); });';
  const probe = run(process.execPath, ['-e', probeSource], { cwd: consumer, env });

  if (probe.status === 0) ok('installed consumer runs runCapability(\'explain\')');
  else fail(`${label}: installed runCapability('explain') failed\n${probe.output.slice(-1000)}`);
}

function verifyExternalGuard(label, binDir, cwd, env) {
  const guardBin = packageBin(binDir, 'huqan-gate');
  if (!fs.existsSync(guardBin)) return;
  const receiptLog = path.join(cwd, 'guard-receipts.jsonl');
  const payload = JSON.stringify({
    invocationId: 'installed-guard-probe',
    agentName: 'future-agent',
    sessionId: 'installed-session',
    toolName: 'shell',
    args: { command: 'rm -rf /' },
    cwd,
    workspaceRoot: cwd,
  });
  const guard = run(guardBin, [
    '--profile', 'generic',
    '--workspace-root', cwd,
    '--receipt-log', receiptLog,
    '--memory-path', path.join(cwd, 'guard-memory.json'),
    '--db-path', path.join(cwd, 'guard-memory.db'),
  ], { cwd, env, input: payload, timeoutMs: 60 * 1000 });
  let output = null;
  try { output = JSON.parse(guard.stdout); } catch (_) {}
  if (guard.status === 2 && output?.decision === 'block' && fs.existsSync(receiptLog)) {
    ok('installed huqan-gate blocks a denylisted command and persists a receipt');
  } else {
    fail(`${label}: installed huqan-gate did not fail closed\n${guard.output.slice(-1000)}`);
  }

  const installRoot = path.join(cwd, 'gate-install-probe');
  fs.mkdirSync(installRoot, { recursive: true });
  const install = run(guardBin, ['install', '--profile', 'codex', '--target-root', installRoot], { cwd, env });
  const status = run(guardBin, ['status', '--profile', 'codex', '--target-root', installRoot], { cwd, env });
  const uninstall = run(guardBin, ['uninstall', '--profile', 'codex', '--target-root', installRoot], { cwd, env });
  let installOutput = null;
  let statusOutput = null;
  let uninstallOutput = null;
  try { installOutput = JSON.parse(install.stdout); } catch (_) {}
  try { statusOutput = JSON.parse(status.stdout); } catch (_) {}
  try { uninstallOutput = JSON.parse(uninstall.stdout); } catch (_) {}
  if (install.status === 0 && installOutput?.sentinel?.decision === 'block'
      && status.status === 0 && statusOutput?.clients?.[0]?.installed === true
      && uninstall.status === 0 && uninstallOutput?.removed === true) {
    ok('installed huqan-gate can install, self-validate, report, and uninstall the Codex profile');
  } else {
    fail(`${label}: installed huqan-gate management lifecycle failed\n`
      + `${[install.output, status.output, uninstall.output].join('\n').slice(-2000)}`);
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
    'const a2a = require(\'huqan/lib/a2a/bounded-exchange\');'
    + ' if (typeof a2a.evaluateBoundedExchange !== \'function\') process.exit(2);',
  ], { cwd, env });

  if (probe.status === 0) ok('installed A2A evaluator loads with its V5 dependency closure');
  else fail(`${label}: installed A2A evaluator cannot load\n${probe.output.slice(-2000)}`);
}

/**
 * The MCP executable is what every editor integration starts, so a tarball
 * that installs but cannot answer `initialize` is broken for its main use.
 */
function verifyMcp(label, binDir, cwd, env, expectedVersion = pkg.version) {
  const mcpBin = packageBin(binDir, 'huqan-mcp');
  if (!fs.existsSync(mcpBin)) return;

  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'verify-package-tarball', version: '1' },
      },
    },
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
  if (serverInfo.name !== 'huqan' || serverInfo.version !== expectedVersion) {
    fail(`${label}: huqan-mcp identified as ${JSON.stringify(serverInfo)}, expected `
      + `{"name":"huqan","version":"${expectedVersion}"}`);
  } else {
    ok(`huqan-mcp answers initialize as huqan ${expectedVersion}`);
  }

  if (toolCount > 0) ok(`huqan-mcp lists ${toolCount} tools`);
  else fail(`${label}: huqan-mcp listed no tools`);
}

module.exports = {
  verifyA2aRuntime,
  verifyDecisionExplainer,
  verifyExternalGuard,
  verifyMcp,
};
