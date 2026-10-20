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
const { checkOperatorCode } = require('./operator-check');
const { PIN_VERSION } = require('./authority-pin');

const BUNDLE_ROOT = path.resolve(__dirname, '..', '..');
const LEDGER_FILE = 'ledger.jsonl';
const OPTIONS = Object.freeze(['--state-dir', '--public-dir', '--port', '--code']);

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
  const port = options.port === undefined ? undefined : Number(options.port);
  if (port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) throw new Error('--port must be 0-65535');
  if (!options['state-dir']) throw new Error('--state-dir is required');
  return { stateDir: options['state-dir'], publicDir: options['public-dir'], port, code: options.code };
}

function initAuthority({ stateDir, publicDir, port }) {
  if (!publicDir) throw new Error('--public-dir is required for init');
  // The pin is what every runtime trusts; it must name a real port.
  if (!Number.isInteger(port) || port === 0) throw new Error('init needs the fixed --port the service will listen on');
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
    sealingKey: created.sealingPublicKeyPem, anchorKey: created.anchorPublicKeyPem }, null, 2)}\n`, { flag: 'wx' });
  return { keyId, pinFile, otpauthUri: otpauthUri({ secret: created.totpSecret, account: 'operator', issuer: 'HUQAN Authority' }) };
}

/**
 * Run by the installer once the operator has added the secret to an
 * authenticator app: a right code proves the enrollment before the service
 * starts, and the step it used becomes the replay floor.
 */
function enrollCheck({ stateDir, code }, now = Date.now()) {
  const state = openAuthorityState({ dir: stateDir });
  const progress = state.readTotp();
  const check = checkOperatorCode({ secret: state.totpSecret, code: String(code || ''), now, progress });
  if (check.progress !== progress) state.writeTotp(check.progress);
  return check.ok ? { ok: true } : { ok: false, code: check.code };
}

/**
 * Refuse to serve from a state directory an agent could reach (#4082, ADR-020
 * §7). The Windows service relies on the installer's ACL; POSIX has no ACL to
 * re-read here, so the evidence is the directory's own owner and mode:
 *
 *   - the service must not run as root (root can read anything, and a root
 *     service is not the separate identity the boundary is built on);
 *   - the state dir must be owned by the running uid;
 *   - it must be closed to group and other (`mode & 0o077 === 0`).
 *
 * Anything that cannot be established refuses rather than passes. In the bundle
 * only `fs` and `process` are available: the darwin extended-ACL probe lives in
 * `posix-path-trust.js` (runtime side) and is out of reach here, so mode and
 * ownership are the whole check.
 */
function assertPosixStateDirTrusted(stateDir, { platform = process.platform, getuid = process.getuid, lstat = fs.lstatSync } = {}) {
  if (platform === 'win32') return;
  if (typeof getuid !== 'function') throw new Error('refusing to start: cannot determine the service uid');
  const uid = getuid();
  if (uid === 0) throw new Error('refusing to start: the authority service must not run as root');
  let stat;
  try {
    stat = lstat(stateDir);
  } catch (error) {
    throw new Error(`refusing to start: cannot inspect the state directory (${error.message})`);
  }
  if (typeof stat.isSymbolicLink !== 'function' || stat.isSymbolicLink()) {
    throw new Error('refusing to start: the state directory must not be a symlink');
  }
  if (stat.uid !== uid) {
    throw new Error(`refusing to start: the state directory is owned by uid ${stat.uid}, not the service uid ${uid}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`refusing to start: the state directory is group- or other-accessible (mode ${(stat.mode & 0o777).toString(8)})`);
  }
}

function serveAuthority({ stateDir, port }, log = line => process.stderr.write(`${JSON.stringify(line)}\n`)) {
  if (!Number.isInteger(port)) throw new Error('--port is required for serve');
  const outside = loadedOutsideBundle(Object.keys(require.cache));
  if (outside.length) throw new Error(`refusing to start: loaded code outside the bundle: ${outside.join(', ')}`);
  assertPosixStateDirTrusted(stateDir);
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
    if (command === 'enroll-check') {
      const result = enrollCheck(options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      return result.ok ? 0 : 2;
    }
    if (command === 'serve') {
      serveAuthority(options);
      return 0;
    }
    throw new Error('usage: service-main.js init|serve --state-dir <dir> [--public-dir <dir>] --port <n> | enroll-check --state-dir <dir> --code <n>');
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ event: 'fatal', message: error.message })}\n`);
    return 1;
  }
}

if (require.main === module) {
  const code = main();
  if (code !== 0) process.exitCode = code;
}

module.exports = { PIN_VERSION, loadedOutsideBundle, parseOptions, initAuthority, enrollCheck, assertPosixStateDirTrusted, serveAuthority, main };
