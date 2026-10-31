'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildM4Corpus, sha256, NOW } = require('../lib/cognitive-lab-m4-corpus');
const { runM4Episode } = require('../lib/cognitive-lab-m4-episode');
const { evaluateM4 } = require('../lib/cognitive-lab-m4-evaluator');
const {
  runM4Lab, MANIFEST_FILE, REPORT_FILE, PREREGISTRATION_DIGEST,
} = require('../lib/cognitive-lab-m4-runner');
const { runCognitiveLab } = require('../lib/cognitive-lab-cli');

const corpus = buildM4Corpus();
const group = corpus.groups.find((item) => item.split === 'holdout' && item.risk);

test('the frozen preregistration digest names the committed document', () => {
  const file = path.join(__dirname, '..', 'docs', 'task-packs', 'cog-m4-retention-preregistration-20261031.md');
  const document = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(sha256(document), PREREGISTRATION_DIGEST);
});

test('an episode runs the real consolidate/archive path deterministically for both arms', () => {
  const candidate = runM4Episode({ group, arm: 'candidate' });
  const control = runM4Episode({ group, arm: 'control' });
  assert.deepEqual(runM4Episode({ group, arm: 'candidate' }), candidate);
  assert.deepEqual(runM4Episode({ group, arm: 'control' }), control);

  // The candidate arm forgets the group's old, unimportant records (junk + the
  // risk record); the control arm keeps the default superseded-only selector,
  // which matches nothing here.
  assert.equal(candidate.retentionEnabled, true);
  assert.equal(candidate.archived, 5);
  assert.equal(candidate.restoreFailures, 0);
  assert.equal(control.archived, 0);
  assert.equal(control.restoreFailures, 0);
  assert.ok(candidate.readSetSize < control.readSetSize);
  // Every archived record restores, so the run is reversible.
  assert.equal(candidate.refused, 0);
  // The risk record is a query target the candidate arm archived: the wrong
  // forgetting the restore rate measures.
  assert.equal(candidate.neededArchived, 1);
  assert.equal(candidate.recallK, 3);
  // The candidate arm loses the risk query; the control arm keeps every hit.
  assert.ok(candidate.recallHits < control.recallHits);
});

test('the runner freezes the manifest before the holdout, refuses a second run, and reports GAIN', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m4-lab-'));
  try {
    const report = runM4Lab({ workDir });
    const manifest = JSON.parse(fs.readFileSync(path.join(workDir, MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.schemaVersion, 'huqan-m4-manifest-v1');
    assert.equal(manifest.now, NOW);
    assert.equal(manifest.recallK, 3);
    assert.ok(manifest.nRequired >= 24, 'the preregistered floor is a minimum, not a fixed count');
    assert.match(manifest.corpusDigest, /^[0-9a-f]{64}$/);
    assert.match(manifest.groupDigest, /^[0-9a-f]{64}$/);
    assert.equal(manifest.preregistrationDigest, PREREGISTRATION_DIGEST);
    assert.equal(report.label, 'GAIN');
    assert.ok(report.recall.lower > -report.margin, 'recall is non-inferior');
    assert.ok(report.shrink.mean > 0, 'the default read set shrank');
    assert.ok(report.restoreRate <= report.restoreRateMax);
    assert.equal(report.assertsGain, false);
    assert.equal(report.calibration.groups, manifest.splitSizes.calibration);
    assert.ok(fs.existsSync(path.join(workDir, REPORT_FILE)));
    assert.throws(() => runM4Lab({ workDir }), /M4_MANIFEST_EXISTS/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('a calibration split that cannot estimate sigma fails closed before the manifest', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m4-lab-'));
  try {
    assert.throws(() => runM4Lab({ workDir, splitSizes: { calibration: 1, holdout: 4 } }),
      /M4_CALIBRATION_TOO_SMALL/);
    assert.equal(fs.existsSync(path.join(workDir, MANIFEST_FILE)), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('a spent work directory is refused before a fresh manifest is written', () => {
  // A report left without its manifest (interrupted cleanup, manual delete)
  // would otherwise let the run write a manifest and then fail on the
  // exclusive report write, stranding a manifest that refuses every retry.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m4-lab-'));
  try {
    fs.writeFileSync(path.join(workDir, REPORT_FILE), '{}');
    assert.throws(() => runM4Lab({ workDir }), /M4_REPORT_EXISTS/);
    assert.equal(fs.existsSync(path.join(workDir, MANIFEST_FILE)), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the Lab CLI exposes the m4 subcommand without touching the state-store paths', async () => {
  const help = await runCognitiveLab(['--help']);
  assert.ok(help.usage.some((line) => line.includes('m4 --m4-workdir DIR')));
  assert.match(help.commands.m4, /assertsGain=false/);
  await assert.rejects(() => runCognitiveLab(['m4']), /expected m4 --m4-workdir DIR/);
});

test('the real CLI produces byte-identical reports across two runs (§9.2)', async () => {
  const first = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m4-cli-'));
  const second = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m4-cli-'));
  try {
    await runCognitiveLab(['m4', '--m4-workdir', first]);
    await runCognitiveLab(['m4', '--m4-workdir', second]);
    assert.equal(fs.readFileSync(path.join(first, REPORT_FILE), 'utf8'),
      fs.readFileSync(path.join(second, REPORT_FILE), 'utf8'));
    assert.equal(fs.readFileSync(path.join(first, MANIFEST_FILE), 'utf8'),
      fs.readFileSync(path.join(second, MANIFEST_FILE), 'utf8'));
  } finally {
    fs.rmSync(first, { recursive: true, force: true });
    fs.rmSync(second, { recursive: true, force: true });
  }
});

test('the holdout is isolated: a calibration group and a tampered digest are rejected (§9.3)', () => {
  const manifest = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'cognitive-lab', 'm4-retention-result-20261031.json'), 'utf8'));
  assert.ok(manifest.recall && manifest.shrink && manifest.restoreRate !== undefined);
  assert.equal(manifest.assertsGain, false);
  assert.equal(manifest.intelligenceGain, 'NOT_MEASURED');
  // The recorded result names the exact corpus and preregistration it was locked to.
  assert.equal(manifest.corpusDigest, corpus.corpusDigest);
  assert.equal(manifest.groupDigest, corpus.groupDigest);
  assert.equal(manifest.preregistrationDigest, PREREGISTRATION_DIGEST);

  // Isolation is enforced by evaluateM4, not merely implied by the digests: a
  // calibration group smuggled into the holdout arm and a changed groupDigest
  // must both come back as REJECT with the matching reason.
  const base = { seed: corpus.seed, preregistrationDigest: PREREGISTRATION_DIGEST, recallK: corpus.recallK,
    corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest, nRequired: 24 };
  const integrity = { firewallBypass: 0, approvalBypass: 0 };
  const leakedGroup = corpus.groups.find((item) => item.split === 'calibration').sourceGroup;
  const leaked = { sourceGroup: leakedGroup, readSetSize: 1, queries: 1, recallHits: 1,
    archived: 0, neededArchived: 0, restoreFailures: 0 };
  assert.deepEqual(evaluateM4({ corpus, manifest: base, integrity, executions: { candidate: [leaked], control: [] } }).reasons,
    ['candidate:group_not_in_holdout']);
  assert.deepEqual(evaluateM4({ corpus, manifest: { ...base, groupDigest: 'deadbeef' }, integrity,
    executions: { candidate: [], control: [] } }).reasons, ['group_digest_mismatch']);
});

test('disabling the candidate archive collapses the effect to shrink 0 (§9.4)', () => {
  // With the archive step neutralised the candidate arm equals the control arm,
  // so the measured shrink must be zero and the run cannot report GAIN.
  const holdout = corpus.groups.filter((item) => item.split === 'holdout');
  const executions = { candidate: [], control: [] };
  for (const item of holdout) {
    const record = runM4Episode({ group: item, arm: 'control' });
    executions.candidate.push({ ...record, arm: 'candidate' });
    executions.control.push(record);
  }
  const report = evaluateM4({
    corpus,
    manifest: { seed: corpus.seed, preregistrationDigest: PREREGISTRATION_DIGEST, recallK: corpus.recallK,
      corpusDigest: corpus.corpusDigest, groupDigest: corpus.groupDigest, nRequired: 24 },
    executions,
    integrity: { firewallBypass: 0, approvalBypass: 0 },
  });
  assert.equal(report.shrink.mean, 0);
  assert.equal(report.label, 'NOT_CLEARED');
  assert.ok(report.reasons.includes('read_set_did_not_shrink'));
});
