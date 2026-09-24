'use strict';

// #2505 A, first slice: the dependency dimension of code-change blast radius,
// recorded only (`enforced: false`). For every changed JavaScript module it
// counts how many in-repo modules require it (fan-in) from the require edge
// map, so a later threshold can weigh "not file counts alone" against the
// breadth the gate already records.
//
// Recorded, not enforced: nothing here changes a decision; the summary rides
// in the gate metadata next to the decision so the two can be compared before
// any threshold is enforced. Unknown is never 0: a file outside the require
// graph (non-JS, untracked, unreadable root) is `unknown` with a reason.

const fs = require('node:fs');
const path = require('node:path');
const { collectRequireEdges } = require('./module-reachability-walk');

const CODE_BLAST_RADIUS_VERSION = 'huqan-code-blast-radius-v1';
const MAX_DEPENDENTS_RECORDED = 25;

// Process-lifetime snapshot per root: the graph is read once per root and
// reused, so recording stays cheap next to every gate decision. A long-lived
// host that changes the tree under itself calls
// clearCodeChangeBlastRadiusCache() to re-read. Stale within the process is
// the documented trade; the envelope says `enforced: false` either way.
const graphCache = new Map();

function clearCodeChangeBlastRadiusCache() {
  graphCache.clear();
}

function graphFor(root) {
  if (!graphCache.has(root)) {
    const edges = collectRequireEdges(root);
    const keyOf = new Map();
    for (const file of edges.keys()) keyOf.set(canonical(file), file);
    const dependents = new Map();
    for (const [from, deps] of edges) {
      for (const dep of deps) {
        const key = canonical(dep);
        if (!keyOf.has(key)) keyOf.set(key, dep);
        if (!dependents.has(key)) dependents.set(key, new Set());
        dependents.get(key).add(canonical(from));
      }
    }
    graphCache.set(root, { edges, keyOf, dependents });
  }
  return graphCache.get(root);
}

function canonical(file) {
  try {
    return fs.realpathSync(file);
  } catch (_) {
    return path.resolve(file);
  }
}

function toPosix(root, absolute) {
  return path.relative(root, absolute).split(path.sep).join('/');
}

function unknownEnvelope(reasons) {
  return Object.freeze({
    version: CODE_BLAST_RADIUS_VERSION,
    files: Object.freeze([]),
    fileCount: 0,
    maxFanIn: null,
    status: 'unknown',
    reasons: Object.freeze([...reasons]),
    enforced: false,
  });
}

function summarizeCodeChangeBlastRadius(files, options = {}) {
  const list = Array.isArray(files) ? files : [];
  const rawRoot = typeof options.repoRoot === 'string' && options.repoRoot.trim()
    ? options.repoRoot
    : path.join(__dirname, '..');
  const root = canonical(path.resolve(rawRoot));

  let graph;
  try {
    graph = graphFor(root);
  } catch (error) {
    return unknownEnvelope([`require graph unreadable: ${error?.message || error}`]);
  }
  const { keyOf, dependents } = graph;

  const entries = [];
  const reasons = [];
  for (const file of list) {
    const rel = typeof file?.path === 'string' ? file.path : '';
    if (!rel.endsWith('.js')) {
      entries.push(Object.freeze({ path: rel, fanIn: null, dependents: Object.freeze([]), status: 'unknown', reason: 'not a javascript module' }));
      reasons.push(`${rel || '(missing path)'}: not a javascript module`);
      continue;
    }
    const key = canonical(path.resolve(root, rel));
    if (!keyOf.has(key)) {
      entries.push(Object.freeze({ path: rel, fanIn: null, dependents: Object.freeze([]), status: 'unknown', reason: 'outside the require graph' }));
      reasons.push(`${rel}: outside the require graph`);
      continue;
    }
    const names = [...(dependents.get(key) || [])].map((absolute) => toPosix(root, absolute)).sort();
    entries.push(Object.freeze({
      path: rel,
      fanIn: names.length,
      dependents: Object.freeze(names.slice(0, MAX_DEPENDENTS_RECORDED)),
      truncated: names.length > MAX_DEPENDENTS_RECORDED,
      status: 'computed',
    }));
  }

  const computed = entries.filter((entry) => entry.status === 'computed');
  const status = !entries.length || computed.length === entries.length
    ? (computed.length ? 'computed' : 'unknown')
    : (computed.length ? 'partial' : 'unknown');
  return Object.freeze({
    version: CODE_BLAST_RADIUS_VERSION,
    files: Object.freeze(entries),
    fileCount: entries.length,
    maxFanIn: computed.length ? Math.max(...computed.map((entry) => entry.fanIn)) : null,
    status,
    reasons: Object.freeze(reasons),
    enforced: false,
  });
}

module.exports = {
  CODE_BLAST_RADIUS_VERSION,
  MAX_DEPENDENTS_RECORDED,
  clearCodeChangeBlastRadiusCache,
  summarizeCodeChangeBlastRadius,
};
