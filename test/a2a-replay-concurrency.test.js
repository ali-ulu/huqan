'use strict';

/**
 * Per-exchange concurrency characterization (R26, #3481).
 *
 * The replay store already guarantees at-most-once with an exclusive-create
 * (`fs.openSync(target, 'wx')`, `lib/a2a/replay-store.js`); what was never
 * proven is that the guarantee holds under *concurrency* rather than under a
 * single sequential caller. These tests characterize that directly instead of
 * trusting the API shape:
 *
 * - N concurrent reservations of one replay key, in-process and across real
 *   child processes, must leave exactly one reservation and N-1 refusals;
 * - N concurrent reservations of N *different* keys must all succeed, so the
 *   exclusivity is per-key and not a global lock that would drop a legitimate
 *   distinct exchange;
 * - the exchange route under N parallel same-body requests must answer exactly
 *   one `allow` and N-1 `replay_detected`, with one durable reservation behind
 *   it;
 * - the reservation survives a store restart, so a retry after a crash is still
 *   refused rather than re-run.
 *
 * `replay_detected` is the evidence the issue asks for, so it is asserted on
 * the wire, not inferred.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.resolve(__dirname, '..');
const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { CANONICAL_WORKSPACE, createA2aExchangeBoundary } = require('../lib/a2a/exchange-route');
const { createA2aReplayStore } = require('../lib/a2a/replay-store');
const { createA2aTaskStore, taskIdForReplayKey } = require('../lib/a2a/task-store');

function makeSandbox(t, label) {
  // Under the real temp path: on macOS os.tmpdir() is below /var -> /private/var,
  // and the A2A stores deliberately refuse a path with a symlinked ancestor.
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `huqan-a2a-concurrency-${label}-`));
  if (t) t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  return { root, replayDirectory };
}

function reservedFiles(directory) {
  return fs.readdirSync(directory).filter((entry) => entry.endsWith('.reserved'));
}

function reservedTaskFiles(directory) {
  return fs.readdirSync(directory).filter((entry) => entry.endsWith('.reserved-task'));
}

test('#3481 in-process: N concurrent reservations of one key leave exactly one reservation', async t => {
  for (const parallel of [2, 8, 64]) {
    const { replayDirectory } = makeSandbox(t, `inproc-${parallel}`);
    const store = createA2aReplayStore(replayDirectory);
    const replayKey = 'a'.repeat(64);

    const results = await Promise.all(
      Array.from({ length: parallel }, () => Promise.resolve().then(() => store.reserve({ replayKey }))),
    );

    assert.equal(results.filter((result) => result.reserved === true).length, 1,
      `${parallel} concurrent reservations must admit exactly one`);
    assert.equal(results.filter((result) => result.reserved === false).length, parallel - 1,
      `${parallel} concurrent reservations must refuse the rest`);
    assert.deepEqual(reservedFiles(replayDirectory), [`${replayKey}.reserved`]);
    assert.deepEqual(reservedTaskFiles(replayDirectory), [`${taskIdForReplayKey(replayKey)}.reserved-task`]);
  }
});

test('#3481 cross-process: real child processes racing one key produce a single reservation', async t => {
  const { replayDirectory } = makeSandbox(t, 'xproc');
  const replayKey = 'b'.repeat(64);
  const parallel = 6;
  // Every child busy-waits to the same wall-clock instant, so the exclusive
  // creates genuinely overlap instead of being serialized by process startup.
  const startAt = Date.now() + 3000;
  const childScript = `
    const path = require('path');
    const { createA2aReplayStore } = require(path.join(${JSON.stringify(repoRoot)}, 'lib', 'a2a', 'replay-store.js'));
    const [directory, key, at] = process.argv.slice(1);
    while (Date.now() < Number(at)) {}
    const store = createA2aReplayStore(directory);
    process.stdout.write('RESULT:' + JSON.stringify(store.reserve({ replayKey: key })) + '\\n');
  `;

  const children = Array.from({ length: parallel }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['-e', childScript, replayDirectory, replayKey, String(startAt)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(`child exited ${code}: ${err}`));
      const line = out.split('\n').find((entry) => entry.startsWith('RESULT:'));
      if (!line) return reject(new Error(`child produced no result: ${out}`));
      resolve(JSON.parse(line.slice('RESULT:'.length)));
    });
  }));

  const results = await Promise.all(children);
  assert.equal(results.filter((result) => result.reserved === true).length, 1,
    'across processes, exactly one reservation must win');
  assert.equal(results.filter((result) => result.reserved === false).length, parallel - 1);
  assert.deepEqual(reservedFiles(replayDirectory), [`${replayKey}.reserved`]);
  assert.deepEqual(reservedTaskFiles(replayDirectory), [`${taskIdForReplayKey(replayKey)}.reserved-task`]);
});

test('#3481 exclusivity is per-key: N distinct keys reserved concurrently all succeed', async t => {
  const { replayDirectory } = makeSandbox(t, 'distinct');
  const store = createA2aReplayStore(replayDirectory);
  const keys = Array.from({ length: 32 }, (_, index) => index.toString(16).padStart(64, '0'));

  const results = await Promise.all(
    keys.map((replayKey) => Promise.resolve().then(() => store.reserve({ replayKey }))),
  );

  // A global lock would refuse legitimate distinct exchanges; the store must not
  // be one. Only same-key collisions are refused.
  assert.equal(results.every((result) => result.reserved === true), true);
  assert.equal(reservedFiles(replayDirectory).length, keys.length);
});

function request(port, body) {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/a2a/exchange', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function withExchangeBoundary(sandbox, run, parallelRequests) {
  const authorityFile = path.join(sandbox.root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(sandbox.fixture.authority), 'utf8');
  const exchange = createA2aExchangeBoundary({ authorityFile, replayDirectory: sandbox.replayDirectory });
  assert.ok(exchange);
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    exchange.route(req, res, reqUrl).then((handled) => {
      if (handled) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port, parallelRequests);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test('#3481 route: N parallel same-exchange requests yield one allow and N-1 replay_detected', async t => {
  const sandbox = makeSandbox(t, 'route');
  sandbox.fixture = buildFixture(CANONICAL_WORKSPACE);
  const parallel = 10;

  const responses = await withExchangeBoundary(sandbox, (port) =>
    Promise.all(Array.from({ length: parallel }, () => request(port, sandbox.fixture.request))), parallel);

  const allowed = responses.filter((response) => response.status === 200 && response.body.decision === 'allow');
  const refused = responses.filter((response) => response.status === 403);
  assert.equal(allowed.length, 1, 'exactly one parallel request may be admitted');
  assert.equal(refused.length, parallel - 1);
  for (const response of refused) {
    assert.equal(response.body.reason, 'replay_detected', 'the losers must be told the exchange was replayed');
  }

  // One reservation and one completion stand behind the single admitted exchange.
  assert.equal(reservedFiles(sandbox.replayDirectory).length, 1);
  assert.equal(fs.readdirSync(sandbox.replayDirectory).filter((e) => e.endsWith('.completed')).length, 1);

  // The task id the winner handed out resolves to its effect (task-store reuse).
  const taskId = allowed[0].body.effect.taskId;
  const task = createA2aTaskStore(sandbox.replayDirectory).readTask(taskId);
  assert.equal(task.state, 'completed');
  assert.equal(task.effect.exchangeId, sandbox.fixture.request.exchangeId);
});

test('#3481 restart: a reservation from the concurrent burst is durable, so a retry is refused', async t => {
  const sandbox = makeSandbox(t, 'restart');
  sandbox.fixture = buildFixture(CANONICAL_WORKSPACE);

  await withExchangeBoundary(sandbox, (port) => request(port, sandbox.fixture.request));

  // A fresh store over the same directory reads the reservation back.
  const restarted = createA2aReplayStore(sandbox.replayDirectory);
  const retryKey = fs.readdirSync(sandbox.replayDirectory)
    .find((entry) => entry.endsWith('.reserved'))
    .slice(0, -'.reserved'.length);
  assert.deepEqual(restarted.reserve({ replayKey: retryKey }), { reserved: false });

  // And the route, rebuilt over the same directory, refuses the retried body.
  const responses = await withExchangeBoundary(sandbox, (port) => request(port, sandbox.fixture.request));
  assert.equal(responses.status, 403);
  assert.equal(responses.body.reason, 'replay_detected');
});
