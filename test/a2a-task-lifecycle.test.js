'use strict';

/**
 * Contract for durable task records and GET /api/a2a/tasks/{taskId} (P0-E).
 *
 * The reason this unit is risky is that "idempotency" is usually implemented by
 * returning a stored success for a retried request, and doing that here would
 * quietly undo the property `effect_failure_keeps_replay_marker` pins: an
 * exchange whose outcome is unknown is never retried.
 *
 * So the assertions below are mostly about what did *not* change. A replay is
 * still refused; a failed effect still leaves the reservation standing; and the
 * task that results reads `unknown` forever rather than resolving later.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildFixture } = require('../scripts/a2a-conformance/run.js');
const { readJsonBody } = require('../requestGuards');
const { resolveRouteAuthPolicy } = require('../lib/http/route-auth-policy');
const { CANONICAL_WORKSPACE, createA2aExchangeBoundary } = require('../lib/a2a/exchange-route');
const { TASK_STATES, createA2aTaskStore, taskIdForReplayKey } = require('../lib/a2a/task-store');
const {
  A2A_TASK_PATH_PREFIX,
  TASK_ROUTE_ERRORS,
  createTaskReadBoundary,
} = require('../lib/a2a/task-route');

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2a-task-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const authorityFile = path.join(root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(fixture.authority), 'utf8');
  return { root, replayDirectory, authorityFile, fixture };
}

async function withBoundaries(sandbox, run) {
  const options = { authorityFile: sandbox.authorityFile, replayDirectory: sandbox.replayDirectory };
  const exchange = createA2aExchangeBoundary(options);
  const taskRead = createTaskReadBoundary(options);
  const server = http.createServer((req, res) => {
    const reqUrl = new URL(req.url, 'http://127.0.0.1');
    exchange.route(req, res, reqUrl).then((handled) => {
      if (handled) return;
      if (taskRead.route(req, res, reqUrl)) return;
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function request(port, { method = 'GET', requestPath, body } = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const headers = { 'Content-Type': 'application/json' };
    if (payload) headers['Content-Length'] = Buffer.byteLength(payload);
    const req = http.request({ host: '127.0.0.1', port, path: requestPath, method, headers }, (res) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = JSON.parse(text); } catch (_) { parsed = null; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

test('task lifecycle: an admitted exchange returns a task id that resolves to its effect', async () => {
  const sandbox = makeSandbox();

  const { admitted, task } = await withBoundaries(sandbox, async (port) => {
    const admittedResponse = await request(port, {
      method: 'POST', requestPath: '/api/a2a/exchange', body: sandbox.fixture.request,
    });
    const taskResponse = await request(port, {
      requestPath: `${A2A_TASK_PATH_PREFIX}${admittedResponse.body.effect.taskId}`,
    });
    return { admitted: admittedResponse, task: taskResponse };
  });

  assert.equal(admitted.status, 200);
  assert.equal(admitted.body.decision, 'allow');
  assert.ok(/^[0-9a-f]{64}$/.test(admitted.body.effect.taskId));

  assert.equal(task.status, 200);
  assert.equal(task.body.state, TASK_STATES.COMPLETED);
  assert.equal(task.body.taskId, admitted.body.effect.taskId);
  assert.equal(task.body.effect.exchangeId, sandbox.fixture.request.exchangeId);
});

test('task lifecycle: a replay is still refused, and the task still reads completed', async () => {
  const sandbox = makeSandbox();

  const { first, second, task } = await withBoundaries(sandbox, async (port) => {
    const firstResponse = await request(port, {
      method: 'POST', requestPath: '/api/a2a/exchange', body: sandbox.fixture.request,
    });
    const secondResponse = await request(port, {
      method: 'POST', requestPath: '/api/a2a/exchange', body: sandbox.fixture.request,
    });
    const taskResponse = await request(port, {
      requestPath: `${A2A_TASK_PATH_PREFIX}${firstResponse.body.effect.taskId}`,
    });
    return { first: firstResponse, second: secondResponse, task: taskResponse };
  });

  assert.equal(first.status, 200);
  // The whole point: task records did NOT turn a replay into a second success.
  assert.equal(second.status, 403);
  assert.equal(second.body.reason, 'replay_detected');
  // The caller that lost its first response can still find out what happened.
  assert.equal(task.body.state, TASK_STATES.COMPLETED);
});

test('task lifecycle: a reservation without a completion reads unknown, not completed', () => {
  const sandbox = makeSandbox();
  const store = createA2aTaskStore(sandbox.replayDirectory);
  const replayKey = 'a'.repeat(64);

  // Exactly the state a failed effect leaves behind: reserved, never completed.
  fs.writeFileSync(path.join(sandbox.replayDirectory, `${replayKey}.reserved`), replayKey, 'utf8');

  const record = store.readTask(taskIdForReplayKey(replayKey));
  assert.equal(record.state, TASK_STATES.UNKNOWN);
  assert.notEqual(record.state, TASK_STATES.COMPLETED);
});

test('task lifecycle: an unknown task stays unknown and is never a retry prompt', async () => {
  const sandbox = makeSandbox();
  const replayKey = 'b'.repeat(64);
  fs.writeFileSync(path.join(sandbox.replayDirectory, `${replayKey}.reserved`), replayKey, 'utf8');
  const taskId = taskIdForReplayKey(replayKey);

  const response = await withBoundaries(sandbox, (port) => request(port, {
    requestPath: `${A2A_TASK_PATH_PREFIX}${taskId}`,
  }));

  // 200, not 5xx: the lookup succeeded and the honest state is unknown. A 5xx
  // would invite exactly the retry this design refuses.
  assert.equal(response.status, 200);
  assert.equal(response.body.state, TASK_STATES.UNKNOWN);
  assert.equal(response.body.effect, undefined);
});

test('task lifecycle: never-reserved is not_found, kept distinct from unknown', () => {
  const sandbox = makeSandbox();
  const store = createA2aTaskStore(sandbox.replayDirectory);

  // "Never happened" and "happened, outcome unknown" must not collapse: an
  // operator reading these makes different decisions.
  assert.equal(store.readTask('c'.repeat(64)).state, TASK_STATES.NOT_FOUND);
  assert.equal(store.readTask('not-a-hash').state, TASK_STATES.NOT_FOUND);
});

test('task lifecycle: a completion is written once and never overwritten', () => {
  const sandbox = makeSandbox();
  const store = createA2aTaskStore(sandbox.replayDirectory);
  const replayKey = 'd'.repeat(64);

  const taskId = store.recordCompletion(replayKey, { admitted: true, exchangeId: 'first' });
  const again = store.recordCompletion(replayKey, { admitted: true, exchangeId: 'second' });

  assert.equal(again, taskId);
  // A second completion would mean the effect ran twice, which the reservation
  // forbids. The first record stands rather than being overwritten.
  assert.equal(store.readTask(taskId).effect.exchangeId, 'first');
});

test('task lifecycle: an unreadable record reads unknown rather than completed', () => {
  const sandbox = makeSandbox();
  const store = createA2aTaskStore(sandbox.replayDirectory);
  const taskId = taskIdForReplayKey('e'.repeat(64));

  fs.writeFileSync(path.join(sandbox.replayDirectory, `${taskId}.completed`), '{ not json', 'utf8');
  assert.equal(store.readTask(taskId).state, TASK_STATES.UNKNOWN);

  // A record whose taskId does not match its own filename is not trusted either.
  const other = taskIdForReplayKey('f'.repeat(64));
  fs.writeFileSync(path.join(sandbox.replayDirectory, `${other}.completed`),
    JSON.stringify({ taskId: 'mismatch', state: 'completed', effect: { admitted: true } }), 'utf8');
  assert.equal(store.readTask(other).state, TASK_STATES.UNKNOWN);
});

test('task lifecycle: the task id is not the replay key', () => {
  const replayKey = '9'.repeat(64);
  const taskId = taskIdForReplayKey(replayKey);

  // Handing out the replay key would hand out security-relevant state that a
  // caller could probe the reservation directory with.
  assert.notEqual(taskId, replayKey);
  assert.ok(/^[0-9a-f]{64}$/.test(taskId));
  assert.equal(taskIdForReplayKey(replayKey), taskId, 'derivation must be stable');
});

test('task lifecycle: only GET is served, and the route is authenticated', async () => {
  const sandbox = makeSandbox();
  const response = await withBoundaries(sandbox, (port) => request(port, {
    method: 'POST', requestPath: `${A2A_TASK_PATH_PREFIX}${'0'.repeat(64)}`, body: {},
  }));

  assert.equal(response.status, 405);
  assert.equal(response.body.reason, TASK_ROUTE_ERRORS.METHOD);

  const enabled = resolveRouteAuthPolicy(`${A2A_TASK_PATH_PREFIX}${'0'.repeat(64)}`, 'GET', { a2aTaskRouteEnabled: true });
  assert.equal(enabled.known, true);
  // Task ids are unguessable, but unguessability is not an authorization
  // decision and must not be used as one.
  assert.equal(enabled.authRequired, true);
  assert.equal(enabled.ruleId, 'a2a-task-read');

  const disabled = resolveRouteAuthPolicy(`${A2A_TASK_PATH_PREFIX}${'0'.repeat(64)}`, 'GET', {});
  assert.equal(disabled.known, false);
});

test('task lifecycle: no boundary without the configuration it depends on', () => {
  assert.equal(createTaskReadBoundary({}), null);
  const sandbox = makeSandbox();
  assert.equal(createTaskReadBoundary({ authorityFile: sandbox.authorityFile, replayDirectory: '' }), null);
  assert.ok(createTaskReadBoundary({ authorityFile: sandbox.authorityFile, replayDirectory: sandbox.replayDirectory }));
});
