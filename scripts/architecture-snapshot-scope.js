'use strict';

const fs = require('fs');
const path = require('path');
const { stripComments } = require('./check-import-cycles.js');

const repoRoot = path.resolve(__dirname, '..');

/**
 * The executables package.json ships as `bin` (#2401). They are product code a
 * consumer runs, so they are measured with the product bands; any other file
 * under bin/ stays tooling. Derived from package.json, not listed here, so a
 * bin added or dropped there moves in or out of product scope by itself.
 */
function packagedBins(pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))) {
  const bin = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  return new Set(Object.values(bin).map((entry) => path.posix.normalize(String(entry)).replace(/^\.\//, '')));
}

const PACKAGED_BINS = packagedBins();

const isProduct = (file, bins = PACKAGED_BINS) => bins.has(file) || (!file.startsWith('scripts/')
  && !file.startsWith('examples/')
  && !file.startsWith('bin/'));

const CONSTRUCTS = /new\s+(Kernel|KernelV2|Agent|AgentV3|HuqanStorage|Graph|MemoryStore|WorkflowAgent)\s*\(/g;

const ENTRYPOINTS = ['cli.js', 'server.js', 'mcpServer.js', 'index.js', 'agentRuntime.js', 'kernel.js'];

/**
 * Library files whose job is building collaborators (#2401). Named here with
 * the reason and a review date instead of matched by a `factory|runtime` name
 * regex, which let any file opt out of the DIP signal by being renamed.
 * `--check` fails on an expired entry and on one that constructs nothing.
 */
const COMPOSITION_ROOTS = Object.freeze([
  { file: 'lib/kernel-factory.js', why: 'Assembles KernelV2 for the CLI, server and MCP entrypoints.', review_by: '2027-03-31' },
  { file: 'lib/agent-v3-storage-factory.js', why: 'Opens the HuqanStorage an AgentV3 is handed when the caller passes none.', review_by: '2027-03-31' },
  { file: 'lib/mcp-approval-store-factory.js', why: 'Opens the HuqanStorage behind the MCP approval store.', review_by: '2027-03-31' },
  { file: 'lib/external-action-receipt-writer-factory.js', why: 'Builds the Graph an external-action receipt writer persists to.', review_by: '2027-03-31' },
  { file: 'lib/rust-graph-fallback-factory.js', why: 'Builds the JavaScript Graph used when the Rust accelerator is unavailable.', review_by: '2027-03-31' },
  { file: 'workflow-runtime.js', why: 'The workflow runtime entry: constructs the WorkflowAgent it stands in for.', review_by: '2027-03-31' },
]);

const isCompositionRoot = (file, roots = COMPOSITION_ROOTS) => file.startsWith('bin/')
  || file.startsWith('scripts/')
  || file.startsWith('examples/')
  || ENTRYPOINTS.includes(file)
  || roots.some((entry) => entry.file === file);

function compositionRootViolations(entries = COMPOSITION_ROOTS, { today = new Date().toISOString().slice(0, 10), readSource } = {}) {
  const read = readSource || ((file) => {
    const full = path.join(repoRoot, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  });
  const violations = [];
  for (const entry of entries) {
    if (entry.review_by < today) {
      violations.push(`${entry.file}: composition root expired on ${entry.review_by}`);
      continue;
    }
    const source = read(entry.file);
    if (source === null) violations.push(`${entry.file}: composition root is stale, the file is gone`);
    else if (!stripComments(source).match(CONSTRUCTS)) violations.push(`${entry.file}: composition root is stale, nothing is constructed any more`);
  }
  return violations;
}

function matchingClose(body, start, open, close) {
  let depth = 0;
  for (let i = start; i < body.length; i += 1) {
    if (body[i] === open) depth += 1;
    else if (body[i] === close && (depth -= 1) === 0) return i;
  }
  return -1;
}

/**
 * The longest `if { } else if { } ...` chain in comment-stripped source
 * (#2401): the if-shaped twin of a long switch, counted per branch. Braceless
 * branches end a chain, so the count is a lower bound, never an overcount.
 */
function longestIfChain(body) {
  let longest = 0;
  for (const head of body.matchAll(/\bif\s*\(/g)) {
    if (/else\s*$/.test(body.slice(Math.max(0, head.index - 8), head.index))) continue;
    let at = head.index;
    let branches = 0;
    for (;;) {
      const condEnd = matchingClose(body, body.indexOf('(', at), '(', ')');
      if (condEnd < 0) break;
      branches += 1;
      const blockStart = body.slice(condEnd + 1).search(/\S/) + condEnd + 1;
      if (body[blockStart] !== '{') break;
      const blockEnd = matchingClose(body, blockStart, '{', '}');
      const next = blockEnd < 0 ? null : /^\s*else\s+if\s*\(/.exec(body.slice(blockEnd + 1, blockEnd + 40));
      if (!next) break;
      at = blockEnd + next[0].length;
    }
    longest = Math.max(longest, branches);
  }
  return longest;
}

/**
 * Growing-dispatch signals the OCP counter reports that are not a coupling
 * defect (#3101). A switch over a set the language or a parser closes cannot
 * grow with a feature: there is no case a later PR can add, so replacing it
 * with a registry buys indirection and nothing else. Those files are named
 * here with the reason and a review date, like COMPOSITION_ROOTS above.
 * `--check` fails on an expired entry and on one that no longer matches.
 */
const OCP_ALLOWED = Object.freeze([
  {
    file: 'sandboxRunner.js',
    why: 'switch (typeof value) is closed by the language: typeof has a fixed, exhaustive result set, so no feature can add a case. Stays a switch (#2179).',
    review_by: '2026-12-31',
  },
  {
    file: 'lib/verify-numeric-text.js',
    why: 'switch (operator) is closed by the parser: the guard regex above it admits only those eight operators, so no feature can add a case. Stays a switch (#2140).',
    review_by: '2026-12-31',
  },
  {
    file: 'lib/cognitive-lab-manifest.js',
    why: 'switch (kind) validates node kinds from the MANIFEST_SPEC contract grammar (#3374), not a feature set. Stays a switch.',
    review_by: '2026-12-31',
  },
]);

const isOcpAllowed = (file) => OCP_ALLOWED.some((entry) => entry.file === file);

/**
 * The OCP count the tracker reports: the first switch with at least six cases,
 * otherwise an if-chain of six. One counter, read by both the live measurement
 * and the exception check.
 */
function ocpSignal(body) {
  for (const match of body.matchAll(/switch\s*\(([^)]{0,60})\)\s*\{/g)) {
    const tail = body.slice(match.index);
    const end = tail.indexOf('\n}');
    const cases = (tail.slice(0, end > 0 ? end : 4000).match(/\bcase\s/g) || []).length;
    if (cases >= 6) return cases;
  }
  const ifChain = longestIfChain(body);
  return ifChain >= 6 ? ifChain : null;
}

function ocpExceptionViolations(entries = OCP_ALLOWED, { today = new Date().toISOString().slice(0, 10), readSource } = {}) {
  const read = readSource || ((file) => {
    const full = path.join(repoRoot, file);
    return fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : null;
  });
  const violations = [];
  for (const entry of entries) {
    if (entry.review_by < today) {
      violations.push(`${entry.file}: OCP exception expired on ${entry.review_by}`);
      continue;
    }
    const source = read(entry.file);
    if (source === null) violations.push(`${entry.file}: OCP exception is stale, the file is gone`);
    else if (ocpSignal(stripComments(source)) === null) violations.push(`${entry.file}: OCP exception is stale, the dispatch is not a signal any more`);
  }
  return violations;
}

const FAN_OUT_SIGNAL = 20;

/**
 * Entrypoints whose fan-out is recorded rather than reported (#3101). DIP
 * exempts composition roots; FANOUT has no such exemption, so an entrypoint
 * whose remaining requires are wiring it must own is named here with the
 * reason, a review date and a ceiling equal to its fan-out. Only an entrypoint
 * can be recorded, growth past the ceiling brings the signal back, and
 * `--check` fails on an expired, stale or loose entry.
 */
const FANOUT_ALLOWED = Object.freeze([
  {
    file: 'index.js',
    ceiling: 20,
    why: 'The package-root facade exports the existing SDK ports and the transport-independent A2A handoff '
      + 'dispatcher (#3477). These requires only expose reviewed public constructors/functions; signing, '
      + 'admission and dispatch remain injected by the host. docs/a2a-pre-dispatch-intervention.md and '
      + 'test/a2a-pre-dispatch-intervention.test.js pin the public caller. No domain decisions live in this entrypoint.',
    review_by: '2026-12-31',
  },
  {
    file: 'kernel.js',
    ceiling: 28,
    why: 'The remaining requires wire the admission-gated learn() chokepoint and its single audit sink, which '
      + 'lib/kernel-learn-input-methods.js, ADR-012 and the audit contracts pin to kernel.js; the admission bypass '
      + 'Symbol is module-private here. The movable method groups already left (#2122, #3097).',
    review_by: '2026-12-31',
  },
  {
    file: 'cli.js',
    ceiling: 20,
    why: 'Two of the requires wire the MemoryLifecycle the `memory-lifecycle` command drives (#3461): the Adapters '
      + 'lifecycle may not require its Application receipt collaborators itself, and cli.js is the only ring allowed '
      + 'to supply them. The wiring cannot move to a lib/ helper -- a lib/memory-* module is still Adapters, and a '
      + 'lib/cli-* handler is still Core, so either would re-open the same upward edge.',
    review_by: '2027-03-31',
  },
]);

const isFanoutAllowed = (file, fanOut, entries = FANOUT_ALLOWED) => ENTRYPOINTS.includes(file)
  && entries.some((entry) => entry.file === file && fanOut <= entry.ceiling);

function fanoutExceptionViolations(entries = FANOUT_ALLOWED, { today = new Date().toISOString().slice(0, 10), fanOutOf } = {}) {
  const violations = [];
  for (const entry of entries) {
    if (entry.review_by < today) {
      violations.push(`${entry.file}: FANOUT exception expired on ${entry.review_by}`);
      continue;
    }
    if (!ENTRYPOINTS.includes(entry.file)) {
      violations.push(`${entry.file}: FANOUT exception is only for an entrypoint`);
      continue;
    }
    const fanOut = fanOutOf(entry.file);
    if (fanOut === null) violations.push(`${entry.file}: FANOUT exception is stale, the file is gone`);
    else if (fanOut < FAN_OUT_SIGNAL) violations.push(`${entry.file}: FANOUT exception is stale, fan-out ${fanOut} is under the signal`);
    else if (fanOut > entry.ceiling) violations.push(`${entry.file}: fan-out ${fanOut} is above the ceiling ${entry.ceiling}`);
    else if (fanOut < entry.ceiling) violations.push(`${entry.file}: fan-out fell to ${fanOut}; lower the ceiling to ${fanOut}`);
  }
  return violations;
}

module.exports = {
  FAN_OUT_SIGNAL,
  FANOUT_ALLOWED,
  isFanoutAllowed,
  fanoutExceptionViolations,
  longestIfChain,
  OCP_ALLOWED,
  isOcpAllowed,
  ocpSignal,
  ocpExceptionViolations,
  isProduct,
  packagedBins,
  isCompositionRoot,
  compositionRootViolations,
  COMPOSITION_ROOTS,
  CONSTRUCTS,
};
