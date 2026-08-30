#!/usr/bin/env node
'use strict';

/**
 * Product-launch smoke for the package exactly as an npm consumer installs it.
 *
 * This is intentionally not another unit suite. It packs the current tree,
 * installs that tarball into an empty project, and exercises the public user
 * surfaces that are easy to miss when tests run from a checkout:
 *
 *   - interactive CLI mutation refusal
 *   - MCP mutation review surface
 *   - local HTTP server /health and /viewer
 *   - authenticated HTTP learn-review without a canonical write
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

function parseJsonLines(stdout) {
  const messages = [];
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { messages.push(JSON.parse(line)); } catch (_) {}
  }
  return messages;
}

function verifyCliReview(binDir, consumer, env) {
  const cli = run(packageBin(binDir, 'huqan'), [], {
    cwd: consumer,
    env,
    input: `learn: ${SMOKE_CLAIM}\n`,
    timeoutMs: 60 * 1000,
  });

  if (cli.status !== 0) {
    fail(`interactive huqan CLI exited ${cli.status}\n${cli.output.slice(-2000)}`);
    return;
  }

  const reviewHeadline = /requires review\. Nothing was mutated and nothing ran\./i.test(cli.output);
  const reviewDecision = /decision:\s*review/i.test(cli.output);
  if (reviewHeadline && reviewDecision) {
    ok('interactive CLI refuses a mutating learn without executing it');
  } else {
    fail(`interactive CLI did not expose the expected review refusal\n${cli.output.slice(-2000)}`);
  }
}

function verifyMcpReview(binDir, consumer, env) {
  const requests = [
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'launch-installed-package-smoke', version: '1' },
      },
    },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'huqan.learn',
        arguments: { text: SMOKE_CLAIM, workspaceId: SMOKE_WORKSPACE },
      },
    },
    { jsonrpc: '2.0', id: 3, method: 'shutdown', params: {} },
  ].map(value => JSON.stringify(value)).join('\n');

  const mcp = run(packageBin(binDir, 'huqan-mcp'), [], {
    cwd: consumer,
    env,
    input: `${requests}\n`,
    timeoutMs: 60 * 1000,
  });

  if (mcp.status !== 0) {
    fail(`huqan-mcp exited ${mcp.status}\n${mcp.output.slice(-2000)}`);
    return;
  }

  const response = parseJsonLines(mcp.stdout).find(message => message?.id === 2);
  const surface = response?.result?.structuredContent;
  const approvalId = surface?.approval?.approvalId;
  const safeReview = surface?.verdict === 'review'
    && surface?.status === 'review_required'
    && surface?.canonicalWrite === false
    && surface?.memoryAdmission?.status === 'review_required'
    && surface?.approval?.required === true
    && typeof approvalId === 'string'
    && approvalId.length > 0;

  if (safeReview) {
    ok('MCP learn returns persisted review_required state with canonicalWrite=false');
  } else {
    fail(`MCP learn did not expose a durable non-executing review surface\n${JSON.stringify(surface || response || null).slice(-2500)}`);
  }
}

function verifyServer(consumer, env) {
  const serverPath = installedServerPath(consumer);
  if (!fs.existsSync(serverPath)) {
    fail('installed package does not contain server.js');
    return;
  }

  const probe = String.raw`
(async () => {
  const server = require(${JSON.stringify(serverPath)});
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

    const healthResponse = await fetch(base + '/health');
    const health = await healthResponse.json();
    if (healthResponse.status !== 200 || health?.ok !== true || health?.service !== 'huqan') {
      throw new Error('health contract failed: ' + healthResponse.status + ' ' + JSON.stringify(health));
    }

    const viewerResponse = await fetch(base + '/viewer');
    const viewerBody = await viewerResponse.text();
    if (viewerResponse.status !== 200 || !/text\/html/i.test(viewerResponse.headers.get('content-type') || '') || !viewerBody.includes('HUQAN')) {
      throw new Error('viewer contract failed: ' + viewerResponse.status);
    }

    const unauthorized = await fetch(base + '/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ claim: ${JSON.stringify(SMOKE_CLAIM)}, workspaceId: ${JSON.stringify(SMOKE_WORKSPACE)} }),
    });
    if (unauthorized.status !== 401) {
      throw new Error('protected verify did not require API auth: ' + unauthorized.status);
    }

    const authHeaders = {
      'content-type': 'application/json',
      authorization: 'Bearer ' + ${JSON.stringify(SMOKE_API_KEY)},
    };
    const reviewResponse = await fetch(base + '/api/v2/workflows/learn', {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({
        workspaceId: ${JSON.stringify(SMOKE_WORKSPACE)},
        text: ${JSON.stringify(SMOKE_CLAIM)},
        sourceType: 'launch-smoke',
        sourceRef: 'launch-smoke://installed-package',
      }),
    });
    const review = await reviewResponse.json();
    const outcome = String(review?.data?.admission?.outcome || review?.data?.admission?.decision || '').toLowerCase();
    if (reviewResponse.status !== 202
      || review?.status !== 'review_required'
      || Number(review?.data?.learned || 0) !== 0
      || outcome !== 'review') {
      throw new Error('HTTP learn-review contract failed: ' + reviewResponse.status + ' ' + JSON.stringify(review));
    }

    const graphResponse = await fetch(base + '/graph-data?workspaceId=' + encodeURIComponent(${JSON.stringify(SMOKE_WORKSPACE)}), {
      headers: { authorization: 'Bearer ' + ${JSON.stringify(SMOKE_API_KEY)} },
    });
    const graph = await graphResponse.json();
    if (graphResponse.status !== 200
      || !Array.isArray(graph?.nodes)
      || !Array.isArray(graph?.links)
      || graph.nodes.length !== 0
      || graph.links.length !== 0) {
      throw new Error('reviewed HTTP learn mutated the graph: ' + graphResponse.status + ' ' + JSON.stringify(graph));
    }

    process.stdout.write(JSON.stringify({
      health: 'ok',
      viewer: 'ok',
      unauthorizedVerify: unauthorized.status,
      learnReview: review.status,
      canonicalGraphNodes: graph.nodes.length,
      canonicalGraphLinks: graph.links.length,
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

  const serverEnv = {
    ...env,
    HUQAN_API_KEY: SMOKE_API_KEY,
    HUQAN_MEMORY_PATH: path.join(env.HOME || env.USERPROFILE, 'server-memory.json'),
    HUQAN_DB_PATH: path.join(env.HOME || env.USERPROFILE, 'server-memory.db'),
  };
  const result = run(process.execPath, ['-e', probe], {
    cwd: consumer,
    env: serverEnv,
    timeoutMs: 90 * 1000,
  });

  if (result.status === 0) {
    ok('installed server serves /health and /viewer and keeps review-required learn non-canonical');
  } else {
    fail(`installed server smoke failed\n${result.output.slice(-3000)}`);
  }
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
    verifyCliReview(binDir, consumer, env);
    verifyMcpReview(binDir, consumer, env);
    verifyServer(consumer, env);
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

module.exports = { SMOKE_API_KEY, SMOKE_CLAIM, SMOKE_WORKSPACE };
