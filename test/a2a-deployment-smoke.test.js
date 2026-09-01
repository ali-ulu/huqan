'use strict';

/**
 * Deployment smoke for the A2A surface.
 *
 * The route tests in test/a2a-*-route.test.js mount each boundary the way
 * server.js does and drive it over real HTTP. What none of them proves is the
 * operator's actual question: does booting `node server.js` with
 * A2A_AUTHORITY_FILE and A2A_REPLAY_DIR set produce a live surface, and does
 * leaving them unset produce a silent one?
 *
 * That question needs the real server process, because the answer depends on
 * server.js reading the environment and lib/a2a/routes.js composing four
 * boundaries -- neither of which a mounted-boundary test exercises. It is the
 * evidence docs/a2a-deployment.md points at.
 *
 * Exchanges come from the conformance harness's own generator, for the same
 * reason the route tests use it: a second generator would let this file pass
 * against an envelope the conformance suite would never produce.
 */

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-deploy-'));

after(() => {
  try {
    fs.rmSync(tempDir, { recursive: true, force: true });
  } catch (_) {
    // best-effort cleanup only
  }
});

// Booting the server in-process would leave its SQLite handles and listeners in
// this test runner, and server.js is required by many other suites. A child
// process keeps each boot isolated and lets the environment differ per case.
function bootAndProbe({ configured, firewallCase = 'allow' }) {
  const caseDir = fs.mkdtempSync(path.join(tempDir, 'case-'));
  const replayDirectory = path.join(caseDir, 'replay');
  fs.mkdirSync(replayDirectory);

  const script = `
    const fs = require('fs');
    const http = require('http');
    const path = require('path');
    const caseDir = process.argv[1];
    const configured = process.argv[2] === 'yes';
    const { buildFixture } = require(path.join(${JSON.stringify(repoRoot)}, 'scripts', 'a2a-conformance', 'run.js'));
    const { CANONICAL_WORKSPACE } = require(path.join(${JSON.stringify(repoRoot)}, 'lib', 'a2a', 'exchange-route.js'));
    // The route serves the canonical workspace only, so the fixture must be
    // built for it; the conformance suite's own default workspace is refused
    // here with a2a_workspace_not_canonical, which is correct.
    const firewallCase = process.argv[3] || 'allow';
    const fixture = buildFixture(CANONICAL_WORKSPACE, firewallCase === 'block'
      ? { target: 'force push', tool: 'axiom.trace' }
      : {});

    const authorityFile = path.join(caseDir, 'authority.json');
    fs.writeFileSync(authorityFile, JSON.stringify(fixture.authority), 'utf8');

    Object.assign(process.env, {
      HUQAN_DISABLE_AUTO_LISTEN: '1',
      HUQAN_API_KEY: 'test-key',
      HUQAN_MEMORY_PATH: path.join(caseDir, 'memory.json'),
      HUQAN_DB_PATH: path.join(caseDir, 'graph.sqlite'),
    });
    if (configured) {
      process.env.HUQAN_A2A_AUTHORITY_FILE = authorityFile;
      process.env.HUQAN_A2A_REPLAY_DIR = path.join(caseDir, 'replay');
    }

    const server = require(path.join(${JSON.stringify(repoRoot)}, 'server.js'));

    function request(method, urlPath, body) {
      return new Promise((resolve, reject) => {
        const raw = body === undefined ? null : JSON.stringify(body);
        const headers = { 'x-api-key': 'test-key' };
        if (raw !== null) {
          headers['content-type'] = 'application/json';
          headers['content-length'] = Buffer.byteLength(raw);
        }
        const req = http.request({
          hostname: '127.0.0.1', port: server.address().port, path: urlPath, method, headers,
        }, (res) => {
          let text = '';
          res.on('data', (chunk) => { text += chunk; });
          res.on('end', () => resolve({ status: res.statusCode, body: text }));
        });
        req.on('error', reject);
        req.end(raw === null ? undefined : raw);
      });
    }

    (async () => {
      let result;
      try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const card = await request('GET', '/.well-known/agent-card.json');
        const exchange = await request('POST', '/api/a2a/exchange', fixture.request);
        const replay = await request('POST', '/api/a2a/exchange', fixture.request);
        const exchangeBody = JSON.parse(exchange.body || '{}');
        result = {
          card: { status: card.status, agentId: (JSON.parse(card.body || '{}').agent || {}).agentId || null },
          exchange: {
            status: exchange.status,
            body: exchange.body.slice(0, 400),
            decision: exchangeBody.decision,
            reason: exchangeBody.reason,
            safeToRetry: exchangeBody.safeToRetry,
            receiptMetadata: exchangeBody.receiptMetadata,
            hasEffect: exchangeBody.effect !== undefined,
          },
          replay: { status: replay.status, body: replay.body.slice(0, 400) },
        };
      } finally {
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        try { server.closeHuqan(); } catch (_) {}
      }
      process.stdout.write('A2A_SMOKE ' + JSON.stringify(result) + '\\n');
    })().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
  `;

  const output = execFileSync(process.execPath, ['-e', script, caseDir, configured ? 'yes' : 'no', firewallCase], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const line = output.split('\n').find((l) => l.startsWith('A2A_SMOKE '));
  assert.ok(line, `no smoke result in output:\n${output}`);
  return JSON.parse(line.slice('A2A_SMOKE '.length));
}

test('an unconfigured server answers 404 on every A2A route', () => {
  // 404 rather than 401 is the point: an install with no authority file must
  // not advertise a surface it cannot serve, not even by refusing it
  // differently from a path that does not exist.
  const result = bootAndProbe({ configured: false });

  assert.equal(result.card.status, 404);
  assert.equal(result.exchange.status, 404);
});

test('a configured server serves the agent card and accepts one exchange', () => {
  const result = bootAndProbe({ configured: true });

  assert.equal(result.card.status, 200);
  // The card names the receiver the authority file declares as expectedTarget,
  // so a served card proves the authority was actually read, not just that a
  // route matched.
  assert.equal(result.card.agentId, 'agent-target');
  assert.equal(result.exchange.status, 200, `exchange body: ${result.exchange.body}`);
});

test('a configured server refuses the replayed exchange', () => {
  // The invariant the whole P0 phase was organised around: the replay key is
  // reserved before the effect runs, so a resend is refused rather than
  // reapplied. If this ever passes twice, an effect can be doubled.
  const result = bootAndProbe({ configured: true });

  assert.equal(result.exchange.status, 200, `exchange body: ${result.exchange.body}`);
  assert.notEqual(result.replay.status, 200);
  assert.match(result.replay.body, /replay/i);
});

test('a configured server blocks an AB5-refused exchange before applying it', () => {
  const result = bootAndProbe({ configured: true, firewallCase: 'block' });

  assert.equal(result.exchange.status, 403);
  assert.equal(result.exchange.decision, 'block');
  assert.equal(result.exchange.reason, 'FORCE_PUSH_BLOCKED');
  assert.equal(result.exchange.safeToRetry, true);
  assert.equal(result.exchange.receiptMetadata.decision, 'block');
  assert.equal(result.exchange.receiptMetadata.policy.policyVersion, 'v5-d6-1');
  assert.equal(result.exchange.receiptMetadata.task.tool, 'axiom.trace');
  assert.equal(result.exchange.hasEffect, false);
});
