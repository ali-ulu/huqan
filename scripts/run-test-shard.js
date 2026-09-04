'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_SHARDS,
  REPO_ROOT,
  discoverTestFiles,
  getShard,
} = require('./ci-shard-manifest');
const { createTestStateSandbox } = require('./test-state-sandbox');

function parseArgs(argv) {
  const options = {
    shard: null,
    total: DEFAULT_SHARDS,
    // Several legacy tests intentionally share default JSON persistence within
    // a process-level test run. CI parallelism is provided by separate shard
    // runners; keep each runner serial unless a future isolation audit proves
    // a higher value safe.
    concurrency: 1,
    report: null,
    selection: null,
    list: false,
  };
  for (const arg of argv) {
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'shard') options.shard = Number(value);
    else if (key === 'total') options.total = Number(value);
    else if (key === 'concurrency') options.concurrency = Number(value);
    else if (key === 'report') options.report = value;
    else if (key === 'selection') options.selection = value;
    else throw new Error(`unsupported argument: ${arg}`);
  }
  return options;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
}

function defaultReportPath(shard) {
  return path.join(os.tmpdir(), `huqan-test-shard-${shard}.xml`);
}

function loadSelection(selectionPath, knownFiles) {
  const absolute = path.resolve(selectionPath);
  const plan = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.selectedTests)) {
    throw new Error('selection manifest must contain schemaVersion=1 and selectedTests[]');
  }
  const known = new Set(knownFiles);
  const selected = [...new Set(plan.selectedTests.map((file) => String(file).replaceAll('\\', '/')))].sort();
  if (selected.length === 0) throw new Error('selection manifest selectedTests must not be empty');
  const unknown = selected.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`selection manifest references unknown test files: ${unknown.join(', ')}`);
  return selected;
}

function run(options) {
  assertPositiveInteger(options.total, 'total');
  assertPositiveInteger(options.shard, 'shard');
  assertPositiveInteger(options.concurrency, 'concurrency');
  if (options.shard > options.total) throw new Error(`shard must be between 1 and ${options.total}, got ${options.shard}`);

  const files = discoverTestFiles(REPO_ROOT);
  const selectedFiles = options.selection ? loadSelection(options.selection, files) : files;
  const selected = getShard(selectedFiles, options.shard, options.total);
  const reportPath = path.resolve(options.report || defaultReportPath(options.shard));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  console.log(`Running shard ${options.shard}/${options.total}: ${selected.files.length} test files, estimated weight ${selected.weight.toFixed(3)}s${options.selection ? ` (selection=${options.selection})` : ''}`);
  if (selected.files.length === 0) {
    fs.writeFileSync(reportPath, '<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="0" failures="0" skipped="0" time="0" />\n');
    console.log('No tests assigned to this shard; skipping Node test discovery.');
    return 0;
  }
  if (options.list) {
    for (const file of selected.files) console.log(file);
    return 0;
  }

  // Sharded runs get the same throwaway gate state root as `npm test`: a shard
  // run on a developer machine must not read or extend the operator's live
  // policy and receipt trail either (#1846).
  const sandbox = createTestStateSandbox();

  // Announce the full plan upfront so a hang that occurs before the first
  // file starts is still diagnosable, then announce each file as it starts
  // so the next "still running at 22m" points at a single file rather than
  // an opaque shard (#1847).
  for (const file of selected.files) {
    console.log(`[shard ${options.shard}/${options.total}] queued ${file}`);
  }

  const partPaths = [];
  let overallStatus = 0;
  let lastSignal = null;

  try {
    for (let index = 0; index < selected.files.length; index += 1) {
      const file = selected.files[index];
      const partPath = `${reportPath}.part-${index + 1}.xml`;
      partPaths.push(partPath);
      const startedAt = new Date().toISOString();
      console.log(`[shard ${options.shard}/${options.total}] starting ${index + 1}/${selected.files.length}: ${file} at ${startedAt}`);
      const startedMs = Date.now();
      const result = spawnSync(process.execPath, [
        '--test',
        `--test-concurrency=${options.concurrency}`,
        '--test-reporter=junit',
        `--test-reporter-destination=${partPath}`,
        file,
      ], {
        cwd: REPO_ROOT,
        env: sandbox.environment,
        stdio: 'inherit',
        // Cap the indefinite "still running at 22m" (#1847) at the file that
        // actually hangs. Historical max per-file is ~25s; 90s is 3-4x margin
        // for slow Linux runners but fails fast instead of waiting for the
        // 20m job timeout from #1845.
        timeout: 90_000,
        killSignal: 'SIGTERM',
      });

      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          const elapsed = ((Date.now() - startedMs) / 1000).toFixed(3);
          console.error(`[shard ${options.shard}/${options.total}] file ${file} timed out after 90s (elapsed ${elapsed}s, signal ${result.signal || 'SIGTERM'}) — killed hanging file, see #1847`);
          overallStatus = 1;
          // Leave a minimal JUnit entry so the merged report shows the hang
          // as a failure instead of silently dropping the file.
          try {
            if (!fs.existsSync(partPath) || fs.readFileSync(partPath, 'utf8').trim().length === 0) {
              const safe = file.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
              fs.writeFileSync(partPath, `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<testsuite name="${safe}" tests="1" failures="1" errors="0" skipped="0" time="90.000"><testcase name="shard timeout (90s) — file hung" classname="shard"><failure message="file hung and was killed after 90s">File ${safe} did not exit within 90s (likely CDP/browser hang, see #1847). Check the preceding [shard] starting log.</failure></testcase></testsuite>\n</testsuites>\n`);
            }
          } catch { /* ignore */ }
          continue;
        }
        throw result.error;
      }
      if (result.signal) {
        console.error(`[shard ${options.shard}/${options.total}] file ${file} terminated by signal ${result.signal}`);
        lastSignal = result.signal;
        overallStatus = 1;
        break;
      }
      const status = result.status === 0 ? 0 : (result.status || 1);
      const elapsed = ((Date.now() - startedMs) / 1000).toFixed(3);
      console.log(`[shard ${options.shard}/${options.total}] finished ${index + 1}/${selected.files.length}: ${file} -> status ${status} in ${elapsed}s`);
      if (status !== 0 && overallStatus === 0) overallStatus = status;
    }
  } finally {
    sandbox.cleanup();
  }

  // Merge per-file JUnit reports into the single report the workflow
  // uploads as `artifacts/test-shard-*.xml`. Keep it best-effort: a
  // missing/corrupt part must not hide the exit code.
  try {
    let totalTests = 0;
    let totalFailures = 0;
    let totalErrors = 0;
    let totalSkipped = 0;
    let totalTime = 0;
    const suites = [];
    for (const partPath of partPaths) {
      if (!fs.existsSync(partPath)) continue;
      const xml = fs.readFileSync(partPath, 'utf8');
      const suiteBlocks = xml.match(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g) || [];
      for (const block of suiteBlocks) suites.push(block);
      // Sum from <testsuite> attributes, not <testsuites>.
      for (const match of xml.matchAll(/<testsuite\b[^>]*>/g)) {
        const tag = match[0];
        const get = (name) => {
          const m = tag.match(new RegExp(`${name}="([^"]+)"`));
          return m ? Number(m[1]) : 0;
        };
        totalTests += get('tests');
        totalFailures += get('failures');
        totalErrors += get('errors');
        totalSkipped += get('skipped');
        const t = tag.match(/time="([^"]+)"/);
        if (t) totalTime += Number(t[1]) || 0;
      }
      try { fs.rmSync(partPath, { force: true }); } catch { /* ignore */ }
    }
    if (suites.length === 0) {
      // No part produced a suite (e.g. early signal) — preserve prior
      // behaviour: emit an empty but valid report.
      if (!fs.existsSync(reportPath)) {
        fs.writeFileSync(reportPath, '<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="0" failures="0" skipped="0" time="0" />\n');
      }
    } else {
      const merged = `<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="${totalTests}" failures="${totalFailures}" errors="${totalErrors}" skipped="${totalSkipped}" time="${totalTime.toFixed(3)}">\n${suites.join('\n')}\n</testsuites>\n`;
      fs.writeFileSync(reportPath, merged);
    }
  } catch (error) {
    console.error(`warning: failed to merge JUnit parts into ${reportPath}: ${error.message}`);
  }

  console.log(`JUnit timing report: ${reportPath}`);
  if (lastSignal) {
    console.error(`test shard terminated by signal ${lastSignal}`);
    return 1;
  }
  return overallStatus;
}

if (require.main === module) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  defaultReportPath,
  loadSelection,
  parseArgs,
  run,
};
