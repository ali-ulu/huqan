'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  humanSummary,
  parseArgs,
  roundTripChecks,
  validateChangelog,
  validateSbomFile,
  validateVersionTag,
} = require('../scripts/release-verify');

test('release arguments are explicit and deterministic', () => {
  assert.deepEqual(
    parseArgs(['--sbom', 'release.cdx.json', '--json', 'report.json', '--tag', 'v1.2.3']),
    { sbom: 'release.cdx.json', json: 'report.json', tag: 'v1.2.3' },
  );
  assert.throws(() => parseArgs(['--unknown', 'x']), /unknown argument/);
  assert.throws(() => parseArgs(['--sbom']), /requires a value/);
});

test('version/tag consistency requires the exact immutable release tag', () => {
  assert.equal(validateVersionTag('1.2.3', { refType: 'tag', refName: 'v1.2.3' }).status, 'pass');
  assert.equal(validateVersionTag('1.2.3', { refType: 'branch', refName: 'main' }).status, 'fail');
  assert.equal(validateVersionTag('1.2.3', { refType: 'tag', refName: 'v1.2.4' }).status, 'fail');
  assert.equal(validateVersionTag('1.2.3', { refType: null, refName: null }).status, 'fail');
});

test('changelog check requires a version heading, not a prose mention', () => {
  assert.equal(validateChangelog('# Changelog\n\n## v1.2.3\n\nReleased.\n', '1.2.3').status, 'pass');
  assert.equal(validateChangelog('# Changelog\n\n## Unreleased\n\nPreparing v1.2.3.\n', '1.2.3').status, 'fail');
  assert.equal(validateChangelog('# Changelog\n\n## v1x2x3\n', '1.2.3').status, 'fail');
});

test('SBOM check requires CycloneDX, a non-empty component list, and the release root', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-release-verify-'));
  const manifest = { name: 'huqan', version: '1.2.3' };
  try {
    const good = path.join(dir, 'good.cdx.json');
    fs.writeFileSync(good, JSON.stringify({
      bomFormat: 'CycloneDX',
      specVersion: '1.6',
      metadata: { component: { name: 'huqan', version: '1.2.3' } },
      components: [{ name: 'dep', version: '1.0.0' }],
    }));
    const result = validateSbomFile(good, manifest);
    assert.equal(result.status, 'pass');
    assert.equal(result.details.componentCount, 1);

    const empty = path.join(dir, 'empty.cdx.json');
    fs.writeFileSync(empty, JSON.stringify({
      bomFormat: 'CycloneDX',
      metadata: { component: { name: 'huqan', version: '1.2.3' } },
      components: [],
    }));
    assert.equal(validateSbomFile(empty, manifest).status, 'fail');

    const wrongRoot = path.join(dir, 'wrong-root.cdx.json');
    fs.writeFileSync(wrongRoot, JSON.stringify({
      bomFormat: 'CycloneDX',
      metadata: { component: { name: 'huqan', version: '9.9.9' } },
      components: [{ name: 'dep' }],
    }));
    assert.equal(validateSbomFile(wrongRoot, manifest).status, 'fail');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('round-trip output is split into registry, provenance, and published-SBOM evidence', () => {
  const output = [
    '  ok: provenance attestation exists on the registry',
    '  ok: SBOM covers all 5 direct dependencies of the published manifest (42 components total)',
    'OK: the published huqan@1.2.3 installs from the registry and runs.',
  ].join('\n');
  const checks = roundTripChecks({ ok: true, exitCode: 0, durationMs: 12, output, diagnostic: '' });
  assert.deepEqual(checks.map((check) => [check.id, check.status]), [
    ['registry-smoke', 'pass'],
    ['provenance', 'pass'],
    ['published-sbom', 'pass'],
  ]);

  const failed = roundTripChecks({
    ok: false,
    exitCode: 1,
    durationMs: 5,
    output: 'FAIL: provenance missing',
    diagnostic: 'FAIL: provenance missing',
  });
  assert.ok(failed.every((check) => check.status === 'fail'));
});

test('human summary contains one verdict per check and an overall result', () => {
  const report = {
    release: { name: 'huqan', version: '1.2.3', tag: 'v1.2.3' },
    ok: false,
    checks: [
      { status: 'pass', label: 'Version/tag consistency' },
      { status: 'fail', label: 'CycloneDX SBOM', message: 'empty' },
    ],
  };
  const summary = humanSummary(report);
  assert.match(summary, /\[PASS\] Version\/tag consistency/);
  assert.match(summary, /\[FAIL\] CycloneDX SBOM: empty/);
  assert.match(summary, /RESULT: FAIL/);
});

test('publish workflow uses release-verify.js as the final real-publish gate and preserves its JSON report', () => {
  const workflow = fs.readFileSync(path.join(__dirname, '..', '.github', 'workflows', 'publish.yml'), 'utf8');
  const publish = workflow.indexOf('- name: Publish');
  const releaseVerify = workflow.indexOf('- name: Verify the complete release checklist');
  const dryRun = workflow.indexOf('- name: Dry run complete');

  assert.ok(publish > -1, 'Publish step missing');
  assert.ok(releaseVerify > publish, 'release verifier must run after Publish');
  assert.ok(dryRun > releaseVerify, 'release verifier must be the final real-publish gate');
  assert.match(
    workflow.slice(releaseVerify, dryRun),
    /node scripts\/release-verify\.js --sbom .* --json /,
  );
  assert.match(workflow, /name: release-verification-report/);
});
