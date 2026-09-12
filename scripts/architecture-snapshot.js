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
 * Usage:  node scripts/architecture-snapshot.js [--markdown]
 */

const fs = require('fs');
const path = require('path');
const { listSourceFiles, stripComments, buildGraph } = require('./check-import-cycles.js');

const repoRoot = path.resolve(__dirname, '..');
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
  || ['cli.js', 'server.js', 'mcpServer.js', 'index.js', 'agentRuntime.js'].includes(file)
  || /factory|runtime/.test(path.basename(file));

const isProduct = (file) => !file.startsWith('scripts/')
  && !file.startsWith('examples/')
  && !file.startsWith('bin/');

function snapshot() {
  const all = listSourceFiles();
  const source = all.filter((file) => !IS_TEST.test(file));
  const graph = buildGraph(all, source);
  const boundary = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'module-boundary-baseline.json'), 'utf8'),
  ).files;

  return source.map((file) => {
    const body = stripComments(fs.readFileSync(path.join(repoRoot, file), 'utf8'));
    const signals = [];
    if (boundary[file]) signals.push(`ISP:${boundary[file].calls}`);
    if (!isCompositionRoot(file) && body.match(CONSTRUCTS)) signals.push('DIP');
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

function main() {
  const rows = snapshot();
  const groups = classify(rows);
  const total = rows.length;

  if (!process.argv.includes('--markdown')) {
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

  console.log(`## Decomposition owed, over ${DECOMPOSE} lines (${groups.decompose.length})\n`);
  console.log(table(groups.decompose));
  console.log(`\n## Recorded debt, 401-${DECOMPOSE} lines (${groups.recorded.length})\n`);
  console.log(table(groups.recorded));
  console.log(`\n## At or under ${ACCEPTED} lines, tracked for a signal (${groups.structural.length})\n`);
  console.log(table(groups.structural));
  return 0;
}

if (require.main === module) process.exit(main());

module.exports = { snapshot, classify, ACCEPTED, DECOMPOSE };
