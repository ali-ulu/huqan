'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const path = require('node:path');

const BASELINE_PATH = path.join('config', 'mutation-baseline.json');
const DETECTED_STATUSES = new Set(['Killed', 'Timeout', 'RuntimeError', 'CompileError']);
const UNDETECTED_STATUSES = new Set(['Survived', 'NoCoverage']);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizePath(value) {
  return String(value).replaceAll('\\', '/').replace(/^\.\//, '');
}

function validateBaseline(baseline) {
  if (!baseline || baseline.schemaVersion !== 1 || !Number.isFinite(baseline.minimumScore)) {
    throw new Error('mutation baseline has an unsupported schema');
  }
  if (!baseline.files || typeof baseline.files !== 'object' || Array.isArray(baseline.files)) {
    throw new Error('mutation baseline must define a files object');
  }
  if (baseline.minimumScore < 0 || baseline.minimumScore > 100) {
    throw new Error('mutation baseline minimumScore must be between 0 and 100');
  }
  for (const [file, score] of Object.entries(baseline.files)) {
    if (!file || !Number.isFinite(score) || score < baseline.minimumScore || score > 100) {
      throw new Error(`invalid mutation baseline score for ${file}`);
    }
  }
  return baseline;
}

function scoreMutants(mutants) {
  let detected = 0;
  let total = 0;
  for (const mutant of mutants || []) {
    const status = mutant && mutant.status;
    if (DETECTED_STATUSES.has(status)) {
      detected += 1;
      total += 1;
    } else if (UNDETECTED_STATUSES.has(status)) {
      total += 1;
    }
  }
  return total === 0 ? null : (detected / total) * 100;
}

function reportFiles(report) {
  if (!report || !report.files || typeof report.files !== 'object') {
    throw new Error('mutation report does not contain a files object');
  }
  const normalized = new Map();
  for (const [file, entry] of Object.entries(report.files)) {
    normalized.set(normalizePath(file), entry);
  }
  return normalized;
}

function checkReport(report, baseline, { allowPartial = false } = {}) {
  validateBaseline(baseline);
  const files = reportFiles(report);
  const failures = [];
  const measured = [];

  for (const [file, baselineScore] of Object.entries(baseline.files)) {
    const normalizedFile = normalizePath(file);
    const entry = files.get(normalizedFile);
    if (!entry) {
      if (!allowPartial) failures.push(`${file}: missing from mutation report`);
      continue;
    }
    const score = scoreMutants(entry.mutants);
    if (score === null) {
      failures.push(`${file}: mutation report contains no scored mutants`);
      continue;
    }
    const required = Math.max(baseline.minimumScore, baselineScore);
    measured.push({ file, score, required });
    if (score + Number.EPSILON < required) {
      failures.push(`${file}: ${score.toFixed(2)}% < required ${required.toFixed(2)}%`);
    }
  }

  if (allowPartial && measured.length === 0) {
    failures.push('partial mutation report did not contain any baseline target file');
  }

  return { failures, measured };
}

function checkBaselineRatchet(current, previous) {
  validateBaseline(current);
  validateBaseline(previous);
  const failures = [];

  if (current.minimumScore < previous.minimumScore) {
    failures.push(`minimumScore decreased: ${previous.minimumScore} -> ${current.minimumScore}`);
  }

  for (const [file, previousScore] of Object.entries(previous.files)) {
    if (!(file in current.files)) {
      failures.push(`${file}: removed from mutation baseline`);
      continue;
    }
    const currentScore = current.files[file];
    if (currentScore < previousScore) {
      failures.push(`${file}: baseline decreased: ${previousScore} -> ${currentScore}`);
    }
  }

  return failures;
}

function parseArgs(argv) {
  const args = { allowPartial: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--report') args.report = argv[++index];
    else if (value === '--baseline') args.baseline = argv[++index];
    else if (value === '--against-ref') args.againstRef = argv[++index];
    else if (value === '--allow-partial') args.allowPartial = true;
    else throw new Error(`unknown argument: ${value}`);
  }
  return args;
}

function baselineFromGitRef(ref) {
  execFileSync('git', ['rev-parse', '--verify', ref], { stdio: 'pipe' });
  try {
    const raw = execFileSync('git', ['show', `${ref}:${BASELINE_PATH}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const baselinePath = args.baseline || BASELINE_PATH;
  const currentBaseline = validateBaseline(readJson(baselinePath));
  let failures = [];

  if (args.againstRef) {
    const previousBaseline = baselineFromGitRef(args.againstRef);
    if (previousBaseline === null) {
      process.stdout.write(`No prior mutation baseline at ${args.againstRef}; treating this as bootstrap.\n`);
    } else {
      failures.push(...checkBaselineRatchet(currentBaseline, validateBaseline(previousBaseline)));
    }
  }

  if (args.report) {
    const result = checkReport(readJson(args.report), currentBaseline, { allowPartial: args.allowPartial });
    failures.push(...result.failures);
    for (const item of result.measured) {
      process.stdout.write(`${item.file}: ${item.score.toFixed(2)}% (required ${item.required.toFixed(2)}%)\n`);
    }
  }

  if (!args.againstRef && !args.report) {
    throw new Error('provide --report and/or --against-ref');
  }

  if (failures.length > 0) {
    process.stderr.write('Mutation score gate failed:\n');
    for (const failure of failures) process.stderr.write(`- ${failure}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write('Mutation score gate passed.\n');
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`Mutation score gate error: ${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  checkBaselineRatchet,
  checkReport,
  normalizePath,
  scoreMutants,
  validateBaseline,
};
