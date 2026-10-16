'use strict';

// Pins every decision the sandbox isolation gate reaches, field for field (#2135).
// The file split in that issue moves this code; no decision may move with it.
//
// Every path below is one no host has, so containment stays lexical and the
// fixture reads the same on Windows, Linux and macOS (no /tmp: it is a symlink
// to /private/tmp on macOS, and realpath would make that host disagree).
//
// Regenerate only on purpose: UPDATE_SANDBOX_ISOLATION_FIXTURE=1 node --test <this file>

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const gate = require('../lib/sandbox-isolation');

const FIXTURE = path.join(__dirname, 'fixtures', 'sandbox-isolation-decisions.json');
const UNDEFINED = '__undefined__';

function snapshot(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => (item === undefined ? UNDEFINED : item)));
}

function capture(fn) {
  try {
    return snapshot(fn());
  } catch (error) {
    return { threw: String(error && error.message) };
  }
}

const ROOT = '/huqan-sbx-fixture/root';
const WIN_ROOT = 'C:\\huqan-sbx-fixture\\root';
const BASE = { source: 'return 1 + 1', sourceTrust: 'validated', runner: 'node:vm' };

// One dimension changes per variant; the base alone is the allow path.
const VARIANTS = {
  base: {},
  notObject: null,
  arrayInput: [],
  emptySource: { source: '' },
  sourceNumber: { source: 42 },
  forbiddenRequire: { source: 'require("child_process")' },
  forbiddenImport: { source: 'await import("x")' },
  wordBoundaryFalsePositive: { source: 'evaluation of offshore globals_x' },
  wordBoundaryLeft: { source: 'prefetch(u); myrequire(x); unsafe_eval' },
  externalFetch: { source: 'fetch(url)' },
  forbiddenAndNetwork: { source: 'require("https").get(u)' },
  accentedDelete: { source: 'dÉlete', context: { tempPath: '/huqan-sbx-fixture/elsewhere/t.tmp', sandboxRoot: ROOT } },
  untrusted: { sourceTrust: 'untrusted' },
  unknownTrust: { sourceTrust: undefined },
  bogusTrust: { sourceTrust: 'Mostly' },
  upperTrust: { sourceTrust: 'VALIDATED' },
  workerRunner: { runner: 'worker' },
  isolatedVmRunner: { runner: 'isolated-vm' },
  unknownRunner: { runner: 'docker' },
  timeoutDefaultEdge: { timeoutMs: 1000 },
  timeoutOverDefault: { timeoutMs: 1001 },
  timeoutWarn: { timeoutMs: 600 },
  timeoutHuge: { timeoutMs: 60000 },
  timeoutFractional: { timeoutMs: 999.6 },
  timeoutNegative: { timeoutMs: -5 },
  rollbackNoSnapshot: { isRollback: true },
  rollbackWithSnapshot: { isRollback: true, hasSnapshot: true },
  rollbackEmptySource: { isRollback: true, hasSnapshot: true, source: '' },
  snapshotCountAbuse: { snapshotCount: 51 },
  snapshotDepthAbuse: { snapshotDepth: 21, hasSnapshot: true },
  snapshotDepthThree: { snapshotDepth: 3, hasSnapshot: true },
  snapshotTruthyNotTrue: { hasSnapshot: 'yes', isRollback: 1 },
  tempInside: { context: { tempArtifactPath: `${ROOT}/out/a.tmp`, sandboxRoot: ROOT } },
  tempOutside: { context: { artifactPath: '/huqan-sbx-fixture/other/a.tmp', workspaceRoot: ROOT } },
  tempTraversal: { context: { tempPath: `${ROOT}/../escape.tmp`, root: ROOT } },
  tempRelativeTraversal: { context: { outputPath: '../escape.tmp', sandboxRoot: ROOT } },
  tempMissingRoot: { context: { filePath: `${ROOT}/a.tmp` } },
  tempExplicitOutside: { context: { tempOutsideSandbox: true } },
  tempOutsideFlagAlias: { context: { outsideSandbox: true, sandboxRoot: ROOT } },
  tempFromMetadata: { metadata: { tempArtifactPath: '/huqan-sbx-fixture/other/m.tmp', sandboxRoot: ROOT, workspaceId: 'tenant-m' } },
  tempMixedGrammar: { context: { path: `${WIN_ROOT}\\a.tmp`, sandboxRoot: ROOT } },
  tempWindowsInside: { context: { path: `${WIN_ROOT}\\sub\\a.tmp`, sandboxRoot: WIN_ROOT } },
  tempWindowsOutside: { context: { path: 'C:\\huqan-sbx-fixture\\other\\a.tmp', sandboxRoot: WIN_ROOT } },
  cleanupOutside: { source: 'purge everything', context: { tempPath: '/huqan-sbx-fixture/other/a.tmp', sandboxRoot: ROOT } },
  cleanupInside: { context: { action: 'cleanup', tempPath: `${ROOT}/a.tmp`, sandboxRoot: ROOT } },
  cleanupFlagMissingRoot: { context: { destructiveCleanup: true, tempPath: `${ROOT}/a.tmp` } },
  cleanupOutsideFlag: { context: { cleanupOutsideSandbox: true, tempOutsideSandbox: true } },
  cleanupWithoutArtifact: { context: { operation: 'wipe' } },
  bindingsAndWorkspace: { bindings: { a: 1 }, metadata: { workspaceId: 'tenant-b' } },
  everythingWrong: { source: 'require("fs"); fetch(u)', sourceTrust: 'untrusted', runner: '??', timeoutMs: 4000, snapshotCount: 99, context: { tempPath: '../x', sandboxRoot: ROOT } },
};

const POLICIES = {
  none: undefined,
  minQuarantine: { minimumDecision: 'quarantine' },
  minRollback: { minimumDecision: 'ROLLBACK' },
  minBogus: { minimumDecision: 'sometimes' },
  timeout3000: { maximumTimeoutMs: 3000 },
  timeoutOverCap: { maximumTimeoutMs: 99999.4 },
  noNetwork: { allowExternalNetwork: false },
  noUntrusted: { allowUntrustedSource: false },
  legacyAliasOnly: { allowUntustedSource: false },
  aliasConflict: { allowUntrustedSource: true, allowUntustedSource: false },
  maxDepthTwo: { maxSnapshotDepth: 2.4 },
  notObject: 'block',
};

function inputFor(variant) {
  if (variant === null || Array.isArray(variant)) return variant;
  return { ...BASE, ...variant };
}

function decisionScenarios() {
  const out = {};
  for (const [name, variant] of Object.entries(VARIANTS)) {
    const input = inputFor(variant);
    out[`normalize/${name}`] = capture(() => gate.normalizeSandboxInput(input));
    out[`classify/${name}/none`] = capture(() => gate.classifySandboxOperation(gate.normalizeSandboxInput(input)));
    out[`classify/${name}/timeout3000`] = capture(() => gate.classifySandboxOperation(gate.normalizeSandboxInput(input), { maximumTimeoutMs: 3000 }));
    for (const [policyName, policy] of Object.entries(POLICIES)) {
      out[`evaluate/${name}/${policyName}`] = capture(() => gate.evaluateSandboxIsolation(input, policy === undefined ? undefined : { policy }));
    }
  }
  out['evaluate/no-arguments'] = capture(() => gate.evaluateSandboxIsolation());
  return out;
}

function helperScenarios() {
  const out = {};
  const findings = {
    notArray: 'x',
    empty: [],
    mixed: [{ code: 'A', decision: 'quarantine', risk: 'high' }, { code: '', decision: 'rollback', risk: 'medium' }, { decision: 'allow', risk: 'bogus' }],
    unknownDecision: [{ code: 'Z', decision: 'maybe', risk: 'critical' }],
  };
  for (const [name, list] of Object.entries(findings)) {
    out[`summarize/${name}`] = capture(() => gate.summarizeSandboxFindings(list));
  }
  const decisions = {
    notObject: 'allow',
    empty: {},
    loose: {
      ok: 1,
      allowed: true,
      decision: 'ALLOW',
      reason: 7,
      risk: { level: 'Critical', score: 4 },
      findings: [{ code: 3, decision: 'nope', risk: 'LOW', detail: null }],
      summary: { count: '2', worstDecision: 'rollback', worstRisk: 'x', codes: [1, 'b'] },
      warnings: ['w', 2],
      metadata: { policyVersion: null, workspaceId: '', runner: 'worker', hasSnapshot: 'true', snapshotDepth: '4' },
    },
  };
  for (const [name, decision] of Object.entries(decisions)) {
    out[`normalizeDecision/${name}`] = capture(() => gate.normalizeSandboxIsolationDecision(decision));
  }
  const evaluated = gate.evaluateSandboxIsolation(inputFor(VARIANTS.everythingWrong));
  out['normalizeDecision/roundTrip'] = capture(() => gate.normalizeSandboxIsolationDecision(evaluated));
  return out;
}

function surface() {
  const enums = ['SANDBOX_ISOLATION_DECISIONS', 'SANDBOX_ISOLATION_REASONS', 'SANDBOX_RISK_LEVELS', 'SOURCE_TRUST_LEVELS', 'RUNNER_TYPES'];
  return snapshot({
    exports: Object.keys(gate),
    types: Object.fromEntries(Object.entries(gate).map(([key, value]) => [key, typeof value])),
    constants: Object.fromEntries(Object.entries(gate).filter(([, value]) => typeof value !== 'function')),
    frozen: enums.map(name => Object.isFrozen(gate[name])),
  });
}

test('sandbox isolation decisions match the recorded characterisation', () => {
  const actual = { surface: surface(), runs: { ...decisionScenarios(), ...helperScenarios() } };

  if (process.env.UPDATE_SANDBOX_ISOLATION_FIXTURE === '1') {
    fs.mkdirSync(path.dirname(FIXTURE), { recursive: true });
    // One scenario per line keeps a real decision change reviewable as a one-line diff.
    const runs = Object.entries(actual.runs).map(([key, run]) => `    ${JSON.stringify(key)}: ${JSON.stringify(run)}`);
    fs.writeFileSync(FIXTURE, `{\n  "surface": ${JSON.stringify(actual.surface)},\n  "runs": {\n${runs.join(',\n')}\n  }\n}\n`);
  }

  const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(actual.surface, expected.surface);
  assert.deepEqual(Object.keys(actual.runs), Object.keys(expected.runs));
  for (const key of Object.keys(expected.runs)) {
    assert.deepEqual(actual.runs[key], expected.runs[key], key);
  }
});
