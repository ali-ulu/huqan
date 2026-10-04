#!/usr/bin/env node
'use strict';

/**
 * Read-only CI cost breakdown for issue #3502 (R48 E5, OLCUM-ONCE dilimi).
 *
 * MEASUREMENT FIRST: this script changes nothing -- no workflow edits, no
 * check renames/removals, no skip/matrix/cache changes. It reads one
 * `benchmark.yml` run's job list (`gh api .../runs/<id>/jobs`), optionally
 * the impact plan and the shard timing sidecars/JUnit that run uploaded,
 * and writes a JSON report separating per job: queue-wait (started_at minus
 * run created_at), setup, test, upload. It names the slowest job, the wall
 * determinants, the runner-seconds sum, first-feedback vs total, shard p50.
 * Runner-seconds are summed job walls (overlap included): NO CPU-second,
 * billing, or savings claim.
 *
 * Usage:
 *   node scripts/ci-cost-breakdown.js --jobs=jobs.json --run-created=<ISO>
 *     [--run-id=<id> --head-sha=<sha> --event=<event> --run-updated=<ISO>]
 *     [--impact-plan=<path>] [--timings=<dir>] [--output=<path>]
 * `--jobs=-` reads stdin; without `--output` the report goes to stdout.
 * Exit 0 on success, 2 on usage/input errors.
 */

const fs = require('node:fs');
const path = require('node:path');

const REPORT_VERSION = 'huqan.ci-cost-breakdown.v1';

// Steps that prepare the runner or fetch inputs: checkout, the baseline dance
// the shard jobs need for live Git validation, the toolchain, dependencies,
// and the impact-plan artifact reuse. Order matters: tested before UPLOAD.
const SETUP_PATTERNS = [
  /set up job/i,
  /checkout@/i,
  /fetch baseline/i,
  /pin the baseline/i,
  /name checked-out/i,
  /materialize .*baseline/i,
  /setup-node@/i,
  /npm ci/i,
  /install chromium/i,
  /impact plan artifact/i,
  /download .*impact plan/i,
  /back off/i,
  /retry impact/i,
];

// Steps that execute the measured work: the shard runner, the c8 measurement,
// the benchmark and soak passes, the ratchet, classification and planning.
const TEST_PATTERNS = [
  /run selected weighted test shard/i,
  /measure .*c8/i,
  /run benchmark/i,
  /check regression/i,
  /observability/i,
  /enforce .*ratchet/i,
  /classify changed files/i,
  /generate .*impact plan/i,
  /fast contract/i,
  /package-closure/i,
  /build docker image/i,
  /docker runtime smoke/i,
  /run the full 10k/i,
  /check the pinned/i,
  /file or update/i,
  /regenerate/i,
];

const UPLOAD_PATTERNS = [/upload/i, /publish/i];

/**
 * Which cost bucket a CI step belongs to. Skipped steps and steps without
 * timestamps cost nothing; the bucket only matters for steps with duration.
 */
function classifyStep(name) {
  const stepName = String(name || '');
  if (SETUP_PATTERNS.some((pattern) => pattern.test(stepName))) return 'setup';
  if (TEST_PATTERNS.some((pattern) => pattern.test(stepName))) return 'test';
  if (UPLOAD_PATTERNS.some((pattern) => pattern.test(stepName))) return 'upload';
  return 'other';
}

function secondsBetween(startIso, endIso) {
  const start = new Date(startIso).getTime();
  const end = new Date(endIso).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 0;
  return Math.max(0, (end - start) / 1000);
}

function stepSeconds(step) {
  if (!step || step.conclusion === 'skipped') return 0;
  if (!step.started_at || !step.completed_at) return 0;
  return secondsBetween(step.started_at, step.completed_at);
}

/** Median of a non-empty numeric array. */
function percentile(values, rank) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(rank * sorted.length) - 1));
  return sorted[index];
}

function summarizeJob(job, runCreatedMs) {
  const buckets = { setup: 0, test: 0, upload: 0, other: 0 };
  for (const step of job.steps || []) {
    buckets[classifyStep(step.name)] += stepSeconds(step);
  }
  const durationSeconds = secondsBetween(job.started_at, job.completed_at);
  const startedMs = new Date(job.started_at).getTime();
  const queueSeconds = Number.isFinite(startedMs) && Number.isFinite(runCreatedMs)
    ? Math.max(0, (startedMs - runCreatedMs) / 1000)
    : 0;
  const accounted = buckets.setup + buckets.test + buckets.upload + buckets.other;
  return {
    name: job.name,
    conclusion: job.conclusion,
    runner: job.runner_name || null,
    durationSeconds: round(durationSeconds),
    queueSeconds: round(queueSeconds),
    setupSeconds: round(buckets.setup),
    testSeconds: round(buckets.test),
    uploadSeconds: round(buckets.upload),
    otherSeconds: round(buckets.other),
    gapSeconds: round(Math.max(0, durationSeconds - accounted)),
  };
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function parseShardIdentity(name) {
  const match = /,\s*([^,]+),\s*Node (\d+),\s*shard (\d+)\s*\)?\s*$/.exec(String(name || ''));
  if (!match) return null;
  return { os: match[1], node: match[2], shard: Number(match[3]) };
}

/**
 * Per-file wall times from a directory of shard timing evidence. Accepts the
 * `*-failures.json` sidecars `run-test-shard.js` writes (a `timings` map) and
 * plain JUnit XML files (top-level testsuite name/time attributes). Missing or
 * unreadable inputs yield null so a jobs-only report still works.
 */
function summarizeTimings(directory) {
  if (!directory) return null;
  let entries;
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const perFile = new Map();
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.join(directory, entry.name);
    if (entry.name.endsWith('-failures.json')) {
      try {
        const parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
        for (const [file, seconds] of Object.entries(parsed.timings || {})) {
          if (typeof seconds !== 'number' || !(seconds >= 0)) continue;
          if (!perFile.has(file)) perFile.set(file, []);
          perFile.get(file).push(seconds);
        }
      } catch {
        continue;
      }
    } else if (entry.name.endsWith('.xml')) {
      try {
        const xml = fs.readFileSync(full, 'utf8');
        const suitePattern = /<testsuite\b[^>]*>/g;
        let suiteMatch;
        while ((suiteMatch = suitePattern.exec(xml)) !== null) {
          const tag = suiteMatch[0];
          const name = /name="([^"]+)"/.exec(tag);
          const time = /time="([^"]+)"/.exec(tag);
          if (!name || !time) continue;
          const seconds = Number(time[1]);
          if (!Number.isFinite(seconds) || seconds < 0) continue;
          if (!perFile.has(name[1])) perFile.set(name[1], []);
          perFile.get(name[1]).push(seconds);
        }
      } catch {
        continue;
      }
    }
  }
  if (perFile.size === 0) return null;
  const medians = [...perFile.entries()].map(([file, samples]) => ({
    file,
    medianSeconds: round(percentile(samples, 0.5)),
    samples: samples.length,
  }));
  medians.sort((a, b) => b.medianSeconds - a.medianSeconds);
  return {
    files: medians.length,
    slowestFile: medians[0],
    p50FileSeconds: round(percentile(medians.map((row) => row.medianSeconds), 0.5)),
  };
}

function summarizeImpactPlan(planPath) {
  if (!planPath) return null;
  try {
    const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
    return {
      mode: plan.mode || null,
      runTests: Boolean(plan.runTests),
      fullSuite: Boolean(plan.fullSuite),
      selectedTests: typeof plan.selectedTestCount === 'number' ? plan.selectedTestCount : null,
      knownTests: typeof plan.knownTestCount === 'number' ? plan.knownTestCount : null,
      matchedImpactRules: Array.isArray(plan.matchedImpactRules) ? plan.matchedImpactRules : [],
    };
  } catch {
    return null;
  }
}

function loadJobs(jobsPath, readStdin) {
  const raw = jobsPath === '-' ? readStdin() : fs.readFileSync(jobsPath, 'utf8');
  const parsed = JSON.parse(raw);
  const jobs = Array.isArray(parsed) ? parsed : parsed.jobs;
  if (!Array.isArray(jobs)) throw new Error(`no job list found in ${jobsPath}`);
  return jobs;
}

function parseArgs(argv) {
  const options = {
    jobs: null, runCreated: null, runUpdated: null, runId: null, headSha: null,
    event: null, impactPlan: null, timings: null, output: null,
  };
  for (const arg of argv) {
    if (arg === '--help') return { ...options, help: true };
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, rawKey, value] = match;
    const key = rawKey.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (!(key in options)) throw new Error(`unsupported argument: ${arg}`);
    options[key] = value;
  }
  if (!options.jobs) throw new Error('missing required --jobs=<path> (use - for stdin)');
  if (!options.runCreated) throw new Error('missing required --run-created=<ISO timestamp>');
  if (Number.isNaN(new Date(options.runCreated).getTime())) {
    throw new Error(`invalid --run-created timestamp: ${options.runCreated}`);
  }
  return options;
}

function buildReport(inputs) {
  const runCreatedMs = new Date(inputs.runCreated).getTime();
  const runUpdatedMs = inputs.runUpdated ? new Date(inputs.runUpdated).getTime() : NaN;
  const jobs = inputs.jobs.map((job) => summarizeJob(job, runCreatedMs));
  const measured = jobs.filter((job) => job.conclusion !== 'skipped');
  const byConclusion = {};
  for (const job of jobs) {
    byConclusion[job.conclusion || 'unknown'] = (byConclusion[job.conclusion || 'unknown'] || 0) + 1;
  }
  const slowestJob = measured.length > 0
    ? measured.reduce((a, b) => (b.durationSeconds > a.durationSeconds ? b : a))
    : null;
  const sums = { queue: 0, setup: 0, test: 0, upload: 0, other: 0, gap: 0, duration: 0 };
  const endedAt = new Map(inputs.jobs.map((job) => [job.name, new Date(job.completed_at).getTime()]));
  for (const job of measured) {
    sums.queue += job.queueSeconds;
    sums.setup += job.setupSeconds;
    sums.test += job.testSeconds;
    sums.upload += job.uploadSeconds;
    sums.other += job.otherSeconds;
    sums.gap += job.gapSeconds;
    sums.duration += job.durationSeconds;
  }
  const finished = measured.filter((job) => job.conclusion === 'success' || job.conclusion === 'failure');
  const firstFeedback = finished.length > 0
    ? finished.reduce((a, b) => (endedAt.get(b.name) < endedAt.get(a.name) ? b : a))
    : null;
  const wallDeterminants = Number.isFinite(runUpdatedMs)
    ? measured
      .filter((job) => Number.isFinite(endedAt.get(job.name)) && endedAt.get(job.name) >= runUpdatedMs - 120_000)
      .map((job) => job.name)
      .sort()
    : [];
  const shardDurations = measured
    .filter((job) => parseShardIdentity(job.name) !== null)
    .map((job) => ({ name: job.name, durationSeconds: job.durationSeconds }))
    .sort((a, b) => a.durationSeconds - b.durationSeconds);
  const shardSeconds = shardDurations.map((row) => row.durationSeconds);
  const wallSeconds = inputs.runUpdated ? round(secondsBetween(inputs.runCreated, inputs.runUpdated)) : null;
  return {
    version: REPORT_VERSION,
    generatedAt: new Date().toISOString(),
    scope: 'Measurement only (issue #3502, OLCM-ONCE dilimi). '
      + 'Runner-seconds are summed job walls with parallel overlap included; '
      + 'they are not CPU-seconds and imply no billing or savings claim.',
    source: {
      repository: 'ali-ulu/huqan',
      runId: inputs.runId,
      headSha: inputs.headSha,
      event: inputs.event,
      runCreated: inputs.runCreated,
      runUpdated: inputs.runUpdated || null,
      wallSeconds,
    },
    jobs: { total: jobs.length, measured: measured.length, byConclusion },
    slowestJob,
    wallDeterminants,
    runnerSumSeconds: round(sums.duration),
    bucketSums: {
      queueSeconds: round(sums.queue),
      setupSeconds: round(sums.setup),
      testSeconds: round(sums.test),
      uploadSeconds: round(sums.upload),
      otherSeconds: round(sums.other),
      gapSeconds: round(sums.gap),
    },
    firstFeedback: firstFeedback
      ? {
        job: firstFeedback.name,
        completedAfterSeconds: round(Math.max(0, (endedAt.get(firstFeedback.name) - runCreatedMs) / 1000)),
        wallSeconds,
      }
      : null,
    shards: shardDurations.length > 0
      ? {
        count: shardDurations.length,
        minSeconds: shardSeconds[0],
        p50Seconds: round(percentile(shardSeconds, 0.5)),
        maxSeconds: shardSeconds[shardSeconds.length - 1],
        slowestShard: shardDurations[shardDurations.length - 1].name,
      }
      : null,
    impactPlan: summarizeImpactPlan(inputs.impactPlan),
    timings: summarizeTimings(inputs.timings),
    perJob: jobs,
  };
}

const HELP = `ci-cost-breakdown: read-only CI cost measurement for issue #3502.

Usage:
  node scripts/ci-cost-breakdown.js --jobs=<path|-> --run-created=<ISO>
    [--run-id=<id> --head-sha=<sha> --event=<event> --run-updated=<ISO>]
    [--impact-plan=<path>] [--timings=<dir>] [--output=<path>]

Behavior change: none. This script never edits workflows, checks, matrices,
or caches; it only reads one run's job list and writes the report.
`;

function main(argv, { readStdin, writeStdout, writeFile } = {}) {
  const options = parseArgs(argv);
  if (options.help) {
    (writeStdout || process.stdout.write.bind(process.stdout))(HELP);
    return 0;
  }
  const jobs = loadJobs(options.jobs, readStdin || (() => fs.readFileSync(0, 'utf8')));
  const report = buildReport({
    jobs,
    runCreated: options.runCreated,
    runUpdated: options.runUpdated || null,
    runId: options.runId,
    headSha: options.headSha,
    event: options.event,
    impactPlan: options.impactPlan,
    timings: options.timings,
  });
  const text = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output) {
    (writeFile || fs.writeFileSync)(options.output, text);
  } else {
    (writeStdout || process.stdout.write.bind(process.stdout))(text);
  }
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`ci-cost-breakdown: ${error.message}\n`);
    process.exitCode = 2;
  }
}

module.exports = {
  REPORT_VERSION,
  classifyStep,
  summarizeJob,
  summarizeTimings,
  summarizeImpactPlan,
  buildReport,
  parseArgs,
  main,
};
