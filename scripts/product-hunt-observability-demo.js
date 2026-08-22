'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createObservabilityService } = require('../lib/observability/service');

const DEFAULT_WORKSPACE = 'product-hunt-demo';
const DEFAULT_DB_PATH = path.join(os.tmpdir(), 'huqan-product-hunt-demo', 'memory.db');
const DEMO_GOAL = 'Review a bounded verification workflow and report its evidence status';

function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    dbPath: process.env.HUQAN_DEMO_DB_PATH || DEFAULT_DB_PATH,
    workspaceId: process.env.HUQAN_DEMO_WORKSPACE_ID || DEFAULT_WORKSPACE,
    reset: false,
    enqueue: true,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--db') options.dbPath = argv[++index];
    else if (arg === '--workspace') options.workspaceId = argv[++index];
    else if (arg === '--reset') options.reset = true;
    else if (arg === '--no-queue') options.enqueue = false;
    else if (arg === '--json') options.json = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!options.dbPath || !options.workspaceId) throw new Error('--db and --workspace require values');
  return options;
}

function removeDemoDatabase(dbPath) {
  for (const suffix of ['', '-wal', '-shm']) {
    try { fs.rmSync(`${dbPath}${suffix}`, { force: true }); } catch (_) {}
  }
}

function runId(label) {
  return `product-hunt-${label}-${crypto.randomUUID()}`;
}

function seedSuccessfulRun(service, workspaceId, now) {
  const runIdValue = runId('completed');
  const startedAt = now - 1_500;
  service.recordRunStart({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    runtime: 'agent-v3',
    goal: DEMO_GOAL,
    objective: 'verification',
    startedAt,
  });
  service.recordStep({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    status: 'completed',
    tool: 'verify',
    durationMs: 320,
    usage: { tokens: 180, inputTokens: 110, outputTokens: 70, costMicros: 36 },
    payload: { stepId: 'demo-verify-1', phase: 'verification' },
  });
  service.recordStep({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    status: 'completed',
    tool: 'ask',
    durationMs: 160,
    usage: { tokens: 120, inputTokens: 80, outputTokens: 40, costMicros: 24 },
    payload: { stepId: 'demo-ask-1', phase: 'evidence' },
  });
  service.recordRunFinish({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    runtime: 'agent-v3',
    goal: DEMO_GOAL,
    objective: 'verification',
    status: 'completed',
    startedAt,
    finishedAt: now - 500,
    durationMs: 1_000,
    stepCount: 2,
    successfulSteps: 2,
    blockedSteps: 0,
    errorSteps: 0,
    usage: { tokens: 300, inputTokens: 190, outputTokens: 110, costMicros: 60 },
  });
  return runIdValue;
}

function seedFailedRun(service, workspaceId, now) {
  const runIdValue = runId('failed');
  const startedAt = now - 4_200;
  service.recordRunStart({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    runtime: 'agent-v3',
    goal: DEMO_GOAL,
    objective: 'verification',
    startedAt,
  });
  service.recordStep({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    status: 'completed',
    tool: 'compare',
    durationMs: 760,
    usage: { tokens: 220, inputTokens: 140, outputTokens: 80, costMicros: 44 },
    payload: { stepId: 'demo-compare-1', phase: 'comparison' },
  });
  service.recordStep({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    status: 'failed',
    tool: 'verify',
    durationMs: 640,
    usage: { tokens: 140, inputTokens: 90, outputTokens: 50, costMicros: 28 },
    payload: { stepId: 'demo-verify-2', phase: 'verification', outcome: 'review_required' },
  });
  service.recordRunFinish({
    workspaceId,
    runId: runIdValue,
    agentId: 'demo-agent',
    runtime: 'agent-v3',
    goal: DEMO_GOAL,
    objective: 'verification',
    status: 'failed',
    startedAt,
    finishedAt: now - 1_000,
    durationMs: 3_200,
    stepCount: 2,
    successfulSteps: 1,
    blockedSteps: 0,
    errorSteps: 1,
    errorCode: 'DEMO_REVIEW_REQUIRED',
    usage: { tokens: 360, inputTokens: 230, outputTokens: 130, costMicros: 72 },
  });
  return runIdValue;
}

function seedDemoData({ dbPath, workspaceId = DEFAULT_WORKSPACE, enqueue = true, now = Date.now } = {}) {
  if (!dbPath) throw new TypeError('dbPath is required');
  fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new Database(dbPath);
  try {
    const service = createObservabilityService({ db, now });
    service.createAlertRule({
      workspaceId,
      name: 'Demo p95 latency above 500 ms',
      metric: 'p95_latency_ms',
      operator: 'gt',
      threshold: 500,
      windowMs: 86_400_000,
      cooldownMs: 300_000,
    });
    const timestamp = now();
    const runIds = [
      seedSuccessfulRun(service, workspaceId, timestamp),
      seedFailedRun(service, workspaceId, timestamp),
    ];
    if (enqueue) {
      service.enqueueJob({
        workspaceId,
        agentId: 'demo-agent',
        goal: DEMO_GOAL,
        maxSteps: 4,
        maxAttempts: 3,
      });
    }
    return {
      dbPath: path.resolve(dbPath),
      workspaceId,
      runIds,
      summary: service.summary({ workspaceId, windowMs: 86_400_000 }),
      queue: service.queueSummary({ workspaceId }),
      alerts: service.listAlerts({ workspaceId, limit: 20 }),
      rules: service.listAlertRules({ workspaceId, limit: 20 }),
    };
  } finally {
    db.close();
  }
}

function help() {
  return [
    'HUQAN Product Hunt observability demo seed',
    '',
    'Usage:',
    '  npm run demo:observability -- --db /tmp/huqan-demo/observability.db --reset',
    '',
    'Options:',
    '  --db <path>          SQLite path; defaults to a temp directory',
    '  --workspace <id>     Workspace scope; defaults to product-hunt-demo',
    '  --reset              Remove only the selected demo database first',
    '  --no-queue           Do not leave a queued demo job',
    '  --json               Print a machine-readable summary',
  ].join('\n');
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(help());
    return null;
  }
  if (options.reset) removeDemoDatabase(options.dbPath);
  const result = seedDemoData(options);
  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log('HUQAN Product Hunt observability demo data ready.');
    console.log(`  database  : ${result.dbPath}`);
    console.log(`  workspace : ${result.workspaceId}`);
    console.log(`  runs      : ${result.summary.totalRuns} (${result.summary.completedRuns} completed, ${result.summary.failedRuns} failed)`);
    console.log(`  tool calls: ${result.summary.toolCallCount}`);
    console.log(`  queue     : ${result.queue.depth} queued/running`);
    console.log(`  alerts    : ${result.alerts.length} firing`);
    console.log('  note      : demo goals are stored privately; public projections expose digest and length only.');
  }
  return result;
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Demo seed failed: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = {
  DEFAULT_DB_PATH,
  DEFAULT_WORKSPACE,
  DEMO_GOAL,
  help,
  main,
  parseArgs,
  removeDemoDatabase,
  seedDemoData,
};
