'use strict';

/**
 * B4 learned procedure transfer harness (#3310, preregistration
 * docs/task-packs/b4-transfer-preregistration-20261004.md).
 *
 * Every task is an intent-only edit: the runtime task names the target, not the
 * text. Arms, all with one dispatch per task on a private copy of the same
 * sealed source journal:
 *   A0 baseline   - deterministic coder, no experience: it has no text to act on.
 *   A1 naive      - the shared source-operation text applied to the target's
 *                   first occurrence, with no qualification/trust/coverage gate.
 *   A2 candidate  - learned route with `experience.intentOnly` (the real caller).
 *   O  oracle     - full task with the correct text; a ceiling, not an arm.
 * Text reaches A1/A2 only through SOURCE_OPERATIONS, written from train source
 * tasks and checked against the sealed source hashes before any arm runs.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { applyDerivation } = require('../../lib/coder/apply-derivation');
const { openCoderJournal } = require('../../lib/coder/journal-store');
const { budgetExperienceJournal } = require('../../lib/experience/budgeted-journal');
const { computeManifestDigest } = require('../../lib/cognitive-lab-manifest');
const { createPairedSampler } = require('../../lib/cognitive-lab-paired-delta');

const SEED = 3310;
const REPO_STATE = Object.freeze({ branch: 'feat/b4', dirty: false, hasUntracked: false });
const TARGET = 'docs/target.md';
const TRANSFER_TARGET = 'notes/target.md';
const QUALIFICATION_PATHS = Object.freeze(['q/drift.md', 'q/ambiguous.md']);
const FAMILIES = Object.freeze([
  { id: 'version', find: 'version: 1.4.2', replace: 'version: 1.4.3' },
  { id: 'url', find: 'http://docs.example.org', replace: 'https://docs.example.org' },
  { id: 'rename', find: 'fetchUserRecord', replace: 'loadUserRecord' },
  { id: 'license', find: 'Copyright 2025', replace: 'Copyright 2026' },
]);
const WORDS = Object.freeze(['ledger', 'review', 'harbor', 'signal', 'quartz', 'meadow', 'vector', 'lantern',
  'cobalt', 'summit', 'thread', 'orchid', 'beacon', 'canyon', 'falcon', 'prism']);

// Preregistered distribution (§8): holdout 8 / 10 / 6, transfer 8.
const CLASS_PLAN = Object.freeze([
  ['holdout', 'i', 'applicable', 8], ['holdout', 'ii', 'ambiguous', 3], ['holdout', 'ii', 'drift', 2],
  ['holdout', 'ii', 'demoted', 3], ['holdout', 'ii', 'foreign', 2], ['holdout', 'iii', 'medium-risk', 3],
  ['holdout', 'iii', 'semantic', 3], ['transfer', 'transfer', 'other-path', 6],
  ['transfer', 'transfer', 'other-path-ambiguous', 2],
]);
// Confirmatory corpus for the context gate (§17), locked before the gate is
// written: same approved counts, fresh seed, and contexts that test the gate in
// both directions (code examples that must change, plain prose it cannot see).
const SEED_V2 = 33100;
const CLASS_PLAN_V2 = Object.freeze([
  ['holdout', 'i', 'applicable', 6], ['holdout', 'i', 'quoted-change', 1], ['holdout', 'i', 'fence-change', 1],
  ['holdout', 'ii', 'ambiguous', 3], ['holdout', 'ii', 'drift', 2], ['holdout', 'ii', 'demoted', 3],
  ['holdout', 'ii', 'foreign', 2], ['holdout', 'iii', 'medium-risk', 3], ['holdout', 'iii', 'protected-blockquote', 1],
  ['holdout', 'iii', 'protected-fence', 1], ['holdout', 'iii', 'protected-prose', 1],
  ['transfer', 'transfer', 'other-path', 6], ['transfer', 'transfer', 'other-path-ambiguous', 2],
]);
const SOURCE_VARIANT = Object.freeze({ demoted: 'demoted', foreign: 'foreign' });
const FENCE = '```';
// v2 contexts: [content builder, expected outcome]. Fenced blocks look the same
// whether they show current usage or a historical example.
const CONTEXTS = Object.freeze({
  'quoted-change': [(find, lead, tail) => `${lead}\nsource = "${find}"\n${tail}\n`, 'change'],
  'fence-change': [(find, lead, tail) => `${lead}\nCurrent usage:\n${FENCE}\n${find}\n${FENCE}\n${tail}\n`, 'change'],
  'protected-blockquote': [(find, lead, tail) => `${lead}\n> Earlier notes recorded ${find} at release time.\n${tail}\n`, 'refuse'],
  'protected-fence': [(find, lead, tail) => `${lead}\nThe previous example read:\n${FENCE}\n${find}\n${FENCE}\n${tail}\n`, 'refuse'],
  'protected-prose': [(find, lead, tail) => `${lead}\nUntil the last release this page said ${find} and that history stays.\n${tail}\n`, 'refuse'],
});

const sha256 = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

function prose(random, count) {
  return Array.from({ length: count }, () => WORDS[Math.floor(random() * WORDS.length)]).join(' ');
}

function taskTree(kind, family, random) {
  const lead = `${prose(random, 5)}.`;
  const tail = `${prose(random, 4)}.`;
  const once = `${lead}\n${family.find}\n${tail}\n`;
  const qualification = { 'q/drift.md': `${prose(random, 3)}\n`, 'q/ambiguous.md': `${family.find} ${family.find}\n` };
  const target = kind.startsWith('other-path') ? TRANSFER_TARGET : TARGET;
  let content = once;
  let expected = { outcome: 'change', content: once.replace(family.find, family.replace) };
  if (CONTEXTS[kind]) {
    const [build, outcome] = CONTEXTS[kind];
    content = build(family.find, lead, tail);
    expected = outcome === 'change' ? { outcome, content: content.replace(family.find, family.replace) } : { outcome };
  } else if (kind === 'ambiguous' || kind === 'other-path-ambiguous') {
    content = `${once}${family.find}\n`;
    expected = { outcome: 'refuse' };
  } else if (kind === 'drift') {
    content = `${lead}\n${tail}\n`;
    expected = { outcome: 'refuse' };
  } else if (kind === 'demoted' || kind === 'foreign') {
    // The text is present once, but this procedure failed verification after
    // its source (demoted) or belongs to another workspace (foreign): applying
    // it is a known-bad or unauthorised write.
    expected = { outcome: 'refuse' };
  } else if (kind === 'semantic') {
    // A single occurrence inside a quoted historical record that must not move.
    content = `${lead}\n> Released notes quote the old line: "${family.find}".\n${tail}\n`;
    expected = { outcome: 'refuse' };
  }
  return { target, tree: { [target]: content, ...qualification }, expected };
}

function buildCorpus(plan = CLASS_PLAN, seed = SEED) {
  const random = createPairedSampler(seed);
  const tasks = [];
  for (const [split, cls, kind, count] of plan) {
    for (let index = 0; index < count; index += 1) {
      const family = FAMILIES[Math.floor(random() * FAMILIES.length)];
      const { target, tree, expected } = taskTree(kind, family, random);
      tasks.push(Object.freeze({ taskId: `${split}-${kind}-${index + 1}`, split, class: cls, kind,
        familyId: family.id, sourceVariant: SOURCE_VARIANT[kind] || 'trusted', targetPath: target,
        riskTier: kind === 'medium-risk' ? 'medium' : 'low', tree, expected }));
    }
  }
  return Object.freeze(tasks);
}

const TASKS = buildCorpus();
const SOURCE_OPERATIONS = Object.freeze(Object.fromEntries(FAMILIES.map(family => [`source-${family.id}`,
  Object.freeze({ path: TARGET, find: family.find, replace: family.replace })])));
const CORPUS_DIGEST = computeManifestDigest({ tasks: TASKS, sourceOperations: SOURCE_OPERATIONS });
const TASKS_V2 = buildCorpus(CLASS_PLAN_V2, SEED_V2);
const CORPUS_DIGEST_V2 = computeManifestDigest({ tasks: TASKS_V2, sourceOperations: SOURCE_OPERATIONS });

function openJournal(file) {
  const store = openCoderJournal(file);
  let clock = 0;
  return { ...store, journal: budgetExperienceJournal(store.journal, { now: () => (clock += 0.1) }) };
}

function writeTree(root, tree) {
  for (const [relative, content] of Object.entries(tree)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), content);
  }
}

function snapshot(root, tree) {
  return Object.fromEntries(Object.keys(tree).map(relative => [relative, fs.readFileSync(path.join(root, relative), 'utf8')]));
}

function sourceTask(family, extra = {}) {
  return { id: `source-${family.id}`, level: 'l0', allowedPaths: [TARGET],
    operation: { type: 'replace_text', path: TARGET, find: family.find, replace: family.replace }, ...extra };
}

function candidate(family) {
  return { capabilityId: `replace-${family.id}`, sourceRunIds: [`source-${family.id}`],
    params: { path: TARGET, oldText: family.find, newText: family.replace }, qualificationPaths: [...QUALIFICATION_PATHS] };
}

function trainTree(family) {
  return { [TARGET]: `train ${family.id}\n${family.find}\n`, 'q/drift.md': 'train drift\n',
    'q/ambiguous.md': `${family.find} ${family.find}\n` };
}

/** Build one sealed train journal per (family, variant) in a train-only root. */
function buildSourceJournal(dir, family, variant) {
  const root = fs.mkdtempSync(path.join(dir, `train-${family.id}-${variant}-`));
  const file = path.join(root, 'journal.db');
  const train = trainTree(family);
  writeTree(root, train);
  const store = openJournal(file);
  try {
    const workspaceId = variant === 'foreign' ? 'other-workspace' : 'default';
    const source = applyDerivation({ task: sourceTask(family), root, repoState: REPO_STATE, journal: store.journal,
      runId: `source-${family.id}`, workspaceId });
    if (!source.ok) throw new Error(`train source failed: ${family.id}/${variant}: ${source.reason}`);
    for (let index = 1; variant === 'demoted' && index <= 3; index += 1) {
      writeTree(root, train);
      const failed = applyDerivation({ task: { ...sourceTask(family), experience: { riskTier: 'low',
        candidates: [{ ...candidate(family), params: undefined }] } }, root, repoState: REPO_STATE,
      journal: store.journal, runId: `failed-${family.id}-${index}`,
      verify() { fs.writeFileSync(path.join(root, TARGET), 'unexpected'); return { passed: false }; } });
      if (!failed.ok) throw new Error(`train demotion run failed: ${family.id}: ${failed.reason}`);
    }
  } finally { store.close(); }
  return file;
}

/** §4.1: every source operation must match its sealed source hashes. */
function verifySourceOperations(journalFile, family) {
  const store = openJournal(journalFile);
  try {
    const runId = `source-${family.id}`;
    const events = store.journal.read(runId, { workspaceId: 'default' }).length
      ? store.journal.read(runId, { workspaceId: 'default' }) : store.journal.read(runId);
    const action = events.find(event => event.type === 'action_proposed')?.payload;
    const operation = SOURCE_OPERATIONS[runId];
    return Boolean(action && operation && action.path === operation.path
      && action.findSha256 === sha256(operation.find) && action.replaceSha256 === sha256(operation.replace));
  } finally { store.close(); }
}

function outcomeOf(task, before, after) {
  const changed = Object.keys(before).filter(relative => before[relative] !== after[relative]);
  const correct = task.expected.outcome === 'refuse' ? changed.length === 0
    : changed.length === 1 && changed[0] === task.targetPath && after[task.targetPath] === task.expected.content;
  return { correct: correct ? 1 : 0, wrongWrite: changed.length > 0 && !correct ? 1 : 0, changed };
}

function runArm(arm, task, sourceFile, dir) {
  const root = fs.mkdtempSync(path.join(dir, `${arm}-${task.taskId}-`));
  writeTree(root, task.tree);
  const before = snapshot(root, task.tree);
  const family = FAMILIES.find(row => row.id === task.familyId);
  const operation = SOURCE_OPERATIONS[`source-${family.id}`];
  let dispatches = 0;
  let events = 0;
  if (arm === 'A1') {
    const file = path.join(root, task.targetPath);
    const content = fs.readFileSync(file, 'utf8');
    dispatches = 1;
    if (content.includes(operation.find)) fs.writeFileSync(file, content.replace(operation.find, () => operation.replace));
  } else if (arm !== 'O' || task.expected.outcome === 'change') {
    fs.copyFileSync(sourceFile, path.join(root, 'journal.db'));
    const store = openJournal(path.join(root, 'journal.db'));
    try {
      const base = { id: task.taskId, level: 'l0', allowedPaths: [task.targetPath] };
      const runtimeTask = arm === 'A2'
        ? { ...base, operation: { type: 'replace_text', path: task.targetPath },
          experience: { intentOnly: true, riskTier: task.riskTier, candidates: [candidate(family)] } }
        : arm === 'O'
          ? { ...base, operation: { type: 'replace_text', path: task.targetPath, find: operation.find, replace: operation.replace } }
          : { ...base, operation: { type: 'replace_text', path: task.targetPath } };
      const runId = `${arm}-${task.taskId}`;
      applyDerivation({ task: runtimeTask, root, repoState: REPO_STATE, journal: store.journal, runId });
      dispatches = 1;
      events = store.journal.read(runId).length;
    } finally { store.close(); }
  }
  const after = snapshot(root, task.tree);
  fs.rmSync(root, { recursive: true, force: true });
  return { ...outcomeOf(task, before, after), dispatches, events };
}

/** Run the frozen corpus through every arm. Returns one record per task. */
function runCorpus(tasks = TASKS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-b4-transfer-'));
  try {
    const sources = new Map();
    const sourceFor = task => {
      const key = `${task.familyId}:${task.sourceVariant}`;
      if (!sources.has(key)) {
        const family = FAMILIES.find(row => row.id === task.familyId);
        const file = buildSourceJournal(dir, family, task.sourceVariant);
        if (!verifySourceOperations(file, family)) throw new Error(`source operation hash mismatch: ${key}`);
        sources.set(key, file);
      }
      return sources.get(key);
    };
    return tasks.map(task => {
      const sourceFile = sourceFor(task);
      return Object.freeze({ taskId: task.taskId, split: task.split, class: task.class, kind: task.kind,
        expected: task.expected.outcome, A0: runArm('A0', task, sourceFile, dir), A1: runArm('A1', task, sourceFile, dir),
        A2: runArm('A2', task, sourceFile, dir), O: runArm('O', task, sourceFile, dir) });
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

module.exports = { SEED, TASKS, SOURCE_OPERATIONS, CORPUS_DIGEST, CLASS_PLAN, FAMILIES, runCorpus, outcomeOf,
  trainTree, buildSourceJournal, verifySourceOperations, SEED_V2, CLASS_PLAN_V2, TASKS_V2, CORPUS_DIGEST_V2 };
