'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const AgentV3 = require('../agent.v3');
const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { createObservabilityService } = require('../lib/observability/service');

const WORKSPACE = 'huqan-observability-demo';
const GOAL = 'kedi hayvandir mi?';

function prepareDirectory(output) {
  const target = path.resolve(output);
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw Object.assign(new Error(`Demo directory is not empty: ${target}`), { code: 'OBSERVABILITY_DEMO_DIRECTORY_NOT_EMPTY' });
  fs.mkdirSync(target, { recursive: true, mode: 0o700 });
  return target;
}

function seedDemo({ output = path.join(process.cwd(), '.huqan-observability-demo') } = {}) {
  const directory = prepareDirectory(output);
  const databasePath = path.join(directory, 'memory.db');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false });
  kernel.learn('kedi hayvandir', Kernel.createAdmissionBypassOpts('observability_demo_seed'));
  const agent = new AgentV3({ kernel, dbPath: databasePath, maxSteps: 1, maxIterations: 20, timeBudgetMs: 5_000 });
  const service = createObservabilityService({ db: agent.storage.db });
  kernel.observability = service;
  try {
    const result = agent.run(GOAL, { resume: false, maxSteps: 1, maxIterations: 20, timeBudgetMs: 5_000, workspaceId: WORKSPACE });
    const run = service.listRuns({ workspaceId: WORKSPACE, limit: 1 }).items[0];
    if (!run) throw Object.assign(new Error('AgentV3 did not produce an observability run'), { code: 'OBSERVABILITY_DEMO_RUN_MISSING' });
    const events = service.listEvents({ workspaceId: WORKSPACE, runId: run.runId, limit: 100 }).items;
    const required = ['run_started', 'step_finished', 'run_finished'];
    if (!required.every(type => events.some(event => event.eventType === type))) throw Object.assign(new Error('AgentV3 event sequence is incomplete'), { code: 'OBSERVABILITY_DEMO_EVENTS_INCOMPLETE' });
    const report = { schemaVersion: 1, demo: true, workspaceId: WORKSPACE, runId: run.runId, status: run.status, eventTypes: [...new Set(events.map(event => event.eventType))], metrics: service.summary({ workspaceId: WORKSPACE }), resultStatus: result?.data?.status || result?.status || null };
    fs.writeFileSync(path.join(directory, 'demo-report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    fs.writeFileSync(path.join(directory, '.huqan-observability-demo.json'), `${JSON.stringify({ schemaVersion: 1, workspaceId: WORKSPACE, database: 'memory.db' })}\n`, { mode: 0o600 });
    return Object.freeze({ directory, databasePath, report });
  } finally { try { agent.storage.close(); } catch (_) {} try { kernel.graph?.close?.(); } catch (_) {} }
}

function serveDemo({ directory, port = 3000, stdio = 'inherit', announce = true } = {}) {
  const apiKey = `demo-${crypto.randomBytes(16).toString('hex')}`;
  const authorizationPolicy = JSON.stringify({ memberships: [{ subject: 'local-api-key', workspaceId: WORKSPACE, role: 'admin' }] });
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: directory, stdio, env: { ...process.env, HUQAN_DB_PATH: path.join(directory, 'memory.db'), HUQAN_API_KEY: apiKey, HUQAN_OBSERVABILITY_AUTHZ_POLICY: authorizationPolicy, PORT: String(port) },
  });
  if (announce) process.stdout.write(`\nDemo dashboard: http://127.0.0.1:${port}/\nWorkspace: ${WORKSPACE}\nSession API key: ${apiKey}\nData directory: ${directory}\nPress Ctrl+C to stop.\n`);
  return Object.freeze({ child, apiKey, port, workspaceId: WORKSPACE });
}

function parseArgs(argv) {
  const args = { serve: true, output: path.join(process.cwd(), '.huqan-observability-demo'), port: 3000 };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--no-serve') args.serve = false;
    else if (argv[index] === '--output') args.output = argv[++index];
    else if (argv[index] === '--port') args.port = Number(argv[++index]);
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  if (!args.output || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) throw new Error('A valid --output and --port are required');
  return args;
}

if (require.main === module) {
  try { const options = parseArgs(process.argv.slice(2)); const seeded = seedDemo(options); process.stdout.write(`${JSON.stringify(seeded.report, null, 2)}\n`); if (options.serve) serveDemo({ directory: seeded.directory, port: options.port }); }
  catch (error) { process.stderr.write(`${error.code || 'OBSERVABILITY_DEMO_FAILED'}: ${error.message}\n`); process.exitCode = 1; }
}

module.exports = { GOAL, WORKSPACE, parseArgs, prepareDirectory, seedDemo, serveDemo };
