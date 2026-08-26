'use strict';

const http = require('node:http');
const process = require('node:process');
const {
  DEMO_HOST,
  DEMO_PORT,
  demoEnvironment,
  newDemoRoot,
  removeDemoRoot,
  seedObservabilityDemo,
} = require('../lib/observability/demo');

function parseArgs(argv = []) {
  const options = { json: false, host: DEMO_HOST, port: DEMO_PORT };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') options.json = true;
    else if (arg === '--keep') options.keep = true;
    else if (arg === '--host') options.host = String(argv[++index] || DEMO_HOST);
    else if (arg === '--port') options.port = Number(argv[++index]);
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
    throw new Error('port must be an integer from 0 to 65535');
  }
  if (!/^(127\.0\.0\.1|localhost)$/.test(options.host)) {
    throw new Error('observability demo host must remain loopback-only');
  }
  return options;
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = error => { server.off('listening', onListening); reject(error); };
    const onListening = () => { server.off('error', onError); resolve(server.address()); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

async function startObservabilityDemo(options = {}) {
  const rootDir = options.rootDir || newDemoRoot();
  let seed;
  let environment = {};
  const previous = {};
  try {
    seed = seedObservabilityDemo({ rootDir, workspaceId: options.workspaceId });
    environment = demoEnvironment(seed, options);
  } catch (error) {
    if (!options.keep) removeDemoRoot(rootDir);
    throw error;
  }

  for (const [key, value] of Object.entries(environment)) {
    previous[key] = process.env[key];
    process.env[key] = value;
  }
  let server;
  try {
    // server.js reads persistence and auth configuration during require, so the
    // local demo environment is applied before loading the canonical server.
    server = require('../server');
    const address = await listen(server, options.port ?? DEMO_PORT, options.host || DEMO_HOST);
    const port = typeof address === 'object' && address ? address.port : options.port;
    const url = `http://${options.host || DEMO_HOST}:${port}/?workspace=${encodeURIComponent(seed.workspaceId)}#observability`;
    return {
      ...seed,
      host: options.host || DEMO_HOST,
      port,
      url,
      keep: Boolean(options.keep),
      server,
      close: async () => {
        server.closeAllConnections?.();
        server.closeHuqan?.();
        await new Promise(resolve => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        });
        if (!options.keep) removeDemoRoot(rootDir);
      },
      restoreEnvironment: () => {
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      },
    };
  } catch (error) {
    try { server?.closeHuqan?.(); } catch (_) {}
    try { server?.close?.(); } catch (_) {}
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    if (!options.keep) removeDemoRoot(rootDir);
    throw error;
  }
}

function printReady(demo, json = false) {
  const output = {
    ok: true,
    dashboardUrl: demo.url,
    host: demo.host,
    port: demo.port,
    workspaceId: demo.workspaceId,
    runId: demo.runId,
    traceId: demo.traceId,
    eventTypes: demo.eventTypes,
    queueJobId: demo.queueJobId,
    dashboardReady: demo.dashboardReady,
    cleanup: demo.keep
      ? 'Ctrl-C closes the server; --keep retains the isolated demo directory'
      : 'Ctrl-C closes the server and removes the isolated demo directory',
  };
  if (json) process.stdout.write(`${JSON.stringify(output)}\n`);
  else {
    process.stdout.write('HUQAN local observability demo is ready.\n');
    process.stdout.write(`Dashboard: ${demo.url}\n`);
    process.stdout.write(`Workspace: ${demo.workspaceId}\n`);
    process.stdout.write(`Seeded AgentV3 run: ${demo.runId}\n`);
    process.stdout.write('The URL opens the authenticated Observability view through a loopback-only HttpOnly browser session.\n');
    process.stdout.write(demo.keep
      ? 'Press Ctrl-C to stop; --keep retains the isolated demo data.\n'
      : 'Press Ctrl-C to stop and remove the isolated demo data.\n');
  }
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const demo = await startObservabilityDemo(options);
  printReady(demo, options.json);
  let closing = false;
  const close = async code => {
    if (closing) return;
    closing = true;
    try { await demo.close(); } finally {
      demo.restoreEnvironment();
      if (code !== undefined) process.exitCode = code;
    }
  };
  process.once('SIGINT', () => { close(0).catch(() => { process.exitCode = 1; }); });
  process.once('SIGTERM', () => { close(0).catch(() => { process.exitCode = 1; }); });
  return demo;
}

if (require.main === module) {
  main().catch(error => {
    process.stderr.write(`${error.code || 'OBSERVABILITY_DEMO_FAILED'}: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { listen, main, parseArgs, printReady, startObservabilityDemo };
