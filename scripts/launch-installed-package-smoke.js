#!/usr/bin/env node
'use strict';

/**
 * Product-launch smoke for the package exactly as an npm consumer installs it.
 *
 * This is intentionally not another unit suite. It packs the current tree,
 * installs that tarball into an empty project, and exercises the public user
 * surfaces that are easy to miss when tests run from a checkout:
 *
 *   - CLI learn -> review -> durable approval -> canonical write -> receipt
 *   - MCP learn -> review -> scoped operator approval -> canonical write -> receipt
 *   - REST learn -> review -> scoped operator approval -> canonical write -> receipt
 *   - authenticated, workspace-bound /viewer read of the owned REST receipt
 *   - semantic parity of the final approved receipt across CLI / REST / MCP
 *
 * The temporary HOME/USERPROFILE and persistence paths keep the smoke isolated
 * from the operator's real HUQAN state.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoRoot, pkg, NPM_COMMAND, SMOKE_API_KEY, SMOKE_CLAIM, SMOKE_WORKSPACE, PARITY_CLAIM, PARITY_WORKSPACE, failures, fail, ok, run } = require('./launch-installed-package-smoke-context');
const { verifyCliApprovedReceipt } = require('./launch-installed-package-smoke-cli');
const { verifyMcpApprovedReceipt } = require('./launch-installed-package-smoke-mcp');
const { verifyServerApprovedReceiptAndViewer } = require('./launch-installed-package-smoke-rest');
const { verifyCrossSurfaceReceiptParity } = require('./launch-installed-package-smoke-parity');

function main() {
  console.log(`Launch smoke: packing and exercising ${pkg.name}@${pkg.version} as an installed consumer.`);

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-launch-pack-'));
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-launch-consumer-'));
  const home = path.join(consumer, 'home');
  fs.mkdirSync(home);
  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    HUQAN_MEMORY_PATH: path.join(home, 'memory.json'),
    HUQAN_DB_PATH: path.join(home, 'memory.db'),
    HUQAN_MCP_CAPABILITY_NONCE_DIR: path.join(home, 'capability-nonces'),
  };

  try {
    const pack = run(NPM_COMMAND, ['pack', '--pack-destination', packDir], { cwd: repoRoot });
    if (pack.status !== 0) {
      fail(`npm pack failed\n${pack.output.slice(-2500)}`);
      return 1;
    }

    const tarballName = fs.readdirSync(packDir).find(name => name.endsWith('.tgz'));
    if (!tarballName) {
      fail('npm pack produced no tarball');
      return 1;
    }
    const tarball = path.join(packDir, tarballName);
    ok(`packed ${tarballName}`);

    const init = run(NPM_COMMAND, ['init', '-y'], { cwd: consumer, env });
    if (init.status !== 0) {
      fail(`npm init failed\n${init.output.slice(-1500)}`);
      return 1;
    }

    const install = run(NPM_COMMAND, ['install', tarball, '--no-audit', '--no-fund'], {
      cwd: consumer,
      env,
    });
    if (install.status !== 0) {
      fail(`npm install failed\n${install.output.slice(-2500)}`);
      return 1;
    }
    ok('clean consumer install succeeds');

    const binDir = path.join(consumer, 'node_modules', '.bin');
    const cli = verifyCliApprovedReceipt(binDir, consumer, env);
    const mcp = verifyMcpApprovedReceipt(binDir, consumer, env);
    const rest = verifyServerApprovedReceiptAndViewer(consumer, env);
    verifyCrossSurfaceReceiptParity({ cli, rest, mcp });
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
    fs.rmSync(packDir, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length === 0) {
    console.log('OK: installed-package launch smoke passed.');
    return 0;
  }
  console.error(`FAIL: ${failures.length} installed-package launch smoke check(s) failed.`);
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  SMOKE_API_KEY,
  SMOKE_CLAIM,
  SMOKE_WORKSPACE,
  PARITY_CLAIM,
  PARITY_WORKSPACE,
};
