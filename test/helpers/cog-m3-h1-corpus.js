'use strict';

/**
 * COG-M3 H1 independent family corpus (#4465).
 *
 * Builds a locked, independent family corpus from *real* sealed Coder runs and
 * drives the real M3 family evaluator. Nothing is mocked: real `applyDerivation`
 * / `runFixLoop` runs write real hash-chained journal rows, and the M3 adapter
 * re-derives every native outcome from those sealed runs against a separate
 * oracle.
 *
 * Family shape (preregistration §4):
 *   - each family owns its own sealed source journal for one distinct
 *     capability, so families never share a source artifact;
 *   - the source split is the family's own runs, the qualification split is the
 *     replay request's held-out inputs, the evaluation split is the holdout /
 *     transfer task; the three groups are disjoint;
 *   - six negative runs (older) and thirty positive runs (newer) per family make
 *     the priority arm and the recent-K arm select different support sets
 *     (non-inert) — the adapter's `selection_inert` guard rejects a corpus whose
 *     arms never disagree, so a measurable corpus must diverge.
 *
 * The sealed source records both `positive_procedure` and `negative_example`
 * eligibility: the negatives come from a `runFixLoop` whose test never passes,
 * so the loop rolls the write back and closes the run failed — a real negative
 * the reward signal scores at -1.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openJournalConnection } = require('../../lib/experience/journal-connection');
const { createExperienceJournal } = require('../../lib/experience/journal');
const { readSealedRun } = require('../../lib/experience/learning-intake');
const { applyDerivation } = require('../../lib/coder/apply-derivation');
const { runFixLoop } = require('../../lib/coder/fix-loop');
const { runReplayComparison } = require('../../lib/cli-replay');
const { emptyMutationJournal } = require('../../lib/mutation-journal');
const { sha256Hex, stableStringify } = require('../../lib/hash-chain');
const { CONTRACT } = require('../../lib/cognitive-lab-b4-evaluator');
const { runM3FamilyExperiment } = require('../../lib/cognitive-lab-m3-experiment');

const SCHEMA = 'huqan-cog-m3-family-evaluation-v1';
const PROTOCOL_FILE = path.resolve(__dirname, '../../docs/task-packs/cog-m3-family-evaluation-contract.md');
const REPO_STATE = Object.freeze({ branch: 'fixture/m3-h1', dirty: false, hasUntracked: false });

// §4: six negatives older than thirty positives. K is fixed at 32 (the adapter's
// budget), so a family needs more than 32 episodes before the two arms can pick
// different support sets; 36 keeps the priority arm's consistency at 30/36 ≥ 0.8
// while still diverging from recent-K.
const NEGATIVES = 6;
const POSITIVES = 30;

function protocolHash() {
  return sha256Hex(fs.readFileSync(PROTOCOL_FILE, 'utf8').replace(/\r\n/g, '\n'));
}

function makeClock(startMs) {
  let clock = startMs;
  return () => new Date((clock += 1000)).toISOString();
}

/** One family: sealed source journal (negatives then positives) + replay request. */
function buildFamily(root, index, sourceClock) {
  const familyId = `eval-family-${index}`;
  const capabilityId = `h1-cap-${index}`;
  // Disjoint find/replace: the compile postcondition requires the replacement to
  // no longer contain the old text.
  const target = `value-${index}.js`;
  const find = `alpha${index}`;
  const replace = `beta${index}`;
  const dir = path.join(root, familyId);
  fs.mkdirSync(dir);
  const sourceRoot = path.join(dir, 'source');
  fs.mkdirSync(sourceRoot);
  const db = path.join(dir, 'source.db');

  const store = openJournalConnection({ dbPath: db });
  try {
    const journal = createExperienceJournal({ store });
    for (let i = 0; i < NEGATIVES; i += 1) {
      fs.writeFileSync(path.join(sourceRoot, target), `neg ${index} ${i} ${find}`);
      fs.writeFileSync(path.join(sourceRoot, 'check.js'), "require('node:assert/strict').fail('never');");
      runFixLoop({
        task: { id: `neg-${index}-${i}`, level: 'l0', allowedPaths: [target],
          operation: { type: 'replace_text', path: target, find, replace },
          test: { command: 'node check.js' } },
        root: sourceRoot, journal, workspaceId: 'default', repoState: REPO_STATE,
        authorized: true, runId: `n-${index}-${i}`, now: sourceClock,
      });
    }
    for (let i = 0; i < POSITIVES; i += 1) {
      fs.writeFileSync(path.join(sourceRoot, target), `pos ${index} ${i} ${find}`);
      applyDerivation({
        task: { id: `pos-${index}-${i}`, level: 'l0', allowedPaths: [target],
          operation: { type: 'replace_text', path: target, find, replace } },
        root: sourceRoot, journal, repoState: REPO_STATE,
        authorized: true, runId: `p-${index}-${i}`, now: sourceClock,
      });
    }
  } finally { store.close(); }

  const predictionFile = path.join(dir, 'prediction.json');
  const replayFile = path.join(dir, 'replay.json');
  fs.writeFileSync(predictionFile, JSON.stringify(emptyMutationJournal()));
  fs.writeFileSync(replayFile, JSON.stringify({ capabilityId, parentVersion: 0,
    params: { path: target, oldText: find, newText: replace },
    qualificationInputs: [{ id: 'qualification', before: `q ${index} ${find}`, expectedAfter: `q ${index} ${replace}` }] }));

  return { familyId, capabilityId, target, find, replace, dir, db, predictionFile, replayFile };
}

/**
 * Run one arm against one family and return the sealed slot the adapter expects.
 *
 * Each arm gets its own copy of the family journal: two arms that share one
 * journal bind the same capabilityId to two different procedure hashes (the
 * recent-K and priority arms compile different supports), and `replayCoderTrust`
 * refuses that as `capability_binding_changed`. The copy is the family journal
 * plus this arm's native run, so the arm's own history is self-consistent.
 */
function runArm(family, arm, candidates, nativeClock, { tag = '' } = {}) {
  if (candidates.length === 0) return null;
  const label = `${arm}${tag}`;
  const armDb = path.join(family.dir, `arm-${label}.db`);
  fs.copyFileSync(family.db, armDb);
  const root = path.join(family.dir, `arm-${label}`);
  fs.mkdirSync(root);
  // Same target path, different held-out content: the arm's bound procedure hash
  // stays the source candidate's, while the input the arm must fix is fresh.
  const held = `held ${tag ? `${tag} ` : ''}${family.find}`;
  fs.writeFileSync(path.join(root, family.target), held);
  fs.writeFileSync(path.join(root, 'drift.md'), 'no matching token');
  fs.writeFileSync(path.join(root, 'ambiguous.md'), `${family.find} ${family.find}`);
  fs.writeFileSync(path.join(root, 'check.js'),
    `require('node:assert/strict').equal(require('node:fs').readFileSync(${JSON.stringify(family.target)},'utf8'),`
    + `${JSON.stringify(`held ${tag ? `${tag} ` : ''}${family.replace}`)});`);

  const candidate = candidates[0];
  const store = openJournalConnection({ dbPath: armDb });
  try {
    const journal = createExperienceJournal({ store });
    runFixLoop({
      task: { id: `held-${family.familyId}-${label}`, level: 'l0', allowedPaths: [family.target],
        operation: { type: 'replace_text', path: family.target }, test: { command: 'node check.js' },
        experience: { intentOnly: true, riskTier: 'low', candidates: [{
          capabilityId: candidate.capabilityId, sourceRunIds: candidate.support,
          compiledSupport: candidate.compiledSupport, sourceProcedureHash: candidate.procedure.hash,
          params: candidate.procedure.params, qualificationPaths: ['drift.md', 'ambiguous.md'] }] } },
      root, journal, workspaceId: 'default', repoState: REPO_STATE,
      authorized: true, runId: `held-${family.familyId}-${label}`, now: nativeClock,
    });
    const runId = `held-${family.familyId}-${label}:c1`;
    const sealed = readSealedRun(journal, runId, 'default');
    if (!sealed.ok) return null;
    return { runId, sourceHash: sealed.sourceHash, journal: armDb };
  } finally { store.close(); }
}

function slotFor(arm, root) {
  return { journal: path.relative(root, arm.journal), journalHash: sha256Hex(fs.readFileSync(arm.journal)),
    runId: arm.runId, sourceHash: arm.sourceHash };
}

/**
 * Build the corpus and drive the real M3 adapter.
 *
 * @returns {{ root: string, request: object, report: object, families: object[] }}
 */
function runM3H1Corpus({ holdoutFamilies = 24, transferFamilies = 8 } = {}) {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'cog-m3-h1-')));
  const sourceClock = makeClock(Date.UTC(2026, 9, 20, 0, 0, 0));
  const nativeClock = makeClock(Date.UTC(2026, 9, 26, 0, 0, 0));
  // The replay cutoff sits between the source runs (20 Oct) and the native arms
  // (26 Oct): the source split is in the past, the evaluation split is not.
  const asOf = '2026-10-25T00:00:00.000Z';

  const families = [], tasks = [], records = [], oracleRows = [], built = [];
  for (let i = 0; i < holdoutFamilies; i += 1) {
    const family = buildFamily(root, i, sourceClock);
    const replay = runReplayComparison(['--from-replay', '--dry-run', '--journal', family.db,
      '--prediction-journal', family.predictionFile, '--workspace', 'default',
      '--request', family.replayFile, '--budget', '32'], { asOf });
    const recent = replay.recent.candidates.filter(row => row.procedure);
    const priority = replay.priority.candidates.filter(row => row.procedure);
    const isTransfer = i < transferFamilies;
    const A1 = runArm(family, 'A1', recent, nativeClock);
    const A2 = runArm(family, 'A2', priority, nativeClock);
    const T1 = isTransfer ? runArm(family, 'A1', recent, nativeClock, { tag: 'T' }) : null;
    const T2 = isTransfer ? runArm(family, 'A2', priority, nativeClock, { tag: 'T' }) : null;

    const oracleId = `oracle-${i}`;
    oracleRows.push({ id: oracleId, expected: 'change',
      files: [{ path: family.target, sha256: sha256Hex(`held ${family.replace}`) }] });
    tasks.push({ taskId: `task-${i}`, familyId: family.familyId, split: 'holdout', oracleId });
    if (isTransfer) {
      const transferOracle = `oracle-${i}-transfer`;
      oracleRows.push({ id: transferOracle, expected: 'change',
        files: [{ path: family.target, sha256: sha256Hex(`held T ${family.replace}`) }] });
      tasks.push({ taskId: `task-${i}-transfer`, familyId: family.familyId, split: 'transfer', oracleId: transferOracle });
    }
    // The journal hash is taken after every native arm has written its run: the
    // adapter locks the final bytes and fails closed on any later change.
    families.push({ familyId: family.familyId, journal: path.relative(root, family.db),
      predictionJournal: path.relative(root, family.predictionFile), request: path.relative(root, family.replayFile),
      journalHash: sha256Hex(fs.readFileSync(family.db)),
      predictionHash: sha256Hex(fs.readFileSync(family.predictionFile)),
      requestHash: sha256Hex(fs.readFileSync(family.replayFile)) });
    if (A1 && A2) records.push({ taskId: `task-${i}`, A1: slotFor(A1, root), A2: slotFor(A2, root) });
    if (T1 && T2) records.push({ taskId: `task-${i}-transfer`, A1: slotFor(T1, root), A2: slotFor(T2, root) });
    built.push({ familyId: family.familyId, A1: replay.recent.selected.map(row => row.episodeId),
      A2: replay.priority.selected.map(row => row.episodeId),
      sourceEligibility: sourceEligibility(family.db) });
  }

  const oracleFile = path.join(root, 'oracle.json');
  fs.writeFileSync(oracleFile, JSON.stringify({ schemaVersion: SCHEMA, rows: oracleRows }));
  const request = { schemaVersion: SCHEMA, contract: { ...CONTRACT }, workspaceId: 'default', asOf,
    splits: { source: ['source-split'], qualification: ['qualification-split'],
      evaluation: families.map(family => family.familyId) },
    families, tasks, records, oracleFile: 'oracle.json',
    oracleHash: sha256Hex(fs.readFileSync(oracleFile)), protocolHash: protocolHash() };
  delete request.lockHash;
  request.lockHash = sha256Hex(stableStringify(request));
  const requestFile = path.join(root, 'request.json');
  fs.writeFileSync(requestFile, JSON.stringify(request));

  return { root, requestFile, request, report: runM3FamilyExperiment(requestFile), families: built };
}

/** Count the sealed eligibility mix of a family journal — the corpus's own audit. */
function sourceEligibility(db) {
  const store = openJournalConnection({ dbPath: db });
  const counts = {};
  try {
    const journal = createExperienceJournal({ store });
    for (const id of journal.runIds('default')) {
      const sealed = readSealedRun(journal, id, 'default');
      const key = sealed.ok ? sealed.manifest.learningEligibility : sealed.code;
      counts[key] = (counts[key] || 0) + 1;
    }
  } finally { store.close(); }
  return counts;
}

module.exports = { runM3H1Corpus, sourceEligibility, NEGATIVES, POSITIVES, SCHEMA };
