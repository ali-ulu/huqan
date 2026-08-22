'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');
const {
  DEMO_GOAL,
  parseArgs,
  seedDemoData,
} = require('../scripts/product-hunt-observability-demo');

test('Product Hunt demo seed creates runs, tools, alert and queue projections', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ph-demo-test-'));
  const dbPath = path.join(directory, 'memory.db');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));

  const result = seedDemoData({ dbPath, workspaceId: 'product-hunt-demo' });

  assert.equal(result.summary.totalRuns, 2);
  assert.equal(result.summary.completedRuns, 1);
  assert.equal(result.summary.failedRuns, 1);
  assert.equal(result.summary.toolCallCount, 4);
  assert.equal(result.summary.tokenKnown, true);
  assert.equal(result.summary.costKnown, true);
  assert.equal(result.queue.depth, 1);
  assert.equal(result.alerts.length, 1);

  const db = new Database(dbPath);
  t.after(() => db.close());
  const service = createObservabilityService({ db });
  const runs = service.listRuns({ workspaceId: 'product-hunt-demo', limit: 10 });
  const events = service.listEvents({ workspaceId: 'product-hunt-demo', limit: 100 });
  const queue = service.listQueue({ workspaceId: 'product-hunt-demo', limit: 10 });

  assert.equal(runs.items.length, 2);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].goalLength, DEMO_GOAL.length);
  assert.equal(Object.hasOwn(queue[0], 'goal'), false);
  assert.equal(Object.hasOwn(runs.items[0], 'goal'), false);
  assert.equal(JSON.stringify(runs.items).includes(DEMO_GOAL), false);
  assert.equal(JSON.stringify(events.items).includes(DEMO_GOAL), false);
});

test('Product Hunt demo argument parser supports isolated no-queue runs', () => {
  const options = parseArgs(['--db', '/tmp/demo.db', '--workspace', 'demo', '--reset', '--no-queue', '--json']);
  assert.deepEqual(options, {
    dbPath: '/tmp/demo.db',
    workspaceId: 'demo',
    reset: true,
    enqueue: false,
    json: true,
  });
});
