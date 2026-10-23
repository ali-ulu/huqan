'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function runM7Child(payload) {
  const child = spawnSync(process.execPath, [path.join(__dirname, 'cognitive-lab-m7-runtime.js'), JSON.stringify(payload)], {
    encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
  });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`M7 child failed: ${child.stderr || child.stdout}`);
  return JSON.parse(child.stdout);
}

// This is a controlled queue pilot, never a powered holdout or a production default.
function runM7Pilot({ scenario = 'repair' } = {}) {
  if (!['repair', 'denied', 'rollback'].includes(scenario)) throw new TypeError('Unknown M7 pilot scenario');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m7-pilot-'));
  try {
    const arms = Object.fromEntries(['control', 'candidate'].map(arm => [arm,
      runM7Child({ mode: 'run', arm, scenario, directory: path.join(directory, arm) })]));
    return { status: 'PILOT_ONLY', assertsGain: false, scenario,
      workload: 'fixed-plan native Coder competing with a safe internal read',
      costBoundary: 'child setup, repository, graph, approval, execution, oracle and fresh-process replay', arms };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function runM7FeedbackPilot() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m7-feedback-'));
  try {
    const arms = Object.fromEntries(['control', 'candidate', 'observationOff'].map(arm => [arm,
      runM7Child({ mode: 'feedback', arm, directory: path.join(directory, arm) })]));
    return { status: 'PILOT_ONLY', assertsGain: false, arms,
      support: 'one independent artifact; M9 arousal remains INSUFFICIENT; no holdout gain' };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function runM7ValuePilot({ scenario = 'supported' } = {}) {
  if (!['supported', 'insufficient', 'dependent', 'observationOff'].includes(scenario)) throw new TypeError('Unknown M9 scenario');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m9-value-'));
  const child = payload => {
    const run = spawnSync(process.execPath, [path.join(__dirname, 'cognitive-lab-m7-value-runtime.js'), JSON.stringify(payload)],
      { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024, windowsHide: true });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`M9 child failed: ${run.stderr || run.stdout}`);
    return JSON.parse(run.stdout);
  };
  try {
    const training = child({ directory, scenario });
    const source = { memoryPath: training.memoryPath, frame: training.frame,
      valueOptions: training.valueOptions, historyDigest: training.historyDigest };
    const arms = Object.fromEntries(['candidate', 'arousalOff', 'replay'].map(arm => [arm,
      child({ directory, scenario, training: source, arm })]));
    return { status: 'CONTROLLED_FIXTURE_ONLY', assertsGain: false, training, arms,
      boundary: 'real verify/dream output export and M9 ordering; not native Coder, task success or holdout gain' };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

module.exports = { runM7Pilot, runM7Child, runM7FeedbackPilot, runM7ValuePilot };
if (require.main === module) process.stdout.write(JSON.stringify(runM7Pilot({ scenario: process.argv[2] || 'repair' })));
