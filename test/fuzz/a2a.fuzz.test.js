'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const fc = require('fast-check');

const { buildFixture } = require('../../scripts/a2a-conformance/run.js');
const {
  A2A_ROUTE_ERRORS,
  CANONICAL_WORKSPACE,
  createA2aExchangeBoundary,
} = require('../../lib/a2a/exchange-route');
const {
  NEGOTIATE_ROUTE_ERRORS,
  createNegotiateBoundary,
} = require('../../lib/a2a/negotiate-route');
const {
  TASK_ROUTE_ERRORS,
  createTaskReadBoundary,
} = require('../../lib/a2a/task-route');

const invalidRootArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.string({ maxLength: 256 }),
  fc.array(fc.jsonValue(), { maxLength: 6 }),
);

function makeSandbox() {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-a2a-fuzz-'));
  const replayDirectory = path.join(root, 'replay');
  fs.mkdirSync(replayDirectory);
  const fixture = buildFixture(CANONICAL_WORKSPACE);
  const authorityFile = path.join(root, 'authority.json');
  fs.writeFileSync(authorityFile, JSON.stringify(fixture.authority), 'utf8');
  return { root, replayDirectory, authorityFile };
}

test('A2A fuzz: bounded-exchange and negotiate reject malformed bodies without crashing', { timeout: 15000 }, async () => {
  const sandbox = makeSandbox();
  try {
    const exchange = createA2aExchangeBoundary({
      authorityFile: sandbox.authorityFile,
      replayDirectory: sandbox.replayDirectory,
    });
    const negotiate = createNegotiateBoundary({
      authorityFile: sandbox.authorityFile,
      replayDirectory: sandbox.replayDirectory,
    });
    assert.ok(exchange);
    assert.ok(negotiate);

    const req = { method: 'POST', setTimeout() {} };

    await fc.assert(
      fc.asyncProperty(invalidRootArb, async (payload) => {
        const exchangeResult = await exchange.handle(req, async () => ({ ok: true, data: payload }));
        const negotiateResult = await negotiate.handle(req, async () => ({ ok: true, data: payload }));
        assert.equal(exchangeResult.statusCode, 400);
        assert.equal(exchangeResult.body.reason, A2A_ROUTE_ERRORS.BODY);
        assert.equal(negotiateResult.statusCode, 400);
        assert.equal(negotiateResult.body.reason, NEGOTIATE_ROUTE_ERRORS.BODY);
      }),
      { numRuns: 120 },
    );

    await fc.assert(
      fc.asyncProperty(fc.jsonValue(), async (noise) => {
        const payload = { workspaceId: 'fuzz-not-default', noise };
        const exchangeResult = await exchange.handle(req, async () => ({ ok: true, data: payload }));
        const negotiateResult = await negotiate.handle(req, async () => ({ ok: true, data: payload }));
        assert.equal(exchangeResult.statusCode, 400);
        assert.equal(exchangeResult.body.reason, A2A_ROUTE_ERRORS.WORKSPACE);
        assert.equal(negotiateResult.statusCode, 400);
        assert.equal(negotiateResult.body.reason, NEGOTIATE_ROUTE_ERRORS.WORKSPACE);
      }),
      { numRuns: 120 },
    );
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});

test('A2A fuzz: task route treats hostile task ids and methods as bounded refusals', { timeout: 10000 }, async () => {
  const sandbox = makeSandbox();
  try {
    const task = createTaskReadBoundary({
      authorityFile: sandbox.authorityFile,
      replayDirectory: sandbox.replayDirectory,
    });
    assert.ok(task);

    const idChar = fc.constantFrom(...'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789._-');
    const taskIdArb = fc.array(idChar, { maxLength: 160 }).map((chars) => chars.join(''));

    await fc.assert(
      fc.asyncProperty(taskIdArb, async (taskId) => {
        const reqUrl = new URL('/api/a2a/tasks/' + taskId, 'http://127.0.0.1');
        const result = task.handle({ method: 'GET' }, reqUrl);
        assert.equal(result.statusCode, 404);
        assert.equal(result.body.reason, TASK_ROUTE_ERRORS.NOT_FOUND);
      }),
      { numRuns: 180 },
    );

    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom('POST', 'PUT', 'PATCH', 'DELETE', 'TRACE', ''),
        taskIdArb,
        async (method, taskId) => {
          const reqUrl = new URL('/api/a2a/tasks/' + taskId, 'http://127.0.0.1');
          const result = task.handle({ method }, reqUrl);
          assert.equal(result.statusCode, 405);
          assert.equal(result.body.reason, TASK_ROUTE_ERRORS.METHOD);
        },
      ),
      { numRuns: 120 },
    );
  } finally {
    fs.rmSync(sandbox.root, { recursive: true, force: true });
  }
});
