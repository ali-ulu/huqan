#!/usr/bin/env node
'use strict';

/**
 * Final release verification checklist (#2633, C7).
 *
 * This is intentionally an orchestrator, not a second implementation of the
 * package/registry checks. The local tarball proof stays in
 * verify-package-tarball.js and the published-registry proof stays in
 * verify-published-round-trip.js. This script adds the release-level facts
 * around them (tag, changelog, SBOM shape) and emits one durable verdict.
 *
 * Usage:
 *   node scripts/release-verify.js --sbom huqan-v1.2.3.cdx.json
 *   node scripts/release-verify.js --sbom ... --json release-verification.json
 *   node scripts/release-verify.js --sbom ... --tag v1.2.3   # local replay
 *
 * Exit 0 = every check passed. Exit 1 = at least one check failed.
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSyncWindowsAware } = require('./spawn-windows-aware');

const repoRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const CHANGELOG_PATH = path.join(repoRoot, 'CHANGELOG.md');
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;

function parseArgs(argv) {
  const args = { sbom: null, json: null, tag: null };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--sbom', '--json', '--tag'].includes(flag)) {
      throw new Error(`unknown argument: ${flag}`);
    }
    if (index + 1 >= argv.length) throw new Error(`${flag} requires a value`);
    args[flag.slice(2)] = argv[index + 1];
    index += 1;
  }
  return args;
}

function pass(id, label, details = {}) {
  return { id, label, status: 'pass', details };
}

function fail(id, label, message, details = {}) {
  return { id, label, status: 'fail', message, details };
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function validateVersionTag(version, { refType, refName }) {
  const label = 'Version/tag consistency';
  if (!refName) return fail('version-tag', label, 'release tag is missing');
  if (refType && refType !== 'tag') {
    return fail('version-tag', label, `release ref type is ${refType}, expected tag`, { refType, refName });
  }
  const expected = `v${version}`;
  if (refName !== expected) {
    return fail('version-tag', label, `tag ${refName} does not match package version ${version}`, {
      expected,
      actual: refName,
    });
  }
  return pass('version-tag', label, { version, tag: refName });
}

function validateChangelog(text, version) {
  const label = 'Changelog entry for version';
  const heading = new RegExp(`^##[ \\t]+v${escapeRegExp(version)}[ \\t]*$`, 'm');
  if (!heading.test(String(text))) {
    return fail('changelog', label, `CHANGELOG.md has no "## v${version}" release heading`, { version });
  }
  return pass('changelog', label, { heading: `v${version}` });
}

function decodeJsonFile(filePath) {
  const raw = fs.readFileSync(filePath);
  if (raw[0] === 0xFF && raw[1] === 0xFE) return JSON.parse(raw.subarray(2).toString('utf16le'));
  if (raw[0] === 0xFE && raw[1] === 0xFF) {
    return JSON.parse(Buffer.from(raw.subarray(2)).swap16().toString('utf16le'));
  }
  const text = raw.toString('utf8').replace(new RegExp(`^${String.fromCharCode(0xFEFF)}`), '');
  return JSON.parse(text);
}

function validateSbomFile(sbomPath, manifest = pkg) {
  const label = 'CycloneDX SBOM';
  if (!sbomPath) return fail('sbom', label, '--sbom is required');
  let sbom;
  try {
    sbom = decodeJsonFile(sbomPath);
  } catch (error) {
    return fail('sbom', label, `cannot read SBOM: ${(error && error.message) || error}`, { path: sbomPath });
  }

  if (sbom.bomFormat !== 'CycloneDX') {
    return fail('sbom', label, `bomFormat is ${JSON.stringify(sbom.bomFormat)}, expected "CycloneDX"`);
  }
  if (!Array.isArray(sbom.components) || sbom.components.length === 0) {
    return fail('sbom', label, 'CycloneDX components must be a non-empty array', {
      componentCount: Array.isArray(sbom.components) ? sbom.components.length : null,
    });
  }

  const root = sbom.metadata && sbom.metadata.component ? sbom.metadata.component : {};
  if (root.name !== manifest.name || root.version !== manifest.version) {
    return fail(
      'sbom',
      label,
      `root component is ${root.name}@${root.version}, expected ${manifest.name}@${manifest.version}`,
      { componentCount: sbom.components.length },
    );
  }

  return pass('sbom', label, {
    format: sbom.bomFormat,
    specVersion: sbom.specVersion || null,
    componentCount: sbom.components.length,
    root: `${root.name}@${root.version}`,
  });
}

function runChild(scriptName, args = []) {
  const scriptPath = path.join(repoRoot, 'scripts', scriptName);
  const started = Date.now();
  const result = spawnSyncWindowsAware(process.execPath, [scriptPath, ...args], {
    cwd: repoRoot,
    env: process.env,
    encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS,
  });
  const stdout = result.stdout || '';
  const stderr = result.stderr || '';
  if (stdout) process.stdout.write(stdout);
  if (stderr) process.stderr.write(stderr);
  const output = `${stdout}${stderr}`;
  return {
    ok: result.status === 0,
    exitCode: result.status,
    durationMs: Date.now() - started,
    output,
    diagnostic: output.slice(-4000),
    error: result.error ? String(result.error.message || result.error) : null,
  };
}

function childCheck(id, label, child, details = {}) {
  const childDetails = {
    ...details,
    exitCode: child.exitCode,
    durationMs: child.durationMs,
  };
  if (child.ok) return pass(id, label, childDetails);
  return fail(
    id,
    label,
    child.error || 'delegated verifier failed',
    { ...childDetails, diagnostic: child.diagnostic },
  );
}

function roundTripChecks(child) {
  const output = child.output || '';
  const common = { delegatedTo: 'verify-published-round-trip.js', exitCode: child.exitCode, durationMs: child.durationMs };
  const checks = [
    {
      id: 'registry-smoke',
      label: 'Registry re-download + installed smoke',
      proven: child.ok && /OK: the published .* installs from the registry and runs\./.test(output),
    },
    {
      id: 'provenance',
      label: 'Registry provenance attestation',
      proven: /provenance attestation exists on the registry/.test(output),
    },
    {
      id: 'published-sbom',
      label: 'Published manifest matches SBOM',
      proven: /SBOM covers all \d+ direct dependencies .*\(\d+ components total\)/.test(output),
    },
  ];

  return checks.map((check) => {
    if (check.proven) return pass(check.id, check.label, common);
    return fail(
      check.id,
      check.label,
      child.error || 'not proven by the registry round-trip verifier',
      { ...common, diagnostic: child.diagnostic },
    );
  });
}

function humanSummary(report) {
  const lines = [
    '',
    `Release verification: ${report.release.name}@${report.release.version} (${report.release.tag || 'no tag'})`,
  ];
  for (const check of report.checks) {
    const mark = check.status === 'pass' ? 'PASS' : 'FAIL';
    lines.push(`[${mark}] ${check.label}${check.message ? `: ${check.message}` : ''}`);
  }
  lines.push(report.ok ? 'RESULT: PASS' : 'RESULT: FAIL');
  return lines.join('\n');
}

async function main(argv = process.argv.slice(2)) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    console.error(`FAIL: ${error.message}`);
    return 1;
  }

  const tag = args.tag || process.env.GITHUB_REF_NAME || null;
  const refType = args.tag ? 'tag' : (process.env.GITHUB_REF_TYPE || null);
  const checks = [];

  checks.push(validateVersionTag(pkg.version, { refType, refName: tag }));

  try {
    checks.push(validateChangelog(fs.readFileSync(CHANGELOG_PATH, 'utf8'), pkg.version));
  } catch (error) {
    checks.push(fail('changelog', 'Changelog entry for version', `cannot read CHANGELOG.md: ${error.message}`));
  }

  checks.push(validateSbomFile(args.sbom, pkg));

  console.log('\n--- Local tarball verification ---');
  const tarball = runChild('verify-package-tarball.js');
  checks.push(childCheck('tarball', 'Packed tarball consumer test', tarball, {
    delegatedTo: 'verify-package-tarball.js',
  }));

  console.log('\n--- Published registry verification ---');
  const roundTripArgs = args.sbom ? ['--sbom', args.sbom] : [];
  const roundTrip = runChild('verify-published-round-trip.js', roundTripArgs);
  checks.push(...roundTripChecks(roundTrip));

  const report = {
    schema: 'huqan.release-verification/v1',
    generatedAt: new Date().toISOString(),
    release: { name: pkg.name, version: pkg.version, tag },
    ok: checks.every((check) => check.status === 'pass'),
    checks,
  };

  console.log(humanSummary(report));
  console.log('\nStructured JSON:');
  console.log(JSON.stringify(report, null, 2));

  if (args.json) {
    fs.writeFileSync(args.json, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`Wrote release verification report to ${args.json}`);
  }

  return report.ok ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`FAIL: ${(error && error.stack) || error}`);
      process.exit(1);
    },
  );
}

module.exports = {
  humanSummary,
  parseArgs,
  roundTripChecks,
  validateChangelog,
  validateSbomFile,
  validateVersionTag,
};
