'use strict';
// #4065 G1 synthetic control corpus (preregistration 2026-10-27, v3 §12).
// A group is two units from two different compute families; a unit is one
// seeded target function. Every task of a unit is a variant of that function:
// its examples train the synthesizer and its separate acceptance rows are the
// target's real outputs. No failure is injected.
const { createHash } = require('node:crypto');
const { inspectProjectProgram } = require('./coder/project-programs');
const { enumerateArrayExpressions } = require('./experience/array-fold-program');
const { createPairedSampler: mulberry32 } = require('./cognitive-lab-paired-delta');

const G1_CORPUS_SCHEMA = 'huqan-g1-corpus-v1';
const G1_SEED = 20261027;
const SPLIT_SIZES = Object.freeze({ train: 8, calibration: 8, holdout: 64 });
const FAMILIES = Object.freeze(['array-fold', 'array-guarded-fold', 'array-threshold-fold', 'array-stateful-fold', 'array-map', 'array-filter']);
const TRAIN_ROWS = 3;
const ACCEPTANCE_ROWS = 3;
const VARIANTS_PER_UNIT = 2;
const HISTORY_PER_KIND = 7; // DEFAULT_SUMMARY_WINDOW - 1 (lib/cognition/prediction-error.js)
const CMP6 = ['>', '>=', '<', '<=', '===', '!=='];
const SMALL = [-3, -2, -1, 0, 1, 2, 3];

const sha256 = value => createHash('sha256').update(value).digest('hex');
const canonical = value => JSON.stringify(value, (key, item) => (item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map(name => [name, item[name]])) : item));
const pick = (rng, list) => list[Math.floor(rng() * list.length)];
const leaves = [{ type: 'acc' }, { type: 'item' }, ...[0, 1, 2, 3].map(value => ({ type: 'integer', value }))];
const oneLevel = [...leaves];
for (const operator of ['+', '-', '*', '%']) for (const left of leaves) for (const right of leaves)
  oneLevel.push({ type: 'binary', operator, left, right });
const foldUpdates = enumerateArrayExpressions(true);
const mapExpressions = enumerateArrayExpressions(false);

const TARGETS = Object.freeze({
  'array-fold': rng => ({ type: 'fold', seed: pick(rng, [-1, 0, 1]), update: pick(rng, foldUpdates) }),
  'array-map': rng => ({ type: 'map', expression: pick(rng, mapExpressions) }),
  'array-filter': rng => ({ type: 'filter', guard: { operator: pick(rng, CMP6), threshold: pick(rng, SMALL) } }),
  'array-stateful-fold': rng => ({ type: 'stateful-fold', seed: pick(rng, ['first', 'empty']), emptyResult: pick(rng, [-1, 0, 1]),
    guard: { operator: pick(rng, ['>', '<', '===', '!==']) }, update: pick(rng, leaves) }),
  'array-guarded-fold': rng => ({ type: 'guarded-fold', seed: pick(rng, [-1, 0, 1]),
    guard: { operator: pick(rng, CMP6), threshold: pick(rng, SMALL) }, update: pick(rng, oneLevel) }),
  'array-threshold-fold': rng => ({ type: 'threshold-fold', seed: pick(rng, [-1, 0, 1]),
    guard: { operator: pick(rng, CMP6), threshold: Math.floor(rng() * 15) - 5 }, update: pick(rng, oneLevel) }),
});

const randomArray = rng => Array.from({ length: 1 + Math.floor(rng() * 4) }, () => Math.floor(rng() * 15) - 5);
const negativeZero = value => Object.is(value, -0) || (Array.isArray(value) && value.some(item => Object.is(item, -0)));

function rowsFor(rng, target, count, used) {
  const rows = [];
  for (let attempt = 0; rows.length < count && attempt < 200; attempt += 1) {
    const input = randomArray(rng);
    const key = JSON.stringify(input);
    if (used.has(key)) continue;
    let expected;
    try { expected = target.evaluate(input); } catch { continue; }
    if (negativeZero(expected)) continue;
    used.add(key); rows.push({ input, expected });
  }
  return rows.length === count ? rows : null;
}

// One variant: [] plus TRAIN_ROWS-1 training rows, then disjoint acceptance rows.
function variantFor(rng, target) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const empty = target.evaluate([]);
    const used = new Set(['[]']);
    const train = rowsFor(rng, target, TRAIN_ROWS - 1, used);
    const acceptance = rowsFor(rng, target, ACCEPTANCE_ROWS, used);
    if (train && acceptance && !negativeZero(empty)) return { examples: [{ input: [], expected: empty }, ...train], acceptanceExamples: acceptance };
  }
  return null;
}

function unitFor(rng, family, taken, variants) {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const target = inspectProjectProgram(TARGETS[family](rng));
    if (!target.ok) continue;
    try { target.evaluate([]); } catch { continue; }
    const key = `${family}:${target.canonicalExpression}`;
    if (taken.has(key)) continue;
    const rows = Array.from({ length: variants }, () => variantFor(rng, target));
    if (rows.some(row => !row)) continue;
    taken.add(key);
    return { family, workKind: `initialize_project:${family}`, target: JSON.parse(target.canonicalExpression), key, variants: rows };
  }
  throw new Error(`G1_CORPUS_UNIT_EXHAUSTED:${family}`);
}

function familyPairs(rng, count) {
  const pairs = [];
  // The first three groups are a perfect matching so train history covers every family.
  const order = fisherYates([...FAMILIES], rng);
  for (let at = 0; at < 6; at += 2) pairs.push([order[at], order[at + 1]]);
  while (pairs.length < count) {
    const first = pick(rng, FAMILIES);
    const second = pick(rng, FAMILIES.filter(family => family !== first));
    pairs.push([first, second]);
  }
  return pairs;
}

function sealGroup(units) {
  const body = { units: units.map(({ family, workKind, target, variants }) => ({ family, workKind, target, variants })) };
  const digest = sha256(canonical(body)).slice(0, 16);
  return { digest, ...body, unitDigests: body.units.map(unit => sha256(canonical(unit))) };
}

// Train groups carry extra variants: HISTORY_PER_KIND real Coder results per kind.
function buildG1Corpus({ seed = G1_SEED, sizes = SPLIT_SIZES } = {}) {
  const rng = mulberry32(seed >>> 0);
  const taken = new Set();
  const total = sizes.train + sizes.calibration + sizes.holdout;
  const pairs = familyPairs(rng, total);
  const groups = pairs.map((pair, index) => sealGroup(pair.map(family =>
    unitFor(rng, family, taken, index < sizes.train ? HISTORY_PER_KIND : VARIANTS_PER_UNIT))));
  const splits = { train: groups.slice(0, sizes.train), calibration: groups.slice(sizes.train, sizes.train + sizes.calibration),
    holdout: groups.slice(sizes.train + sizes.calibration) };
  return { schemaVersion: G1_CORPUS_SCHEMA, seed, sizes, protocol: { trainRows: TRAIN_ROWS, acceptanceRows: ACCEPTANCE_ROWS,
    variantsPerUnit: VARIANTS_PER_UNIT, historyPerKind: HISTORY_PER_KIND }, splits };
}

// Fail-closed split audit: UNAVAILABLE when it cannot run, LEAK when it finds one.
function auditSplits(corpus) {
  try {
    const seen = new Map();
    const leaks = [];
    for (const [split, groups] of Object.entries(corpus.splits)) for (const group of groups) {
      if (sealGroup(group.units).digest !== group.digest) return { status: 'UNAVAILABLE', reason: 'group_digest_mismatch', group: group.digest };
      for (const [at, unit] of group.units.entries()) {
        const program = inspectProjectProgram(unit.target);
        if (!program.ok) return { status: 'UNAVAILABLE', reason: 'unit_target_invalid', group: group.digest };
        for (const key of [`${unit.family}:${program.canonicalExpression}`, group.unitDigests[at], group.digest]) {
          const owner = seen.get(key);
          if (owner && owner !== split) leaks.push({ key, splits: [owner, split] });
          if (!owner) seen.set(key, split);
        }
      }
    }
    return leaks.length ? { status: 'LEAK', leaks } : { status: 'CLEAN', checked: seen.size };
  } catch (error) {
    return { status: 'UNAVAILABLE', reason: error.message };
  }
}

// Episode: two variants of each unit; order by Fisher-Yates over mulberry32(groupDigest[0..8] XOR seed).
function episodeTasks(group, seed) {
  const tasks = group.units.flatMap((unit, at) => unit.variants.slice(0, VARIANTS_PER_UNIT).map((variant, index) => ({
    id: `g1-${group.digest.slice(0, 8)}-${at}${index}`, workKind: unit.workKind, family: unit.family, ...variant })));
  return fisherYates(tasks, mulberry32((Number.parseInt(group.digest.slice(0, 8), 16) ^ seed) >>> 0));
}

function fisherYates(list, rng) {
  for (let at = list.length - 1; at > 0; at -= 1) {
    const other = Math.floor(rng() * (at + 1));
    [list[at], list[other]] = [list[other], list[at]];
  }
  return list;
}

// Offline prediction with the same synthesizer the Coder route calls; used only to
// pick calibration anti-case fixtures, never to score an episode.
function offlinePasses(family, variant) {
  const { produceComputedProject } = require('./coder/project-compute');
  const produced = produceComputedProject({ kind: 'project_spec', name: 'offline-api', archetype: 'node_computed_json_api',
    routes: [{ path: '/compute', compute: { family, ...variant } }] });
  if (!produced.ok) return false;
  const chosen = inspectProjectProgram(produced.computation.routes[0].program);
  return variant.acceptanceExamples.every(row => {
    try { return JSON.stringify(chosen.evaluate(row.input)) === JSON.stringify(row.expected); } catch { return false; }
  });
}

// Calibration anti-case fixtures (§8): extra variants of calibration units only.
function antiCaseFixtures(corpus, seed = G1_SEED) {
  const rng = mulberry32((seed ^ 0x5eed) >>> 0);
  const units = corpus.splits.calibration.flatMap(group => group.units.map(unit => ({ ...unit, group: group.digest })));
  const variantsOf = (unit, wanted, count) => {
    const target = inspectProjectProgram(unit.target);
    const found = [];
    for (let attempt = 0; found.length < count && attempt < 400; attempt += 1) {
      const variant = variantFor(rng, target);
      if (variant && offlinePasses(unit.family, variant) === wanted) found.push(variant);
    }
    return found.length === count ? found : null;
  };
  const task = (unit, variant, index, name) => ({ id: `g1-anti-${name}-${unit.group.slice(0, 6)}-${unit.family.slice(6)}-${index}`,
    workKind: unit.workKind, family: unit.family, ...variant });
  const pairOf = (wanted, name) => {
    for (let first = 0; first < units.length; first += 1) for (let second = 0; second < units.length; second += 1) {
      if (units[first].family === units[second].family) continue;
      const a = variantsOf(units[first], wanted, 2);
      const b = a && variantsOf(units[second], wanted, 2);
      if (a && b) return [...a.map((v, i) => task(units[first], v, i, name)), ...b.map((v, i) => task(units[second], v, i + 2, name))];
    }
    return null;
  };
  const single = (() => {
    const unit = units[0];
    const mixed = [...(variantsOf(unit, true, 2) || []), ...(variantsOf(unit, false, 2) || [])];
    return mixed.length === 4 ? mixed.map((v, i) => task(unit, v, i, 'single')) : null;
  })();
  return { noFailure: pairOf(true, 'pass'), bothFail: pairOf(false, 'fail'), singleKind: single };
}

function corpusDigest(corpus) {
  return sha256(canonical({ schemaVersion: corpus.schemaVersion, seed: corpus.seed, protocol: corpus.protocol,
    splits: Object.fromEntries(Object.entries(corpus.splits).map(([split, groups]) => [split, groups.map(group => group.digest)])) }));
}

module.exports = { G1_CORPUS_SCHEMA, G1_SEED, SPLIT_SIZES, FAMILIES, HISTORY_PER_KIND, VARIANTS_PER_UNIT,
  buildG1Corpus, auditSplits, episodeTasks, antiCaseFixtures, offlinePasses, corpusDigest, canonical, sha256 };
