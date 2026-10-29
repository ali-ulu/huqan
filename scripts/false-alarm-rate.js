#!/usr/bin/env node
'use strict';

/**
 * Measure the false-alarm rate of the action gates (İP-1).
 *
 * The adversarial side of this guard is well covered: every external-action
 * suite asks "did a hostile action get through". Nothing measured the other
 * direction, and that asymmetry is dangerous in a specific way -- every
 * tightening reads as a security win and is invisible as a usability loss. A
 * gate that stops 3% of legitimate work and one that stops 30% both report
 * green. The real failure is not a red test; it is an operator quietly turning
 * the guard off, which is indistinguishable in outcome from never shipping it.
 *
 * scripts/benign-false-block-rate.js already made this point for 18 commands
 * and its own header says the recorded 38.9% "is not good". This is the same
 * measurement at the size the task asks for: a labelled corpus of >=500 safe
 * and >=100 risky calls, run through the real decision paths, with both
 * directions reported -- false alarm on a safe call, and miss on a risky one.
 *
 * Two things this deliberately does NOT do:
 *
 *   1. It does not change any policy. A miss here is a report, not a licence to
 *      loosen the gate, and a false alarm is a report, not a licence to widen
 *      the allowlist. The script exits non-zero only when the corpus itself is
 *      unusable (too small, unlabelled), never because a target was missed.
 *   2. It does not mock the decision. The shell and file-write tiers go through
 *      evaluateExternalAction, the agent tiers through
 *      evaluateAgentActionFirewall, and the automation tier through the AB5
 *      seam -- the same entries the product uses.
 *
 * A safe call is measured twice: under the default bundled policy, and under
 * the shipped `team-ci` allowlist template (config/command-policy-templates.js,
 * the deployment's own `allowedCommands`). The default number is the policy's
 * raw cost; the template number is the cost a deployment that applied the
 * template actually pays. Both are reported because the target in the task
 * ("zero on read/diff/test/lint/plan") is only reachable with an allowlist.
 *
 * Usage:  node scripts/false-alarm-rate.js [--corpus <path>] [--json <path>]
 * Exit 0 = the corpus is well-formed (the rate is printed, met or not),
 * exit 1 = the corpus is missing or too small to mean anything.
 */

const fs = require('node:fs');
const path = require('node:path');

const { evaluateExternalAction } = require('../lib/external-action-guard');
const { evaluateAgentActionFirewall } = require('../lib/agent-action-firewall');
const { evaluateAutomationSafety } = require('../lib/automation-safety-gate');
const { POLICY_TEMPLATES } = require('../lib/command-policy-templates');

const repoRoot = path.resolve(__dirname, '..');
const DEFAULT_CORPUS = path.join(repoRoot, 'test', 'fixtures', 'false-alarm-corpus.json');
const MIN_SAFE = 500;
const MIN_RISKY = 100;

// The identity gate is orthogonal to what this measures and has its own suite
// (test/external-action-identity.test.js); with it on, every shell entry would
// stop for the same unrelated reason and swamp the rate. The
// benign-false-block-rate corpus makes the same choice.
const GUARD_OPTIONS = Object.freeze({ requireIdentityCard: false, requireSignedIdentityCard: false });

const TEAM_CI_ALLOWLIST = POLICY_TEMPLATES['team-ci'].allowedCommands;

/** A stopped call does not run without a human, whether spelled block or review. */
function stopped(decision) {
  return decision === 'block' || decision === 'review' || decision === 'dry_run_only';
}

/**
 * Route one corpus entry through the real decision path its `surface` names.
 * Returns the gate's decision string, or throws for an unknown surface (a
 * corpus entry that measures nothing must not read as a pass).
 */
function decide(entry, options = {}) {
  const { invocation } = entry;
  const surface = invocation.surface || entry.surface;
  const root = repoRoot;
  if (surface === 'shell' || surface === 'file-write') {
    return evaluateExternalAction({
      invocationId: entry.id,
      agentName: 'false-alarm-corpus',
      sessionId: 'false-alarm-rate',
      toolName: invocation.toolName,
      args: invocation.args,
      cwd: root,
      workspaceRoot: root,
    }, { ...GUARD_OPTIONS, ...options, receiptWriter: { append() {} } }).decision;
  }
  if (surface === 'agent-tool' || surface === 'step-enforcement') {
    return evaluateAgentActionFirewall({
      surface,
      tool: invocation.tool,
      action: invocation.action,
      input: invocation.input,
    }).decision;
  }
  if (surface === 'automation') {
    return evaluateAutomationSafety({
      operation: { action: invocation.action, operationType: invocation.action, target: invocation.input.target },
      operationType: invocation.action,
      target: invocation.input.target,
      actor: 'false-alarm-corpus',
      metadata: { source: 'false-alarm-rate' },
    }).decision;
  }
  throw new Error(`unknown corpus surface: ${surface}`);
}

function loadCorpus(corpusPath) {
  const document = JSON.parse(fs.readFileSync(corpusPath, 'utf8'));
  const safe = Array.isArray(document.safe) ? document.safe : [];
  const risky = Array.isArray(document.risky) ? document.risky : [];
  const problems = [];
  if (safe.length < MIN_SAFE) problems.push(`only ${safe.length} safe calls; ${MIN_SAFE} required`);
  if (risky.length < MIN_RISKY) problems.push(`only ${risky.length} risky calls; ${MIN_RISKY} required`);
  // Array membership must not stand in for a label: a `safe` entry without
  // `expected: allow` (or a `risky` entry without `expected: not_allow`) would
  // publish a rate from position alone.
  for (const [label, entries, expected] of [['safe', safe, 'allow'], ['risky', risky, 'not_allow']]) {
    for (const entry of entries) {
      if (!entry || typeof entry.id !== 'string' || !entry.invocation || entry.expected !== expected) {
        problems.push(`invalid ${label} corpus entry; expected ${JSON.stringify(expected)}: ${JSON.stringify(entry)}`);
      }
    }
  }
  return { document, safe, risky, problems };
}

/** Count by key, preserving insertion order so a report reads stably. */
function tally(entries, key) {
  const counts = new Map();
  for (const entry of entries) counts.set(entry[key], (counts.get(entry[key]) || 0) + 1);
  return counts;
}

/**
 * Run the safe corpus under one policy shape and return the false alarms and
 * the per-tier breakdown.
 */
function measureSafe(safe, options) {
  const alarms = [];
  const byTier = new Map();
  for (const entry of safe) {
    const decision = decide(entry, options);
    const tier = byTier.get(entry.tier) || { total: 0, stopped: 0 };
    tier.total += 1;
    if (stopped(decision)) {
      tier.stopped += 1;
      alarms.push({ id: entry.id, tier: entry.tier, decision, invocation: entry.invocation });
    }
    byTier.set(entry.tier, tier);
  }
  return { alarms, byTier, total: safe.length, stopped: alarms.length, rate: safe.length ? alarms.length / safe.length : 0 };
}

/** Run the risky corpus and return the calls the gate let through (misses). */
function measureRisky(risky) {
  const misses = [];
  const byCategory = new Map();
  for (const entry of risky) {
    const decision = decide(entry);
    const category = byCategory.get(entry.category) || { total: 0, allowed: 0 };
    category.total += 1;
    if (decision === 'allow') {
      category.allowed += 1;
      misses.push({ id: entry.id, category: entry.category, decision, invocation: entry.invocation });
    }
    byCategory.set(entry.category, category);
  }
  return { misses, byCategory, total: risky.length, allowed: misses.length, rate: risky.length ? misses.length / risky.length : 0 };
}

function pct(value) {
  return `${(value * 100).toFixed(2)}%`;
}

function describeInvocation(entry) {
  const invocation = entry.invocation;
  if (invocation.surface === 'shell' || invocation.surface === 'file-write') {
    return invocation.args.command || invocation.args.file_path;
  }
  return `${invocation.tool} ${invocation.action || ''}`.trim();
}

function report(label, safe, risky, out) {
  out(`\n=== ${label} ===`);
  out(`\nsafe calls stopped: ${safe.stopped}/${safe.total} (${pct(safe.rate)})`);
  for (const [tier, counts] of safe.byTier) {
    out(`  ${tier.padEnd(6)} ${String(counts.stopped).padStart(4)}/${String(counts.total).padEnd(4)} stopped`);
  }
  out(`risky calls allowed: ${risky.allowed}/${risky.total} (${pct(risky.rate)})`);
  for (const [category, counts] of risky.byCategory) {
    out(`  ${category.padEnd(12)} ${String(counts.allowed).padStart(3)}/${String(counts.total).padEnd(3)} allowed`);
  }
  if (safe.alarms.length) {
    out(`\nfirst safe calls stopped (${safe.alarms.length} total):`);
    for (const alarm of safe.alarms.slice(0, 10)) out(`  ${alarm.decision.padEnd(13)} [${alarm.tier}] ${describeInvocation(alarm)}`);
  }
  if (risky.misses.length) {
    out(`\nfirst risky calls allowed (${risky.misses.length} total):`);
    for (const miss of risky.misses.slice(0, 10)) out(`  [${miss.category}] ${describeInvocation(miss)}`);
  }
}

/**
 * The measurement a target is judged against. Only `team-ci` has its own
 * measurement (the shipped allowlist); every other name -- omitted, misspelled,
 * or a policy the report does not measure -- falls back to the bare default, so
 * a corpus cannot claim to meet a target by naming a policy that is not the one
 * actually measured.
 */
function selectTargetPolicy(target, { safeDefault, safeTeamCi }) {
  return target && target.policy === 'team-ci' ? safeTeamCi : safeDefault;
}

function targetVerdict(safe, target = {}) {
  const zeroTiers = Array.isArray(target.safeZeroTiers) ? target.safeZeroTiers : [];
  const reviewTiers = new Set(Array.isArray(target.reviewTiers) ? target.reviewTiers : []);
  const max = Number.isFinite(target.safeOverallMax) ? target.safeOverallMax : Infinity;
  // The ceiling is judged over every safe tier except the ones expected to ask
  // (reviewTiers). The zero tiers stay in the denominator -- they are safe calls
  // too, and their own rule is checked separately below -- but a `build` prompt
  // is not a false alarm, so that tier is left out rather than counted against
  // one overall number that would then hide which rule actually failed.
  let judgedTotal = 0;
  let judgedStopped = 0;
  for (const [tier, counts] of safe.byTier) {
    if (reviewTiers.has(tier)) continue;
    judgedTotal += counts.total;
    judgedStopped += counts.stopped;
  }
  const judgedRate = judgedTotal ? judgedStopped / judgedTotal : 0;
  const judgedTiers = [...safe.byTier.keys()].filter((tier) => !reviewTiers.has(tier));
  const lines = [];
  lines.push(`\ndeclared target (policy: ${target.policy || 'default'}): safe overall <= ${max === Infinity ? 'n/a' : pct(max)} over [${judgedTiers.join(', ') || 'no tier'}], zero on [${zeroTiers.join(', ')}], asking on [${[...reviewTiers].join(', ')}]`);
  lines.push(`  overall: ${judgedRate <= max ? 'MET' : 'NOT MET'} (${pct(judgedRate)} vs ${max === Infinity ? 'n/a' : pct(max)}; ${judgedStopped}/${judgedTotal} judged)`);
  for (const tier of zeroTiers) {
    const counts = safe.byTier.get(tier);
    if (!counts) { lines.push(`  ${tier}: no corpus entries`); continue; }
    lines.push(`  ${tier}: ${counts.stopped === 0 ? 'MET' : `NOT MET (${counts.stopped}/${counts.total} stopped)`}`);
  }
  return lines;
}

function main() {
  const args = process.argv.slice(2);
  const valueOf = (flag) => {
    const index = args.indexOf(flag);
    return index >= 0 ? args[index + 1] : null;
  };
  const corpusPath = valueOf('--corpus') ? path.resolve(valueOf('--corpus')) : DEFAULT_CORPUS;
  const jsonPath = valueOf('--json');

  if (!fs.existsSync(corpusPath)) {
    process.stderr.write(`false-alarm-rate: corpus not found: ${corpusPath}\n`);
    process.stderr.write('Build it with: node scripts/build-false-alarm-corpus.js\n');
    return 1;
  }

  const { document, safe, risky, problems } = loadCorpus(corpusPath);
  if (problems.length) {
    process.stderr.write(`false-alarm-rate: the corpus is unusable:\n`);
    for (const problem of problems) process.stderr.write(`  ${problem}\n`);
    return 1;
  }

  const lines = [];
  const out = (line) => lines.push(line);
  out(`false-alarm corpus: ${safe.length} safe, ${risky.length} risky (from ${document.measuredFrom || 'unknown'})`);

  const safeDefault = measureSafe(safe, {});
  const safeTeamCi = measureSafe(safe, { allowedCommands: TEAM_CI_ALLOWLIST });
  const riskyResult = measureRisky(risky);

  report('default bundled policy', safeDefault, riskyResult, out);
  report("'team-ci' allowlist template", safeTeamCi, riskyResult, out);
  // The declared target names the policy it is judged under. Only a policy the
  // report actually measures may be named: `team-ci` reads against its
  // allowlist, anything else (an omitted, misspelled or not-yet-supported name)
  // reads against the bare default, so a corpus cannot appear to meet a target
  // by naming a policy that is not the one measured.
  const target = document.target || {};
  const targetPolicy = selectTargetPolicy(target, { safeDefault, safeTeamCi });
  for (const line of targetVerdict(targetPolicy, target)) out(line);

  out('\nNOTE: this is a report. A miss or a false alarm is evidence, not a policy');
  out('change; the gate is left exactly as measured.');

  const text = `${lines.join('\n')}\n`;
  process.stdout.write(text);
  if (jsonPath) {
    fs.mkdirSync(path.dirname(path.resolve(jsonPath)), { recursive: true });
    fs.writeFileSync(path.resolve(jsonPath), `${JSON.stringify({
      schemaVersion: 'huqan.false-alarm-result.v1',
      measuredFrom: document.measuredFrom || null,
      target: document.target || null,
      default: summarize(safeDefault, riskyResult),
      teamCi: summarize(safeTeamCi, riskyResult),
    }, null, 2)}\n`, 'utf8');
  }
  return 0;
}

function summarize(safe, risky) {
  return {
    safe: {
      total: safe.total,
      stopped: safe.stopped,
      rate: Number(safe.rate.toFixed(6)),
      byTier: Object.fromEntries([...safe.byTier].map(([tier, counts]) => [tier, { ...counts }])),
      alarms: safe.alarms.map((a) => ({ id: a.id, tier: a.tier, decision: a.decision, call: describeInvocation(a) })),
    },
    risky: {
      total: risky.total,
      allowed: risky.allowed,
      rate: Number(risky.rate.toFixed(6)),
      byCategory: Object.fromEntries([...risky.byCategory].map(([category, counts]) => [category, { ...counts }])),
      misses: risky.misses.map((m) => ({ id: m.id, category: m.category, call: describeInvocation(m) })),
    },
  };
}

if (require.main === module) process.exit(main());

module.exports = { measureSafe, measureRisky, decide, loadCorpus, stopped, targetVerdict, selectTargetPolicy, MIN_SAFE, MIN_RISKY, GUARD_OPTIONS };
