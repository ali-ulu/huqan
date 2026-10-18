'use strict';

// Entry point of a protected MCP server service (ADR-018 §3, #3999).
//
//   node service-main.js init  --name <name> --state-dir <dir> --public-dir <dir>
//                              --port <n> --workspace-root <dir>
//   node service-main.js serve --name <name> --state-dir <dir> --public-dir <dir>
//                              --port <n> --workspace-root <dir> --app-root <dir>
//
// `init` runs once, from the elevated installer: it writes the endpoint pin
// (the fixed loopback port, the server name and the workspace id) into the
// public directory and refuses to run over an existing pin. Keys are not
// created here: agent clients are enrolled separately by the operator
// (`huqan mcp enroll`), and the service holds no key of its own -- the
// envelope authenticates clients, not the server.
//
// `serve` is what the Windows service runs. Before it listens it checks that
// every module node loaded is under the app root it was given: a service that
// reached code outside its protected copy refuses to start. It then points
// the enrolled-client registry at its state directory -- read again on every
// request, so `huqan mcp revoke` takes effect on the next request -- points
// the durable nonce store at its state directory, and builds the ordinary MCP server
// (mcpServer.createServer) behind the loopback envelope check -- the gate and
// admission policy stay exactly where they were.

const fs = require('node:fs');
const path = require('node:path');
const { createDurableCapabilityNonceStore } = require('../mcp-capability-nonce-store');
const { deriveWorkspaceId } = require('../protected-store-path');
const { readEndpointPin, writeEndpointPin } = require('./endpoint-pin');
const { readClientRegistry, registryPath } = require('./client-registry');
const { createLoopbackMcpService } = require('./loopback-service');

const OPTIONS = Object.freeze(['--name', '--state-dir', '--public-dir', '--port', '--operator', '--workspace-root', '--app-root']);
const NONCES_DIRNAME = 'nonces';

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!OPTIONS.includes(args[i]) || args[i + 1] === undefined) throw new Error(`unknown or incomplete option ${args[i]}`);
    options[args[i].slice(2)] = args[i + 1];
  }
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port must be 0-65535');
  for (const required of ['name', 'state-dir', 'workspace-root']) {
    if (!options[required]) throw new Error(`--${required} is required`);
  }
  return {
    name: options.name,
    stateDir: options['state-dir'],
    publicDir: options['public-dir'],
    port,
    operator: options.operator,
    workspaceRoot: options['workspace-root'],
    appRoot: options['app-root'],
  };
}

/** The endpoint pin: what every client-side surface trusts, written once. */
function initService({ name, stateDir: _stateDir, publicDir, port, operator, workspaceRoot }) {
  if (!publicDir) throw new Error('--public-dir is required for init');
  if (!Number.isInteger(port) || port === 0) throw new Error('init needs the fixed --port the service will listen on');
  if (!operator) throw new Error('--operator is required for init: it names the account the state tree grants');
  if (!fs.existsSync(publicDir)) throw new Error(`refusing to initialize: ${publicDir} does not exist; the installer creates it`);
  const workspaceId = deriveWorkspaceId(workspaceRoot);
  const written = writeEndpointPin(publicDir, { name, port, operator, workspaceId });
  if (!written.ok) throw new Error(`endpoint pin refused: ${written.reason}`);
  return written.pin;
}

/** Every loaded module must live under the app root: a service that reached
 * code outside its protected copy refuses to start. */
function loadedOutsideRoot(loaded, appRoot) {
  const root = path.resolve(appRoot);
  return loaded.map((file) => path.resolve(file))
    .filter((file) => !file.startsWith(root + path.sep) && file !== path.join(root, 'index.js'))
    .map((file) => path.relative(root, file).split(path.sep).join('/'));
}

/**
 * The enrolled clients, read from disk on every call so a revocation is
 * effective on the next request. Fail closed: an unreadable registry means no
 * client is enrolled, and every envelope fails unknown_key until the operator
 * repairs the file. A persistent fault is logged once per distinct reason, not
 * once per request.
 */
function createRegistryReader(file, log) {
  let lastFault = null;
  return () => {
    const registry = readClientRegistry(file);
    if (registry.ok) {
      lastFault = null;
      return registry.clients;
    }
    if (registry.reason !== lastFault) log({ event: 'registry_unreadable', reason: registry.reason });
    lastFault = registry.reason;
    return [];
  };
}

/**
 * Serve the workspace's MCP server behind the loopback envelope check.
 * Returns the http.Server; the caller keeps the process alive.
 */
function serveService({ name, stateDir, publicDir, port, workspaceRoot, appRoot }, log = (line) => process.stderr.write(`${JSON.stringify(line)}\n`)) {
  if (!Number.isInteger(port)) throw new Error('--port is required for serve');
  if (!appRoot) throw new Error('--app-root is required for serve');
  const outside = loadedOutsideRoot(Object.keys(require.cache), appRoot);
  if (outside.length) throw new Error(`refusing to start: loaded code outside the app root: ${outside.join(', ')}`);

  // The pin is the installer's contract: a serve whose port or name disagrees
  // with it is a misconfigured service, and a misconfigured service stops.
  const pinned = readEndpointPin(path.join(publicDir, 'endpoint.json'));
  if (!pinned.ok) throw new Error(`refusing to start: the endpoint pin is not usable (${pinned.reason})`);
  if (pinned.pin.port !== port || pinned.pin.name !== name) {
    throw new Error(`refusing to start: the pin names ${pinned.pin.name} on port ${pinned.pin.port}, not ${name} on port ${port}`);
  }

  const workspaceId = deriveWorkspaceId(workspaceRoot);
  if (pinned.pin.workspaceId !== workspaceId) {
    throw new Error('refusing to start: the pin was written for another workspace');
  }

  const enrolled = createRegistryReader(registryPath(stateDir), log);
  const nonceStore = createDurableCapabilityNonceStore({ directory: path.join(stateDir, NONCES_DIRNAME) });
  // Required late so the app-root check above sees the truth about this
  // process: mcpServer pulls in the whole runtime.
  // eslint-disable-next-line global-require
  const { createServer } = require('../../mcpServer');
  const server = createServer();
  const service = createLoopbackMcpService({ server, enrolled, nonceStore, workspaceId, log });
  service.on('error', (error) => {
    log({ event: 'fatal', message: error.message, code: error.code });
    process.exitCode = 1;
  });
  service.listen(port, '127.0.0.1', () => log({ event: 'listening', port: service.address().port, name, workspaceId }));
  const stop = () => {
    try { server.close?.(); } catch (_) { /* the service is going down anyway */ }
    service.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  return service;
}

function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const options = parseOptions(rest);
    if (command === 'init') {
      const pin = initService(options);
      process.stdout.write(`${JSON.stringify({ ok: true, pin })}\n`);
      return 0;
    }
    if (command === 'serve') {
      serveService(options);
      return 0;
    }
    throw new Error('usage: service-main.js init|serve --name <name> --state-dir <dir> --public-dir <dir> --port <n> --operator <account> --workspace-root <dir> [--app-root <dir>]');
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'fatal', message: error.message })}\n`);
    return 1;
  }
}

if (require.main === module) {
  process.exitCode = main();
}

module.exports = { createRegistryReader, initService, loadedOutsideRoot, parseOptions, serveService };
