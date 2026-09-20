#!/usr/bin/env node
'use strict';

/**
 * Registry round-trip verification for a just-published release (#2631, C4).
 *
 * `verify-package-tarball.js` proves the packed tarball behaves; this script
 * proves the registry copy does. It runs in `publish.yml` after the `Publish`
 * step, on real publishes only, and fails the run when anything below fails.
 * A failure cannot unpublish (npm versions are immutable) -- it fails loudly
 * so a broken release is caught here instead of by a consumer:
 *
 *   1. The exact `name@version` becomes visible on the registry (with a wait
 *      for replication lag, so a slow CDN reads as waiting, not as failure).
 *   2. Smoke against the installed registry copy, reusing the tarball checks:
 *      `quickstart`, `huqan-mcp initialize`, `huqan-gate block`.
 *   3. A provenance attestation exists on the registry dist record.
 *   4. The CycloneDX SBOM generated before the upload describes the published
 *      tarball: same root component, and every direct dependency name in the
 *      published manifest appears in the SBOM.
 *
 * Usage:  node scripts/verify-published-round-trip.js --sbom <path.cdx.json>
 * Exit 0 = the registry copy is verified, exit 1 = it is not.
 */

const {
  NPM_COMMAND,
  packageBin,
  run,
  takeSharedFailures,
  verifyA2aRuntime,
  verifyBinsAndVersion,
  verifyDecisionExplainer,
  verifyExternalAdapters,
  verifyExternalGuard,
  verifyMcp,
  verifyQuickstart,
} = require('./verify-package-tarball');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const LABEL = 'registry install';

// How long a just-published version may take to become installable. npm
// metadata and the tarball CDN replicate separately, so "version visible but
// tarball 404" is waited out, not failed, inside this budget.
const REGISTRY_WAIT_MS = 5 * 60 * 1000;
const REGISTRY_POLL_MS = 15 * 1000;
const INSTALL_ATTEMPTS = 3;
const INSTALL_RETRY_MS = 30 * 1000;

const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`FAIL: ${message}`);
}

function ok(message) {
  console.log(`  ok: ${message}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** JSON.parse rejects a leading BOM, so drop it after decoding. */
function stripBom(text) {
  return String(text).replace(new RegExp(`^${String.fromCharCode(0xFEFF)}`), '');
}

function parseArgs(argv) {
  let sbom = null;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--sbom' && index + 1 < argv.length) sbom = argv[index + 1];
  }
  return { sbom };
}

function npmViewJson(spec, field) {
  const viewed = run(NPM_COMMAND, ['view', spec, field, '--json'], { timeoutMs: 60 * 1000 });
  if (viewed.status !== 0) return { ok: false, output: viewed.output };
  try {
    return { ok: true, value: JSON.parse(viewed.stdout) };
  } catch (_) {
    return { ok: false, output: viewed.output };
  }
}

/** Wait until the registry serves the exact version, then return true. */
async function waitForRegistry(spec, version) {
  const deadline = Date.now() + REGISTRY_WAIT_MS;
  for (;;) {
    const viewed = npmViewJson(spec, 'version');
    if (viewed.ok && String(viewed.value).trim() === version) {
      ok(`${spec} is visible on the registry`);
      return true;
    }
    if (Date.now() >= deadline) {
      fail(`${spec} never became visible on the registry within ${REGISTRY_WAIT_MS / 1000}s\n`
        + `${(viewed.output || '').slice(-1000)}`);
      return false;
    }
    await sleep(REGISTRY_POLL_MS);
  }
}

/**
 * The dist record must carry the tarball URL, an integrity hash npm enforces
 * on install, and a provenance attestation from trusted publishing. The shape
 * check is deliberately structural (object with a provenance entry) rather
 * than byte-exact: if npm changes the envelope, this fails with the observed
 * JSON attached so the check can be updated -- silently passing an unattested
 * release would be worse.
 */
function verifyDistAttestations(spec, version) {
  const viewed = npmViewJson(spec, 'dist');
  if (!viewed.ok || !viewed.value || typeof viewed.value !== 'object') {
    fail(`could not read the dist record for ${spec}\n${(viewed.output || '').slice(-1000)}`);
    return null;
  }
  const dist = viewed.value;
  if (typeof dist.tarball !== 'string' || !dist.tarball.startsWith('https://')) {
    fail(`${spec} has no registry tarball URL: ${JSON.stringify(dist).slice(0, 500)}`);
    return null;
  }
  if (typeof dist.integrity !== 'string' || !dist.integrity.startsWith('sha512-')) {
    fail(`${spec} has no sha512 integrity hash for npm to enforce on install: `
      + `${JSON.stringify(dist).slice(0, 500)}`);
    return null;
  }
  ok(`dist record carries tarball + sha512 integrity for ${version}`);
  const attestations = dist.attestations;
  const provenance = attestations && typeof attestations === 'object' ? attestations.provenance : null;
  const attestationList = attestations && typeof attestations === 'object' && Array.isArray(attestations.attestations)
    ? attestations.attestations
    : [];
  if ((!provenance || typeof provenance !== 'object') && attestationList.length === 0) {
    fail(`${spec} has no provenance attestation on the registry: ${JSON.stringify(attestations).slice(0, 1000)}`);
    return null;
  }
  ok('provenance attestation exists on the registry');
  return dist;
}

/**
 * The SBOM was generated from the lockfile before the upload
 * (`--omit dev --package-lock-only`). It matches the published tarball when
 * its root component names this exact release and every direct dependency in
 * the published manifest appears as an SBOM component. Version ranges are
 * intentionally not resolved here -- that is the lockfile's job, already
 * verified by `npm ci` -- only presence is asserted, so a dependency that
 * fell out of the SBOM cannot pass quietly.
 */
function verifySbomMatchesTarball(sbomPath, name, version, manifest) {
  let sbom;
  try {
    // The SBOM is written by a shell redirect in the workflow (UTF-8), but a
    // PowerShell `>` redirect saves UTF-16 instead. Decode by BOM so the
    // check reads the bytes, not the shell that wrote them.
    const raw = fs.readFileSync(sbomPath);
    let text;
    if (raw[0] === 0xFF && raw[1] === 0xFE) text = raw.subarray(2).toString('utf16le');
    else if (raw[0] === 0xFE && raw[1] === 0xFF) text = Buffer.from(raw.subarray(2)).swap16().toString('utf16le');
    else text = raw.toString('utf8');
    sbom = JSON.parse(stripBom(text));
  } catch (error) {
    fail(`could not read the SBOM at ${sbomPath}: ${(error && error.message) || error}`);
    return;
  }
  if (sbom.bomFormat !== 'CycloneDX' || !Array.isArray(sbom.components)) {
    fail(`SBOM at ${sbomPath} is not a CycloneDX bill of materials`);
    return;
  }
  const root = sbom.metadata && sbom.metadata.component ? sbom.metadata.component : {};
  if (root.name !== name || root.version !== version) {
    fail(`SBOM root component is ${root.name}@${root.version}, expected ${name}@${version}: `
      + 'the SBOM was generated for a different release');
    return;
  }
  ok(`SBOM root component is ${name}@${version}`);
  const componentNames = new Set(sbom.components.map((component) => component && component.name).filter(Boolean));
  const direct = { ...(manifest.dependencies || {}), ...(manifest.optionalDependencies || {}) };
  const missing = Object.keys(direct).filter((dep) => !componentNames.has(dep));
  if (missing.length > 0) {
    fail(`SBOM is missing direct dependencies of the published manifest: ${missing.join(', ')}`);
    return;
  }
  ok(`SBOM covers all ${Object.keys(direct).length} direct dependencies of the published manifest `
    + `(${sbom.components.length} components total)`);
}

async function installFromRegistry(consumer, env, spec) {
  const init = run(NPM_COMMAND, ['init', '-y'], { cwd: consumer });
  if (init.status !== 0) {
    fail(`${LABEL}: could not initialise the consumer project`);
    return false;
  }
  for (let attempt = 1; attempt <= INSTALL_ATTEMPTS; attempt += 1) {
    // npm verifies dist.integrity on install and refuses a tampered tarball,
    // so a successful install already proves the bits match the registry.
    const install = run(NPM_COMMAND, ['install', spec, '--no-audit', '--no-fund'], { cwd: consumer, env });
    if (install.status === 0) {
      ok(`installs ${spec} from the registry (attempt ${attempt})`);
      return true;
    }
    if (attempt < INSTALL_ATTEMPTS) {
      console.log(`  retry: install attempt ${attempt} failed, waiting ${INSTALL_RETRY_MS / 1000}s for replication`);
      await sleep(INSTALL_RETRY_MS);
    } else {
      fail(`${LABEL}: npm install ${spec} failed\n${install.output.slice(-2000)}`);
      return false;
    }
  }
  return false;
}

async function verifyConsumer(spec, version) {
  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-round-trip-'));
  // A home of its own: quickstart writes under HOME, and a verification run
  // must not touch the operator's real memory.
  const home = path.join(consumer, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  try {
    if (!await installFromRegistry(consumer, env, spec)) return;
    const binDir = path.join(consumer, 'node_modules', '.bin');
    verifyBinsAndVersion(LABEL, binDir, consumer, env, version);
    verifyExternalAdapters(LABEL, consumer);
    verifyExternalGuard(LABEL, binDir, consumer, env);
    verifyDecisionExplainer(LABEL, consumer, env);
    verifyQuickstart(LABEL, binDir, consumer, env);
    verifyMcp(LABEL, binDir, consumer, env, version);
    verifyA2aRuntime(LABEL, consumer, env);
    // The shared verifiers record into verify-package-tarball.js's own
    // list; drain it into this script's verdict (already printed once, so
    // appended silently). Without this, their failures would print but the
    // run would still exit 0.
    failures.push(...takeSharedFailures());
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
}

/**
 * The published manifest, read from the registry -- not the repo. npm serves
 * the uploaded package.json through the packument, so these fields are the
 * release record, not a local file. Downloading the tarball itself (which
 * proves the CDN serves the exact bits npm will hand to consumers) happens
 * separately in downloadPublishedTarball.
 */
function readPublishedManifest(spec) {
  const fields = ['name', 'version', 'dependencies', 'optionalDependencies'];
  const manifest = {};
  for (const field of fields) {
    const viewed = npmViewJson(spec, field);
    if (!viewed.ok) {
      fail(`could not read published ${field} for ${spec}\n${(viewed.output || '').slice(-1000)}`);
      return null;
    }
    manifest[field] = viewed.value || (field === 'name' || field === 'version' ? null : {});
  }
  return manifest;
}

/** Download the published tarball, proving the CDN serves the exact bits. */
function downloadPublishedTarball(packDir, spec) {
  const pack = run(NPM_COMMAND, ['pack', spec, '--pack-destination', packDir], { timeoutMs: 120 * 1000 });
  if (pack.status !== 0) {
    fail(`could not download the published tarball for ${spec}\n${pack.output.slice(-2000)}`);
    return null;
  }
  const tarballName = fs.readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  if (!tarballName) {
    fail(`npm pack ${spec} produced no tarball`);
    return null;
  }
  ok(`published tarball downloads from the registry (${tarballName})`);
  return tarballName;
}

async function main() {
  const { sbom } = parseArgs(process.argv.slice(2));
  const { name, version } = pkg;
  const spec = `${name}@${version}`;
  console.log(`Verifying the published ${spec} as a registry consumer sees it.`);

  if (!sbom) {
    fail('a CycloneDX SBOM path is required (--sbom <path.cdx.json>); '
      + 'publish.yml passes the SBOM generated before the upload');
    return 1;
  }

  if (!await waitForRegistry(spec, version)) return 1;
  if (!verifyDistAttestations(spec, version)) return 1;

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-round-trip-pack-'));
  try {
    const manifest = readPublishedManifest(spec);
    if (!manifest) return 1;
    if (manifest.name !== name || manifest.version !== version) {
      fail(`published manifest is ${manifest.name}@${manifest.version}, expected ${spec}`);
      return 1;
    }
    ok(`published manifest is ${spec}`);
    if (!downloadPublishedTarball(packDir, spec)) return 1;
    verifySbomMatchesTarball(sbom, name, version, manifest);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }
  if (failures.length > 0) return 1;

  await verifyConsumer(spec, version);

  console.log('');
  if (failures.length === 0) {
    console.log(`OK: the published ${spec} installs from the registry and runs.`);
    return 0;
  }
  console.error(`FAIL: ${failures.length} problem(s) with the published ${spec}.`);
  return 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => { console.error(`FAIL: ${(error && error.stack) || error}`); process.exit(1); },
  );
}

module.exports = {};
