#!/usr/bin/env node
'use strict';

/**
 * Print the architecture snapshot the epic trackers are built from.
 *
 * The first set of trackers was written by hand from a one-off measurement.
 * Within a day they disagreed with the gate in three of four bands and listed
 * a file that had since dropped out of its band -- and everyone reading them,
 * including the people auditing the plan, was working from stale numbers.
 * A tracker that has to be retyped is a tracker that will be wrong.
 *
 * So the numbers come from here, and here reads the same counter and the same
 * baselines the gates enforce. `--markdown` prints tracker bodies ready to
 * paste; no flag prints the summary.
 *
 * Usage:  node scripts/architecture-snapshot.js [--markdown|--mermaid|--write|--check]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { listSourceFiles, stripComments, buildGraph } = require('./check-import-cycles.js');
const { buildDependencySnapshot, checkDependencyGraph, dependencyGraphBaseline, renderGraphSummary } = require('./architecture-dependency-graph.js');
const { renderMermaid } = require('./architecture-mermaid');

const repoRoot = path.resolve(__dirname, '..');
const TRACKER_PATH = path.join(repoRoot, 'docs', 'generated', 'architecture-trackers.md');
const BASELINE_PATH = path.join(__dirname, 'architecture-tracker-baseline.json');
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;
const ACCEPTED = 400;
const DECOMPOSE = 800;
const FAN_OUT_SIGNAL = 20;

// The counter scripts/check-file-size.js enforces: newlines, plus one when the
// file does not end in one. Anything else disagrees with the gate by one line
// on most of the tree.
function countLines(file) {
  const source = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  if (source === '') return 0;
  let lines = 0;
  for (let i = 0; i < source.length; i += 1) if (source[i] === '\n') lines += 1;
  if (!source.endsWith('\n')) lines += 1;
  return lines;
}

const CONSTRUCTS = /new\s+(Kernel|KernelV2|Agent|AgentV3|HuqanStorage|Graph|MemoryStore|WorkflowAgent)\s*\(/g;

/** An entrypoint, factory or runtime is a composition root: building its
 *  collaborators is its job, and counting that as a coupling defect produced
 *  eight false findings the first time round. */
const isCompositionRoot = (file) => file.startsWith('bin/')
  || file.startsWith('scripts/')
  || file.startsWith('examples/')
  || ['cli.js', 'server.js', 'mcpServer.js', 'index.js', 'agentRuntime.js', 'kernel.js'].includes(file)
  || /factory|runtime/.test(path.basename(file));

/**
 * Constructions the DIP regex matches that are not a coupling defect (#2268).
 * The regex cannot tell an injected collaborator from a throwaway local
 * structure, so those are recorded here -- each with its reason and a review
 * date, like scripts/check-layers.js's ALLOWED -- rather than moved into a
 * '*runtime*' file to silence it. `--check` fails on an expired entry and on
 * one that no longer matches: a gone file, a composition root, or a file that
 * constructs nothing any more.
 */
const DIP_ALLOWED = Object.freeze([
  {
    file: 'lib/self-healer/source-dependency-graph.js',
    why: 'dreamDependencyCandidates builds a throwaway in-memory Graph (useSQLite: false; measured: no filesystem access) '
      + 'so Dream can run over a source dependency graph. A local data structure, not a collaborator to inject.',
    review_by: '2026-12-31',
  },
]);

const isDipAllowed = (file) => DIP_ALLOWED.some((entry) => entry.file === file);

function readRepoSource(file) {
  const full = path.join(repoRoot, file);
  return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
}

function dipExceptionViolations(entries = DIP_ALLOWED, { today = new Date().toISOString().slice(0, 10), readSource = readRepoSource } = {}) {
  const violations = [];
  for (const entry of entries) {
    if (entry.review_by < today) {
      violations.push(`${entry.file}: DIP exception expired on ${entry.review_by}`);
      continue;
    }
    const source = readSource(entry.file);
    if (source === null) violations.push(`${entry.file}: DIP exception is stale, the file is gone`);
    else if (isCompositionRoot(entry.file)) violations.push(`${entry.file}: DIP exception is unnecessary, the file is a composition root`);
    else if (!stripComments(source).match(CONSTRUCTS)) violations.push(`${entry.file}: DIP exception is stale, nothing is constructed any more`);
  }
  return violations;
}

const isProduct = (file) => !file.startsWith('scripts/')
  && !file.startsWith('examples/')
  && !file.startsWith('bin/');

// Built at most once per process: the size tracker and the layer snapshot read the same tree.
let sourceGraphCache = null;
function sourceGraph() {
  if (!sourceGraphCache) {
    const all = listSourceFiles();
    const source = all.filter((file) => !IS_TEST.test(file));
    sourceGraphCache = { source, graph: buildGraph(all, source) };
  }
  return sourceGraphCache;
}

function snapshot(state = sourceGraph()) {
  const source = state.source;
  const graph = state.graph;
  const boundary = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'module-boundary-baseline.json'), 'utf8'),
  ).files;

  return source.map((file) => {
    const body = stripComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    const signals = [];
    if (boundary[file]) signals.push(`ISP:${boundary[file].calls}`);
    if (!isCompositionRoot(file) && !isDipAllowed(file) && body.match(CONSTRUCTS)) signals.push('DIP');
    for (const match of body.matchAll(/switch\s*\(([^)]{0,60})\)\s*\{/g)) {
      const tail = body.slice(match.index);
      const end = tail.indexOf('\n}');
      const cases = (tail.slice(0, end > 0 ? end : 4000).match(/\bcase\s/g) || []).length;
      if (cases >= 6) { signals.push(`OCP:${cases}`); break; }
    }
    const fanOut = new Set(graph.get(file) || []).size;
    if (fanOut >= FAN_OUT_SIGNAL) signals.push(`FANOUT:${fanOut}`);
    return { file, lines: countLines(file), signals, fanOut };
  });
}

/**
 * Size band is the primary grouping and a signal is a column, so no file
 * appears in two trackers. The exception is `structural`: a file at or under
 * the accepted size has no size-based issue at all, so a signal is the only
 * reason it is tracked, and it needs somewhere to be listed.
 */
function classify(rows) {
  const out = { structural: [], accepted: [], recorded: [], decompose: [], tooling: [] };
  for (const row of rows) {
    if (!isProduct(row.file)) {
      if (row.lines > ACCEPTED || row.signals.length > 0) out.tooling.push(row);
      continue;
    }
    if (row.lines > DECOMPOSE) { out.decompose.push(row); continue; }
    if (row.lines > ACCEPTED) { out.recorded.push(row); continue; }
    if (row.signals.length > 0) { out.structural.push(row); continue; }
    if (row.lines > 200) out.accepted.push(row);
  }
  return out;
}

function table(rows) {
  const lines = ['| File | Lines | Signals |', '|---|---:|---|'];
  for (const row of rows.sort((a, b) => b.lines - a.lines)) {
    lines.push(`| \`${row.file}\` | ${row.lines} | ${row.signals.join(' ') || '—'} |`);
  }
  return lines.join('\n');
}

function renderMarkdown(groups) {
  const tracked = groups.structural.length + groups.recorded.length + groups.decompose.length;
  return [
    '<!-- Generated by `npm run arch:snapshot -- --write`; do not edit by hand. -->',
    '# Architecture tracker snapshot',
    '',
    `Tracked in total: **${tracked}**`,
    '',
    `## Decomposition owed, over ${DECOMPOSE} lines (${groups.decompose.length})`,
    '',
    table(groups.decompose),
    '',
    `## Recorded debt, 401-${DECOMPOSE} lines (${groups.recorded.length})`,
    '',
    table(groups.recorded),
    '',
    `## At or under ${ACCEPTED} lines, tracked for a signal (${groups.structural.length})`,
    '',
    table(groups.structural),
    '',
  ].join('\n');
}

function counts(groups) {
  const value = {
    decompose: groups.decompose.length,
    recorded: groups.recorded.length,
    structural: groups.structural.length,
  };
  value.tracked = value.decompose + value.recorded + value.structural;
  return value;
}

function trackedEntries(groups) {
  const entries = {};
  for (const band of ['structural', 'recorded', 'decompose']) {
    for (const row of groups[band]) {
      entries[row.file] = { band, lines: row.lines, signals: [...row.signals].sort() };
    }
  }
  return Object.fromEntries(Object.entries(entries).sort(([a], [b]) => a.localeCompare(b)));
}

function normalizeEol(value) {
  return value.replace(/\r\n/g, '\n');
}

function checkTrackerArtifact(expected, actual) {
  return normalizeEol(expected) === normalizeEol(actual) ? null : `Architecture tracker drift: regenerate ${path.relative(repoRoot, TRACKER_PATH).replace(/\\/g, '/')} with npm run arch:snapshot -- --write.`;
}

function trackerBaselineViolations(current, baseline) {
  const violations = [];
  const rank = { structural: 1, recorded: 2, decompose: 3 };
  for (const [file, entry] of Object.entries(current)) {
    const recorded = baseline.entries[file];
    if (!recorded) {
      violations.push(`${file} is newly tracked in ${entry.band}`);
      continue;
    }
    if (rank[entry.band] > rank[recorded.band]) {
      violations.push(`${file} worsened band ${recorded.band} -> ${entry.band}`);
    }
    if (entry.lines > recorded.lines) {
      violations.push(`${file} grew ${recorded.lines} -> ${entry.lines} lines`);
    }
    const recordedSignals = new Map(recorded.signals.map((signal) => {
      const match = signal.match(/^([^:]+)(?::(\d+))?$/);
      return [match[1], match[2] === undefined ? null : Number(match[2])];
    }));
    for (const signal of entry.signals) {
      const match = signal.match(/^([^:]+)(?::(\d+))?$/);
      const kind = match[1];
      const value = match[2] === undefined ? null : Number(match[2]);
      if (!recordedSignals.has(kind)) {
        violations.push(`${file} added signal ${signal}`);
      } else if (value !== null && value > recordedSignals.get(kind)) {
        violations.push(`${file} worsened signal ${kind}:${recordedSignals.get(kind)} -> ${value}`);
      }
    }
  }
  return violations;
}

function writeTrackerBaseline(entries, dependencyGraph, targetPath = BASELINE_PATH) {
  fs.writeFileSync(targetPath, `${JSON.stringify({ schemaVersion: 3, entries, dependencyGraph }, null, 2)}\n`);
}

function baselineEvolutionViolations(previous, next) {
  return trackerBaselineViolations(next.entries, previous);
}

function optionValue(argv, name) {
  const arg = argv.find((item) => item.startsWith(`${name}=`));
  return arg ? arg.slice(arg.indexOf('=') + 1) : null;
}

function main(argv = process.argv.slice(2)) {
  // Both flags print a view of the same graph and exit: --mermaid the four rings
  // scripts/check-layers.js enforces, --graph the #2641 layer snapshot.
  if (argv.includes('--mermaid')) { process.stdout.write(`${renderMermaid(sourceGraph().graph)}\n`); return 0; }
  if (argv.includes('--graph')) { process.stdout.write(`${renderGraphSummary(buildDependencySnapshot(sourceGraph().graph))}\n`); return 0; }

  const snapshotPath = optionValue(argv, '--snapshot');
  const rows = snapshotPath ? null : snapshot();
  const graphSnapshotPath = optionValue(argv, '--graph-snapshot');
  const dependency = graphSnapshotPath
    ? JSON.parse(fs.readFileSync(path.resolve(graphSnapshotPath), 'utf8'))
    : buildDependencySnapshot(sourceGraph().graph);
  const groups = snapshotPath
    ? JSON.parse(fs.readFileSync(path.resolve(snapshotPath), 'utf8'))
    : classify(rows);
  const total = rows ? rows.length : Object.values(groups).flat().length;
  const markdown = renderMarkdown(groups);
  const entries = trackedEntries(groups);

  if (argv.includes('--write')) {
    fs.mkdirSync(path.dirname(TRACKER_PATH), { recursive: true });
    fs.writeFileSync(TRACKER_PATH, markdown);
    console.log(`Wrote ${path.relative(repoRoot, TRACKER_PATH).replace(/\\/g, '/')}`);
    return 0;
  }

  const checkArg = argv.find((arg) => arg === '--check' || arg.startsWith('--check='));
  if (checkArg) {
    const trackerPath = checkArg.includes('=') ? path.resolve(checkArg.slice(checkArg.indexOf('=') + 1)) : TRACKER_PATH;
    const baselinePath = path.resolve(optionValue(argv, '--baseline') || BASELINE_PATH);
    const actual = fs.existsSync(trackerPath) ? fs.readFileSync(trackerPath, 'utf8') : '';
    const error = checkTrackerArtifact(markdown, actual);
    if (error) {
      console.error(error);
      return 1;
    }
    const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
    const previousPath = optionValue(argv, '--previous-baseline');
    const baseRef = optionValue(argv, '--base-ref');
    let previous = null;
    if (previousPath) previous = JSON.parse(fs.readFileSync(path.resolve(previousPath), 'utf8'));
    if (!previousPath && (!baseRef || /^0+$/.test(baseRef))) {
      console.error('Architecture tracker base ref is required and must resolve to a commit.');
      return 1;
    }
    if (baseRef && !/^0+$/.test(baseRef)) {
      execFileSync('git', ['cat-file', '-e', `${baseRef}^{commit}`], {
        cwd: repoRoot, stdio: ['ignore', 'ignore', 'ignore'],
      });
      try {
        previous = JSON.parse(execFileSync(
          'git', ['show', `${baseRef}:scripts/architecture-tracker-baseline.json`],
          { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ));
      } catch (error) {
        // The gate's introducing PR has no predecessor artifact. Once merged,
        // every later PR/push has one and must prove monotonic evolution.
        if (error.status !== 128) throw error;
      }
    }
    if (previous) {
      const evolution = baselineEvolutionViolations(previous, baseline);
      if (evolution.length > 0) {
        console.error(`Architecture tracker baseline cannot add debt:\n  ${evolution.join('\n  ')}`);
        return 1;
      }
    }
    const violations = trackerBaselineViolations(entries, baseline);
    if (violations.length > 0) {
      console.error(`Architecture tracker baseline violation:\n  ${violations.join('\n  ')}`);
      return 1;
    }
    const dipViolations = dipExceptionViolations();
    if (dipViolations.length > 0) {
      console.error('DIP exception list is out of date:');
      for (const violation of dipViolations) console.error(`  ${violation}`);
      return 1;
    }
    // The layer graph is checked against the same artifact (#2641): no ring, a
    // new violation, or drift past the threshold fails in this one command.
    const update = argv.includes('--update-baseline') || argv.includes('--update');
    const exceptionsPath = optionValue(argv, '--layer-exceptions');
    const exceptions = exceptionsPath ? JSON.parse(fs.readFileSync(path.resolve(exceptionsPath), 'utf8')) : undefined;
    const graphCheck = checkDependencyGraph(dependency, dependencyGraphBaseline(baseline), argv, dependencyGraphBaseline(previous), exceptions);
    for (const message of graphCheck.messages) console.error(message);
    if (!graphCheck.ok) return 1;
    const baselineIsCurrent = JSON.stringify(entries) === JSON.stringify(baseline.entries);
    if (!baselineIsCurrent && !update) {
      console.error('Architecture tracker baseline has unrecorded improvements; rerun with --update and commit the lowered baseline.');
      return 1;
    }
    if (update) {
      writeTrackerBaseline(entries, graphCheck.recorded, baselinePath);
      console.log('Architecture tracker baseline updated with monotonic improvements.');
      return 0;
    }
    console.log('Architecture tracker artifact matches the live snapshot.');
    return 0;
  }

  if (!argv.includes('--markdown')) {
    const tracked = groups.structural.length + groups.recorded.length + groups.decompose.length;
    console.log(`source files: ${total}`);
    console.log(`decomposition owed, over ${DECOMPOSE}: ${groups.decompose.length}`);
    console.log(`recorded debt, 401-${DECOMPOSE}: ${groups.recorded.length}`);
    console.log(`at or under ${ACCEPTED} but carrying a signal: ${groups.structural.length}`);
    console.log(`tracked in total: ${tracked}`);
    console.log(`accepted, 201-${ACCEPTED}, no issue: ${groups.accepted.length}`);
    console.log(`tooling outside the product graph: ${groups.tooling.length}`);
    return 0;
  }

  process.stdout.write(markdown);
  return 0;
}

if (require.main === module) process.exitCode = main();

module.exports = {
  snapshot,
  classify,
  renderMarkdown,
  counts,
  trackedEntries,
  normalizeEol,
  checkTrackerArtifact,
  trackerBaselineViolations,
  baselineEvolutionViolations,
  DIP_ALLOWED,
  isCompositionRoot,
  dipExceptionViolations,
  TRACKER_PATH,
  BASELINE_PATH,
  ACCEPTED,
  DECOMPOSE,
};
