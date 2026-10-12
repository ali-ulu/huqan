#!/usr/bin/env node
'use strict';

// Entry point of the approval authority service (#3860, ADR-016).
//
//   node service-main.js init  --state-dir <dir> --public-dir <dir> --port <n>
//   node service-main.js serve --state-dir <dir> --port <n>
//
// `init` runs once, from the elevated installer: it creates the keys and the
// operator's TOTP secret in the protected state directory, writes the pin the
// runtime trusts (both public keys and the port) to the public directory, and
// prints the otpauth URI for the operator's authenticator app. It refuses to
// run over existing state.
//
// `serve` is what the Windows service runs. Before it listens, it checks that
// every module node loaded is one of the bundle's files under its own root: a
// service that reached code outside the protected directory refuses to start.

const fs = require('node:fs');
const path = require('node:path');
const { AUTHORITY_BUNDLE_FILES } = require('./bundle-manifest');
const { createAuthorityState, openAuthorityState } = require('./state-store');
const { openLedgerStore } = require('./ledger-store');
const { createAuthorityService } = require('./authority-service');
const { createAuthorityServer } = require('./http-server');
const { keyIdFor } = require('./decision-envelope');
const { otpauthUri } = require('./totp');
const { PIN_VERSION } = require('./authority-pin');

const BUNDLE_ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_FILE = 'ledger.jsonl';
const OPTIONS = Object.freeze(['--state-dir', '--public-dir', '--port']);

function loadedOutsideBundle(loaded, root = BUNDLE_ROOT) {
  return loaded.map(file => path.relative(root, file).split(path.sep).join('/'))
    .filter(file => !AUTHORITY_BUNDLE_FILES.includes(file));
}

function parseOptions(args) {
  const options = {};
  for (let i = 0; i < args.length; i += 2) {
    if (!OPTIONS.includes(args[i]) || args[i + 1] === undefined) throw new Error(`unknown or incomplete option ${args[i]}`);
    options[args[i].slice(2)] = args[i + 1];
  }
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be 0-65535');
  if (!options['state-dir']) throw new Error('--state-dir is required');
  return { stateDir: options['state-dir'], publicDir: options['public-dir'], port };
}

function initAuthority({ stateDir, publicDir, port }) {
  if (!publicDir) throw new Error('--public-dir is required for init');
  // The pin is what every runtime trusts; it must name a real port.
  if (port === 0) throw new Error('init needs the fixed --port the service will listen on');
  // Checked before anything is written, so a refused init leaves nothing half-made.
  const pinFile = path.join(publicDir, 'authority.json');
  for (const existing of [stateDir, pinFile]) {
    if (fs.existsSync(existing) && (existing === pinFile || fs.readdirSync(existing).length > 0)) {
      throw new Error(`refusing to initialize over existing ${existing}`);
    }
  }
  const created = createAuthorityState({ dir: stateDir });
  const keyId = keyIdFor(created.signingPublicKeyPem);
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(pinFile, `${JSON.stringify({ v: PIN_VERSION, port, keyId, signingKey: created.signingPublicKeyPem,
    sealingKey: created.sealingPublicKeyPem }, null, 2)}\n`, { flag: 'wx' });
  return { keyId, pinFile, otpauthUri: otpauthUri({ secret: created.totpSecret, account: 'operator', issuer: 'HUQAN Authority' }) };
}

function serveAuthority({ stateDir, port }, log = line => process.stderr.write(`${JSON.stringify(line)}\n`)) {
  const outside = loadedOutsideBundle(Object.keys(require.cache));
  if (outside.length) throw new Error(`refusing to start: loaded code outside the bundle: ${outside.join(', ')}`);
  const state = openAuthorityState({ dir: stateDir });
  const ledger = openLedgerStore({ file: path.join(stateDir, LEDGER_FILE) });
  if (ledger.corrupt) log({ event: 'ledger_corrupt', ...ledger.corrupt });
  const server = createAuthorityServer({ service: createAuthorityService({ ledger, state }), signingKey: state.signingKey });
  server.on('error', (error) => {
    log({ event: 'fatal', message: error.message, code: error.code });
    process.exitCode = 1;
  });
  server.listen(port, '127.0.0.1', () => log({ event: 'listening', port: server.address().port, keyId: keyIdFor(state.signingKey) }));
  return server;
}

function main(argv = process.argv.slice(2)) {
  try {
    const [command, ...rest] = argv;
    const options = parseOptions(rest);
    if (command === 'init') {
      const { keyId, pinFile, otpauthUri: uri } = initAuthority(options);
      process.stdout.write(`${JSON.stringify({ keyId, pinFile, otpauthUri: uri })}\n`);
      return 0;
    }
    if (command === 'serve') {
      serveAuthority(options);
      return 0;
    }
    throw new Error('usage: service-main.js init|serve --state-dir <dir> [--public-dir <dir>] --port <n>');
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'fatal', message: error.message })}\n`);
    return 1;
  }
}

if (require.main === module) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}

module.exports = { PIN_VERSION, loadedOutsideBundle, parseOptions, initAuthority, serveAuthority, main };
