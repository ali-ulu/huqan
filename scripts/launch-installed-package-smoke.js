#!/usr/bin/env node
'use strict';

/**
 * Product-launch smoke for the package exactly as an npm consumer installs it.
 *
 * This is intentionally not another unit suite. It packs the current tree,
 * installs that tarball into an empty project, and exercises the public user
 * surfaces that are easy to miss when tests run from a checkout:
 *
 *   - CLI learn -> review -> durable approval -> canonical write -> receipt
 *   - MCP learn -> review -> scoped operator approval -> canonical write -> receipt
 *   - REST learn -> review -> scoped operator approval -> canonical write -> receipt
 *   - authenticated, workspace-bound /viewer read of the owned REST receipt
 *   - semantic parity of the final approved receipt across CLI / REST / MCP
 *
 * The temporary HOME/USERPROFILE and persistence paths keep the smoke isolated
 * from the operator's real HUQAN state.
 */

const cp = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

function receiptSemantics(receipt) {
  return {
    receiptKind: receipt?.receiptKind || null,
    receiptType: receipt?.receiptType || null,
    decision: receipt?.decision || null,
    status: receipt?.status || null,
    workspaceId: receipt?.workspaceId || null,
    approvalStatus: receipt?.approvalStatus || null,
    canonical: receipt?.canonical === true,
    reviewed: receipt?.reviewed === true,
    quarantined: receipt?.quarantined === true,
    rejected: receipt?.rejected === true,
    trustPolicyVersion: receipt?.trustPolicyVersion || null,
  };
}

function validateApprovedReceipt(label, receipt, approvalId, refs = null) {
  if (!receipt || typeof receipt !== 'object' || typeof receipt.receiptId !== 'string' || !receipt.receiptId) {
    fail(`${label} did not return a real receiptId`);
    return null;
  }
  const semantics = receiptSemantics(receipt);
  const expected = semantics.receiptKind === 'memory_admission_receipt'
    && semantics.receiptType === 'memory-admission'
    && semantics.decision === 'allow'
    && semantics.status === 'admitted'
    && semantics.workspaceId === PARITY_WORKSPACE
    && semantics.approvalStatus === 'approved'
    && semantics.canonical === true
    && semantics.reviewed === false
    && semantics.quarantined === false
    && semantics.rejected === false
    && typeof semantics.trustPolicyVersion === 'string'
    && semantics.trustPolicyVersion.length > 0
    && receipt.approvalId === approvalId
    && typeof receipt.provenanceId === 'string'
    && receipt.provenanceId.length > 0;
  if (!expected) {
    fail(`${label} receipt does not represent the approved canonical admission: ${JSON.stringify(receipt).slice(-2500)}`);
    return null;
  }
  if (refs?.provenanceId && refs.provenanceId !== receipt.provenanceId) {
    fail(`${label} receipt provenanceId contradicts approval execution refs`);
    return null;
  }
  return semantics;
}

function cliVerifyIsVerified(envelope) {
  return /Verify:\s*verified\b/i.test(String(envelope?.data?.output || ''));
}

function mcpVerifyIsVerified(surface) {
  const status = String(surface?.data?.status || '').toLowerCase();
  return status === 'verified' || status === 'dogrulandi';
}

function verifyCliApprovedReceipt(binDir, consumer, baseEnv) {
  const cliPath = packageBin(binDir, 'huqan');
  const env = makeSurfaceEnv(baseEnv, consumer, 'cli-parity');

  const queuedRun = run(cliPath, ['learn:', PARITY_CLAIM, '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 60 * 1000,
  });
  if (queuedRun.status !== 5) {
    fail(`CLI learn-review exited ${queuedRun.status}, expected 5\n${queuedRun.output.slice(-2500)}`);
    return null;
  }
  const queued = firstJson(queuedRun, 'CLI learn-review');
  const approvalId = queued?.approval?.id;
  if (queued?.status !== 'review_required' || typeof approvalId !== 'string' || !approvalId) {
    fail(`CLI learn-review did not expose a durable review approval\n${JSON.stringify(queued).slice(-2500)}`);
    return null;
  }

  const beforeRun = run(cliPath, ['verify:', PARITY_CLAIM, '--json'], { cwd: consumer, env, timeoutMs: 60 * 1000 });
  const before = firstJson(beforeRun, 'CLI pre-approval verify');
  if (beforeRun.status !== 0 || cliVerifyIsVerified(before)) {
    fail(`CLI observed the claim as verified before approval\n${beforeRun.output.slice(-2000)}`);
    return null;
  }

  const approvedRun = run(cliPath, ['onayla', approvalId, 'approved', '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 60 * 1000,
  });
  if (approvedRun.status !== 0) {
    fail(`CLI approval exited ${approvedRun.status}\n${approvedRun.output.slice(-2500)}`);
    return null;
  }
  const decision = firstJson(approvedRun, 'CLI approval');
  const receipt = decision?.data?.receipt;
  const semantics = validateApprovedReceipt('CLI', receipt, approvalId, decision?.data?.refs);
  if (!semantics) return null;

  const afterRun = run(cliPath, ['verify:', PARITY_CLAIM, '--json'], { cwd: consumer, env, timeoutMs: 60 * 1000 });
  const after = firstJson(afterRun, 'CLI post-approval verify');
  if (afterRun.status !== 0 || !cliVerifyIsVerified(after)) {
    fail(`CLI approval did not make the claim verifiable\n${afterRun.output.slice(-2000)}`);
    return null;
  }

  const readRun = run(cliPath, ['receipt', receipt.receiptId, '--workspace', PARITY_WORKSPACE, '--json'], {
    cwd: consumer,
    env,
    timeoutMs: 60 * 1000,
  });
  const read = firstJson(readRun, 'CLI receipt read');
  if (readRun.status !== 0 || read?.data?.receipt?.receiptId !== receipt.receiptId
      || read?.data?.receipt?.approvalId !== approvalId) {
    fail(`CLI could not read back its original approved receipt\n${readRun.output.slice(-2500)}`);
    return null;
  }

  ok('CLI performs review -> durable approval -> canonical write -> verify -> original receipt');
  return { approvalId, receipt, semantics };
}

function verifyMcpApprovedReceipt(binDir, consumer, baseEnv) {
  const mcpPath = packageBin(binDir, 'huqan-mcp');
  const env = makeSurfaceEnv(baseEnv, consumer, 'mcp-parity');
  const proposalRequests = [
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-receipt-parity-smoke', version: '1' } },
    },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'huqan.learn',
        arguments: {
          text: PARITY_CLAIM,
          workspaceId: PARITY_WORKSPACE,
          provenance: { sourceType: 'manual', sourceRef: 'launch-smoke://mcp-parity' },
        },
      },
    },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'huqan.verify', arguments: { statement: PARITY_CLAIM, workspaceId: PARITY_WORKSPACE } },
    },
    { jsonrpc: '2.0', id: 4, method: 'shutdown', params: {} },
  ].map(value => JSON.stringify(value)).join('\n');

  const proposalRun = run(mcpPath, [], {
    cwd: consumer,
    env,
    input: `${proposalRequests}\n`,
    timeoutMs: 60 * 1000,
  });
  if (proposalRun.status !== 0) {
    fail(`MCP proposal process exited ${proposalRun.status}\n${proposalRun.output.slice(-2500)}`);
    return null;
  }
  const proposalMessages = parseJsonLines(proposalRun.stdout);
  const queued = proposalMessages.find(message => message?.id === 2)?.result?.structuredContent;
  const before = proposalMessages.find(message => message?.id === 3)?.result?.structuredContent;
  const approvalId = queued?.approval?.id;
  if (queued?.status !== 'review_required' || queued?.canonicalWrite !== false
      || queued?.approval?.persisted !== true || typeof approvalId !== 'string' || !approvalId) {
    fail(`MCP learn did not persist a non-executing review approval\n${JSON.stringify(queued || null).slice(-2500)}`);
    return null;
  }
  if (mcpVerifyIsVerified(before)) {
    fail(`MCP observed the claim as verified before approval\n${JSON.stringify(before).slice(-2000)}`);
    return null;
  }

  let mcpModule;
  try {
    mcpModule = require(installedMcpPath(consumer));
  } catch (error) {
    fail(`installed MCP module could not be loaded to mint a scoped operator capability: ${error.message}`);
    return null;
  }
  const approvalArgs = {
    approvalId,
    workspaceId: PARITY_WORKSPACE,
    decision: 'approved',
    reason: 'launch-smoke-parity',
  };
  let operatorCapability;
  try {
    operatorCapability = mcpModule.createMcpOperatorCapability({
      secret: SMOKE_OPERATOR_TOKEN,
      ...mcpModule.operatorCapabilityBinding('huqan.approve', approvalArgs),
    });
  } catch (error) {
    fail(`MCP operator capability could not be created: ${error.message}`);
    return null;
  }

  const approvalRequests = [
    {
      jsonrpc: '2.0', id: 10, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-receipt-parity-operator', version: '1' } },
    },
    {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'huqan.approve', operatorCapability, arguments: approvalArgs },
    },
    {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'huqan.verify', arguments: { statement: PARITY_CLAIM, workspaceId: PARITY_WORKSPACE } },
    },
    { jsonrpc: '2.0', id: 13, method: 'shutdown', params: {} },
  ].map(value => JSON.stringify(value)).join('\n');

  const approvalRun = run(mcpPath, [], {
    cwd: consumer,
    env,
    input: `${approvalRequests}\n`,
    timeoutMs: 60 * 1000,
  });
  if (approvalRun.status !== 0) {
    fail(`MCP approval process exited ${approvalRun.status}\n${approvalRun.output.slice(-3000)}`);
    return null;
  }
  const approvalMessages = parseJsonLines(approvalRun.stdout);
  const decision = approvalMessages.find(message => message?.id === 11)?.result?.structuredContent;
  const after = approvalMessages.find(message => message?.id === 12)?.result?.structuredContent;
  if (!decision || decision.ok !== true || decision?.data?.executed !== true) {
    fail(`MCP scoped operator approval did not execute\n${JSON.stringify(decision || null).slice(-2500)}`);
    return null;
  }
  const receipt = decision?.data?.receipt;
  const semantics = validateApprovedReceipt('MCP', receipt, approvalId, decision?.data?.refs);
  if (!semantics) return null;
  if (!mcpVerifyIsVerified(after)) {
    fail(`MCP approval did not make the claim verifiable\n${JSON.stringify(after || null).slice(-2000)}`);
    return null;
  }

  ok('MCP performs review -> scoped operator approval -> canonical write -> verify -> receipt');
  return { approvalId, receipt, semantics };
}

function verifyServerApprovedReceiptAndViewer(consumer, baseEnv) {
  const serverPath = installedServerPath(consumer);
  const mcpPath = installedMcpPath(consumer);
  if (!fs.existsSync(serverPath) || !fs.existsSync(mcpPath)) {
    fail('installed package does not contain server.js and mcpServer.js');
    return null;
  }

  const probe = String.raw`
(async () => {
  const server = require(${JSON.stringify(serverPath)});
  const mcp = require(${JSON.stringify(mcpPath)});
  const claim = ${JSON.stringify(PARITY_CLAIM)};
  const workspaceId = ${JSON.stringify(PARITY_WORKSPACE)};
  const apiKey = ${JSON.stringify(SMOKE_API_KEY)};
  const operatorSecret = ${JSON.stringify(SMOKE_OPERATOR_TOKEN)};
  let listening = null;
  try {
    listening = server.startServer(0, '127.0.0.1');
    if (!listening.listening) {
      await new Promise((resolve, reject) => {
        listening.once('listening', resolve);
        listening.once('error', reject);
      });
    }
    const address = listening.address();
    const base = 'http://127.0.0.1:' + address.port;
    const authHeaders = { 'content-type': 'application/json', authorization: 'Bearer ' + apiKey };

    const healthResponse = await fetch(base + '/health');
    const health = await healthResponse.json();
    if (healthResponse.status !== 200 || health?.ok !== true || health?.service !== 'huqan') {
      throw new Error('health contract failed: ' + healthResponse.status + ' ' + JSON.stringify(health));
    }

    const viewerShellResponse = await fetch(base + '/viewer');
    const viewerShell = await viewerShellResponse.text();
    if (viewerShellResponse.status !== 200 || !/text\/html/i.test(viewerShellResponse.headers.get('content-type') || '') || !viewerShell.includes('HUQAN')) {
      throw new Error('viewer shell contract failed: ' + viewerShellResponse.status);
    }

    const unauthorized = await fetch(base + '/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim, workspaceId }),
    });
    if (unauthorized.status !== 401) {
      throw new Error('protected verify did not require API auth: ' + unauthorized.status);
    }

    const reviewResponse = await fetch(base + '/api/v2/workflows/learn', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId,
        text: claim,
        sourceType: 'upload',
        sourceRef: 'launch-smoke://rest-parity',
      }),
    });
    const review = await reviewResponse.json();
    const approvalId = review?.data?.approvalId;
    if (reviewResponse.status !== 202
      || review?.status !== 'review_required'
      || Number(review?.data?.learned || 0) !== 0
      || review?.data?.approval?.persisted !== true
      || typeof approvalId !== 'string' || approvalId.length === 0) {
      throw new Error('HTTP learn-review contract failed: ' + reviewResponse.status + ' ' + JSON.stringify(review));
    }

    const preGraphResponse = await fetch(base + '/graph-data?workspaceId=' + encodeURIComponent(workspaceId), {
      headers: { authorization: 'Bearer ' + apiKey },
    });
    const preGraph = await preGraphResponse.json();
    if (preGraphResponse.status !== 200 || !Array.isArray(preGraph?.nodes) || preGraph.nodes.length !== 0) {
      throw new Error('reviewed HTTP learn mutated canonical graph before approval: ' + preGraphResponse.status + ' ' + JSON.stringify(preGraph));
    }

    const preVerifyResponse = await fetch(base + '/verify', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ claim, workspaceId }),
    });
    const preVerify = await preVerifyResponse.json();
    if (preVerifyResponse.status !== 200 || String(preVerify?.status || '').toLowerCase() === 'verified') {
      throw new Error('HTTP observed the claim as verified before approval: ' + preVerifyResponse.status + ' ' + JSON.stringify(preVerify));
    }

    const approvalArgs = { approvalId, workspaceId, decision: 'approved', reason: 'launch-smoke-parity' };
    const operatorCapability = mcp.createMcpOperatorCapability({
      secret: operatorSecret,
      ...mcp.operatorCapabilityBinding('huqan.approve', approvalArgs),
    });
    const decisionResponse = await fetch(base + '/api/v2/memory-approvals/' + encodeURIComponent(approvalId) + '/decision?workspaceId=' + encodeURIComponent(workspaceId), {
      method: 'POST',
      headers: {
        ...authHeaders,
        'x-huqan-operator-capability': operatorCapability,
      },
      body: JSON.stringify({ decision: 'approved', reason: 'launch-smoke-parity' }),
    });
    const decision = await decisionResponse.json();
    if (decisionResponse.status !== 200 || decision?.ok !== true || decision?.data?.executed !== true) {
      throw new Error('HTTP scoped approval failed: ' + decisionResponse.status + ' ' + JSON.stringify(decision));
    }
    const receipt = decision?.data?.receipt;
    if (!receipt?.receiptId) {
      throw new Error('HTTP approval returned no receipt: ' + JSON.stringify(decision));
    }

    const postVerifyResponse = await fetch(base + '/verify', {
      method: 'POST', headers: authHeaders, body: JSON.stringify({ claim, workspaceId }),
    });
    const postVerify = await postVerifyResponse.json();
    if (postVerifyResponse.status !== 200 || String(postVerify?.status || '').toLowerCase() !== 'verified') {
      throw new Error('HTTP approval did not make the claim verifiable: ' + postVerifyResponse.status + ' ' + JSON.stringify(postVerify));
    }

    const loginResponse = await fetch(base + '/viewer/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base },
      body: JSON.stringify({ apiKey, workspaceId }),
    });
    const login = await loginResponse.json();
    const setCookie = loginResponse.headers.get('set-cookie') || '';
    const cookie = setCookie.split(';', 1)[0];
    if (loginResponse.status !== 200 || login?.ok !== true || login?.workspaceId !== workspaceId || !cookie) {
      throw new Error('viewer login failed: ' + loginResponse.status + ' ' + JSON.stringify(login));
    }

    const viewerReceiptResponse = await fetch(base + '/viewer/api/trust-receipt/' + encodeURIComponent(receipt.receiptId) + '?workspaceId=' + encodeURIComponent(workspaceId), {
      headers: { cookie },
    });
    const viewerReceipt = await viewerReceiptResponse.json();
    if (viewerReceiptResponse.status !== 200 || viewerReceipt?.ok !== true
      || viewerReceipt?.receipt?.receiptId !== receipt.receiptId
      || viewerReceipt?.receipt?.approvalId !== approvalId) {
      throw new Error('authenticated viewer did not read the owned receipt: ' + viewerReceiptResponse.status + ' ' + JSON.stringify(viewerReceipt));
    }

    const crossWorkspaceResponse = await fetch(base + '/viewer/api/trust-receipt/' + encodeURIComponent(receipt.receiptId) + '?workspaceId=other-workspace', {
      headers: { cookie },
    });
    const crossWorkspace = await crossWorkspaceResponse.json();
    if (crossWorkspaceResponse.status !== 403 || crossWorkspace?.error?.code !== 'cross_workspace') {
      throw new Error('viewer session was not workspace-bound: ' + crossWorkspaceResponse.status + ' ' + JSON.stringify(crossWorkspace));
    }

    process.stdout.write(JSON.stringify({
      surface: 'rest',
      approvalId,
      receipt,
      refs: decision?.data?.refs || null,
      viewerReceipt: viewerReceipt.receipt,
      preApprovalVerified: false,
      postApprovalVerified: true,
    }) + '\n');
  } finally {
    if (listening?.listening) {
      await new Promise(resolve => listening.close(resolve));
    }
    try { server.closeHuqan?.(); } catch (_) {}
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
`;

  const env = {
    ...makeSurfaceEnv(baseEnv, consumer, 'rest-parity'),
    HUQAN_API_KEY: SMOKE_API_KEY,
    HUQAN_MCP_OPERATOR_TOKEN: SMOKE_OPERATOR_TOKEN,
    HUQAN_VIEWER_INSECURE_LOOPBACK: '1',
  };
  const result = run(process.execPath, ['-e', probe], {
    cwd: consumer,
    env,
    timeoutMs: 90 * 1000,
  });

  if (result.status !== 0) {
    fail(`installed server approved-receipt/viewer smoke failed\n${result.output.slice(-3500)}`);
    return null;
  }
  const payload = parseJsonLines(result.stdout).find(value => value?.surface === 'rest');
  if (!payload) {
    fail(`installed server smoke emitted no REST parity payload\n${result.output.slice(-2500)}`);
    return null;
  }
  const semantics = validateApprovedReceipt('REST', payload.receipt, payload.approvalId, payload.refs);
  if (!semantics) return null;
  if (payload.viewerReceipt?.receiptId !== payload.receipt.receiptId
      || payload.viewerReceipt?.approvalId !== payload.approvalId) {
    fail('authenticated /viewer returned a receipt that contradicts the approved REST receipt');
    return null;
  }

  ok('REST performs review -> scoped operator approval -> canonical write -> verify -> authenticated owned /viewer receipt');
  return { approvalId: payload.approvalId, receipt: payload.receipt, semantics };
}

function verifyCrossSurfaceReceiptParity(results) {
  const entries = Object.entries(results).filter(([, value]) => value && value.semantics);
  if (entries.length !== 3) {
    fail('cross-surface receipt parity could not run because one or more surface flows failed');
    return;
  }
  const [baselineName, baseline] = entries[0];
  const expected = JSON.stringify(baseline.semantics);
  for (const [name, value] of entries.slice(1)) {
    if (JSON.stringify(value.semantics) !== expected) {
      fail(`receipt semantic mismatch: ${baselineName}=${expected} vs ${name}=${JSON.stringify(value.semantics)}`);
      return;
    }
  }
  ok('CLI / REST / MCP agree on approved receipt decision, status, workspace, policy and canonicality');
}

function main() {
  console.log(`Launch smoke: packing and exercising ${pkg.name}@${pkg.version} as an installed consumer.`);

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-launch-pack-'));
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-launch-consumer-'));
  const home = path.join(consumer, 'home');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HUQAN_MEMORY_PATH: path.join(home, 'memory.json'),
    HUQAN_DB_PATH: path.join(home, 'memory.db'),
    HUQAN_MCP_CAPABILITY_NONCE_DIR: path.join(home, 'capability-nonces'),
  };

  try {
    const pack = run(NPM_COMMAND, ['pack', '--pack-destination', packDir], { cwd: repoRoot });
    if (pack.status !== 0) {
      fail(`npm pack failed\n${pack.output.slice(-2500)}`);
      return 1;
    }

    const tarballName = fs.readdirSync(packDir).find(name => name.endsWith('.tgz'));
    if (!tarballName) {
      fail('npm pack produced no tarball');
      return 1;
    }
    const tarball = path.join(packDir, tarballName);
    ok(`packed ${tarballName}`);

    const init = run(NPM_COMMAND, ['init', '-y'], { cwd: consumer, env });
    if (init.status !== 0) {
      fail(`npm init failed\n${init.output.slice(-1500)}`);
      return 1;
    }

    const install = run(NPM_COMMAND, ['install', tarball, '--no-audit', '--no-fund'], {
      cwd: consumer,
      env,
    });
    if (install.status !== 0) {
      fail(`npm install failed\n${install.output.slice(-2500)}`);
      return 1;
    }
    ok('clean consumer install succeeds');

    const binDir = path.join(consumer, 'node_modules', '.bin');
    const cli = verifyCliApprovedReceipt(binDir, consumer, env);
    const mcp = verifyMcpApprovedReceipt(binDir, consumer, env);
    const rest = verifyServerApprovedReceiptAndViewer(consumer, env);
    verifyCrossSurfaceReceiptParity({ cli, rest, mcp });
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
    fs.rmSync(packDir, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length === 0) {
    console.log('OK: installed-package launch smoke passed.');
    return 0;
  }
  console.error(`FAIL: ${failures.length} installed-package launch smoke check(s) failed.`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  SMOKE_API_KEY,
  SMOKE_CLAIM,
  SMOKE_WORKSPACE,
  PARITY_CLAIM,
  PARITY_WORKSPACE,
};
