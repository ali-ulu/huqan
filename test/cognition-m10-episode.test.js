'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildM10Corpus, sha256 } = require('../lib/cognitive-lab-m10-corpus');
const { runM10Episode } = require('../lib/cognitive-lab-m10-episode');
const {
  runM10Lab, MANIFEST_FILE, REPORT_FILE, PREREGISTRATION_DIGEST,
} = require('../lib/cognitive-lab-m10-runner');
const { runCognitiveLab } = require('../lib/cognitive-lab-cli');

const corpus = buildM10Corpus();
const group = corpus.groups.find((item) => item.split === 'holdout');

test('the frozen preregistration digest names the committed document', () => {
  const file = path.join(__dirname, '..', 'docs', 'task-packs', 'cog-m10-curiosity-preregistration-20261030.md');
  const document = fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n');
  assert.equal(sha256(document), PREREGISTRATION_DIGEST);
});

test('an episode runs the real dream→verify path deterministically for both arms', () => {
  const candidate = runM10Episode({ group, history: corpus.monitoringHistory, arm: 'candidate' });
  const control = runM10Episode({ group, history: corpus.monitoringHistory, arm: 'control' });
  assert.deepEqual(runM10Episode({ group, history: corpus.monitoringHistory, arm: 'candidate' }), candidate);
  assert.deepEqual(runM10Episode({ group, history: corpus.monitoringHistory, arm: 'control' }), control);
  assert.equal(candidate.attempted, 3);
  assert.equal(control.attempted, 3);
  assert.equal(candidate.blockedSteps, 0);
  assert.equal(control.blockedSteps, 0);
  assert.equal(candidate.curiosityStatus, 'MEASURED');
  assert.equal(control.curiosityStatus, null);
  // The curiosity arm promotes the improving region; the control arm keeps the
  // confidence order and can select the flat region.
  assert.ok(candidate.attempts.every((attempt) => attempt.region === 'yapabilir'));
  assert.ok(control.attempts.some((attempt) => attempt.region !== 'yapabilir'));
  for (const attempt of [...candidate.attempts, ...control.attempts]) {
    assert.ok(['verified', 'contradicted', 'unknown'].includes(attempt.status));
  }
});

test('the runner freezes the manifest before the holdout and refuses a second run', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m10-lab-'));
  try {
    const report = runM10Lab({ workDir, splitSizes: { monitor: 2, calibration: 4, holdout: 4 } });
    const manifest = JSON.parse(fs.readFileSync(path.join(workDir, MANIFEST_FILE), 'utf8'));
    assert.equal(manifest.schemaVersion, 'huqan-m10-manifest-v1');
    assert.ok(manifest.nRequired >= 24, 'the preregistered floor is a minimum, not a fixed count');
    assert.match(manifest.corpusDigest, /^[0-9a-f]{64}$/);
    assert.match(manifest.groupDigest, /^[0-9a-f]{64}$/);
    assert.match(manifest.monitoringProbeDigest, /^[0-9a-f]{64}$/);
    assert.match(manifest.preregistrationDigest, /^[0-9a-f]{64}$/);
    assert.equal(report.label, 'INSUFFICIENT');
    assert.deepEqual(report.reasons, ['paired_groups_below_required']);
    assert.equal(report.coverage.paired, 4);
    assert.equal(report.assertsGain, false);
    assert.equal(report.blockedSteps, 0);
    assert.equal(report.calibration.groups, 4);
    assert.ok(fs.existsSync(path.join(workDir, REPORT_FILE)));
    assert.throws(() => runM10Lab({ workDir, splitSizes: { monitor: 2, calibration: 4, holdout: 4 } }), /M10_MANIFEST_EXISTS/);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('a calibration split that cannot estimate sigma fails closed before the manifest', () => {
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m10-lab-'));
  try {
    assert.throws(() => runM10Lab({ workDir, splitSizes: { monitor: 2, calibration: 1, holdout: 2 } }),
      /M10_CALIBRATION_TOO_SMALL/);
    assert.equal(fs.existsSync(path.join(workDir, MANIFEST_FILE)), false);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
});

test('the Lab CLI exposes the m10 subcommand without touching the state-store paths', async () => {
  const help = await runCognitiveLab(['--help']);
  assert.ok(help.usage.some((line) => line.includes('m10 --m10-workdir DIR')));
  assert.match(help.commands.m10, /assertsGain=false/);
  await assert.rejects(() => runCognitiveLab(['m10']), /expected m10 --m10-workdir DIR/);
});
