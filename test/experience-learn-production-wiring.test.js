'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const HuqanStorage = require('../storage');
const { resolveExperienceJournal } = require('../agentRuntime');
const { buildLearningProposal } = require('../lib/experience/learning-intake');
const { createCliCommandHandlers } = require('../lib/cli-command-handlers');
const { parseCommand, parseExperienceLearnArgs, parseExperienceReconcileArgs } = require('../lib/command-parser');
const { callTool, TOOL_SCHEMAS } = require('../mcpServer');

const PARAMS = { path: 'notes.txt', oldText: 'draft', newText: 'final' };

test('learning command preserves invalid JSON and missing operands for admission to reject', () => {
  assert.deepEqual(parseExperienceLearnArgs(), { runId: '', workspaceId: 'default', kind: undefined,
    params: undefined, parentVersion: undefined, sourceRunIds: undefined });
  assert.equal(parseExperienceLearnArgs('run --params {invalid').params, null);
  assert.equal(parseExperienceLearnArgs('run --parent-version 0').parentVersion, 0);
  assert.ok(Number.isNaN(parseExperienceLearnArgs('run --parent-version invalid').parentVersion));
  assert.equal(parseExperienceLearnArgs('run --parent-version --workspace w').parentVersion, undefined);
  assert.equal(parseExperienceLearnArgs('--workspace w --kind replace_text').runId, '');
});

test('reconciliation flags retain explicit evidence and never invent a missing operand', () => {
  assert.deepEqual(parseExperienceReconcileArgs(), { operationId: '', workspaceId: '', performed: false,
    notPerformed: false, reason: '' });
  assert.deepEqual(parseExperienceReconcileArgs('op --performed --workspace w --reason "disk read confirmed"'),
    { operationId: 'op', workspaceId: 'w', performed: true, notPerformed: false, reason: 'disk read confirmed' });
  assert.deepEqual(parseExperienceReconcileArgs('op extra --not-performed --reason --workspace'),
    { operationId: 'op', workspaceId: '', performed: false, notPerformed: true, reason: '' });
  assert.deepEqual(parseExperienceReconcileArgs('op --workspace --not-performed'),
    { operationId: 'op', workspaceId: '', performed: false, notPerformed: true, reason: '' });
});

function seedPositive(journal, runId) {
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-start', type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-finished',
    type: 'execution_finished', executionStatus: 'completed',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-verified', type: 'verification',
    verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
  }).ok, true);
  assert.equal(journal.close(runId).ok, true);
}

function seedUnverified(journal, runId) {
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-start', type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-finished',
    type: 'execution_finished', executionStatus: 'completed',
  }).ok, true);
  assert.equal(journal.close(runId).ok, true);
}

function seedOpen(journal, runId) {
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-start', type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-finished',
    type: 'execution_finished', executionStatus: 'completed',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-verified', type: 'verification',
    verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
  }).ok, true);
}

test('Experience learning is production-reachable through CLI and MCP from a real journal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  // Close before removing: Windows cannot unlink an open SQLite file.
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  assert.ok(journal, 'production Experience journal must be available');
  seedPositive(journal, 'run-learn-positive');
  seedUnverified(journal, 'run-learn-unverified');

  const direct = buildLearningProposal(journal, {
    runId: 'run-learn-positive', workspaceId: 'workspace-a', params: PARAMS,
  });
  assert.equal(direct.ok, true);
  assert.equal(direct.eligibility, 'positive_procedure');
  assert.equal(direct.admission.decision, 'admitted');
  assert.equal(direct.registered, false, 'a proposal must never install itself');

  const cliHandlers = createCliCommandHandlers({
    callMcpTool() { throw new Error('not used by experience-learn'); },
    createApprovalStoreFromKernel() { return null; },
  });
  const cliText = cliHandlers['experience-learn']({ kernel }, {
    runId: 'run-learn-positive', workspaceId: 'workspace-a', params: PARAMS,
  });
  assert.match(cliText, new RegExp(direct.hash, 'u'));

  const mcp = callTool(kernel, {
    name: 'huqan.experience_learn',
    arguments: { runId: 'run-learn-positive', workspaceId: 'workspace-a', params: PARAMS },
  });
  assert.equal(mcp.ok, true);
  // With the same compile params, the MCP path must reach the same proposal as
  // the direct call: same source record, same admission, and a compiled
  // procedure rather than a null one.
  assert.equal(mcp.data.sourceHash, direct.sourceHash);
  assert.equal(mcp.data.eligibility, direct.eligibility);
  assert.equal(mcp.data.registered, false);
  assert.equal(mcp.data.procedure.kind, 'replace_text');
  assert.deepEqual(mcp.data.procedure.params, PARAMS);

  const parsed = parseCommand('experience-learn run-learn-positive --workspace workspace-a');
  assert.equal(parsed.command, 'experience-learn');
  assert.deepEqual(parsed.args, {
    runId: 'run-learn-positive', workspaceId: 'workspace-a', kind: undefined, params: undefined,
    parentVersion: undefined, sourceRunIds: undefined,
  });
  const parsedParams = parseCommand(
    `experience-learn run-learn-positive --workspace workspace-a --params ${JSON.stringify(PARAMS)}`,
  );
  assert.deepEqual(parsedParams.args.params, PARAMS);
  assert.equal(parsedParams.args.runId, 'run-learn-positive');
  // A flag-like string inside the JSON payload is parameter data, not a command
  // flag: `--kind` here must not turn the default kind into `bogus`.
  const embeddedFlag = parseCommand(
    'experience-learn run-learn-positive --workspace workspace-a --params {"path":"notes.txt","oldText":"--kind bogus","newText":"final"}',
  );
  assert.equal(embeddedFlag.args.kind, undefined);
  assert.equal(embeddedFlag.args.runId, 'run-learn-positive');
  assert.equal(embeddedFlag.args.workspaceId, 'workspace-a');
  assert.deepEqual(embeddedFlag.args.params, { path: 'notes.txt', oldText: '--kind bogus', newText: 'final' });
  // A flag with a missing operand must not eat the next flag: `--workspace
  // --kind replace_text` is a missing workspace, not workspace `--kind`, and
  // `replace_text` must not become the runId.
  const missingOperand = parseCommand('experience-learn run --workspace --kind replace_text');
  assert.equal(missingOperand.args.workspaceId, 'default');
  assert.equal(missingOperand.args.kind, 'replace_text');
  assert.equal(missingOperand.args.runId, 'run');
});

test('a proposal carries a compiled procedure candidate but never installs it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-compile-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedPositive(journal, 'run-compile');

  const proposal = buildLearningProposal(journal, {
    runId: 'run-compile', workspaceId: 'workspace-a', params: PARAMS,
  });
  assert.equal(proposal.ok, true);
  assert.equal(proposal.candidate.status, 'candidate');
  assert.equal(proposal.procedure.kind, 'replace_text');
  assert.equal(proposal.procedure.version, 1);
  assert.equal(proposal.procedure.hash.length, 64);
  assert.deepEqual(proposal.procedure.params, PARAMS);
  assert.equal(proposal.registered, false);
});

test('an unverified run admits nothing and proposes no procedure', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-neg-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedUnverified(journal, 'run-unverified');

  const proposal = buildLearningProposal(journal, {
    runId: 'run-unverified', workspaceId: 'workspace-a', params: PARAMS,
  });
  assert.equal(proposal.ok, true);
  assert.notEqual(proposal.admission.decision, 'admitted');
  assert.equal(proposal.candidate, null);
  assert.equal(proposal.procedure, null);
  assert.equal(proposal.registered, false);
});

test('an open run is refused: a lesson cannot come from a record still being written', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-open-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedOpen(journal, 'run-open');
  assert.equal(journal.manifest('run-open').closed, false);

  const proposal = buildLearningProposal(journal, {
    runId: 'run-open', workspaceId: 'workspace-a', params: PARAMS,
  });
  assert.equal(proposal.ok, false);
  assert.equal(proposal.code, 'run_not_sealed');
});

test('MCP forwards replacement text byte-for-byte', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-exact-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedPositive(journal, 'run-exact');
  // The match and replacement text are literal; trimming them would change what
  // the procedure matches and writes, and would diverge from a direct proposal.
  const exact = { path: 'notes.txt', oldText: ' draft ', newText: ' final\n' };

  const direct = buildLearningProposal(journal, {
    runId: 'run-exact', workspaceId: 'workspace-a', params: exact,
  });
  const mcp = callTool(kernel, {
    name: 'huqan.experience_learn',
    arguments: { runId: 'run-exact', workspaceId: 'workspace-a', params: exact },
  });
  assert.equal(mcp.ok, true);
  assert.deepEqual(mcp.data.procedure.params, exact);
  assert.equal(mcp.data.hash, direct.hash);
});

test('MCP rejects malformed compile params without compiling', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-noparams-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedPositive(journal, 'run-no-params');

  const mcp = callTool(kernel, {
    name: 'huqan.experience_learn',
    arguments: { runId: 'run-no-params', workspaceId: 'workspace-a' },
  });
  assert.equal(mcp.ok, true);
  assert.equal(mcp.data.admission.decision, 'admitted');
  assert.equal(mcp.data.candidate.status, 'candidate');
  assert.equal(mcp.data.procedure, null);
  assert.equal(mcp.data.compileCode, 'bad_params');
  assert.equal(mcp.data.registered, false);

  // A params object that is not exactly three non-empty bounded strings fails
  // closed the same way rather than reaching the compiler malformed.
  const malformed = callTool(kernel, {
    name: 'huqan.experience_learn',
    arguments: { runId: 'run-no-params', workspaceId: 'workspace-a', params: { path: 'notes.txt', oldText: '', newText: 'final' } },
  });
  assert.equal(malformed.ok, true);
  assert.equal(malformed.data.procedure, null);
  assert.equal(malformed.data.compileCode, 'bad_params');
});

test('the learn tool is registered and read-only on the MCP surface', () => {
  const names = TOOL_SCHEMAS.map((s) => s.name);
  assert.ok(names.includes('huqan.experience_learn'));
  const schema = TOOL_SCHEMAS.find((s) => s.name === 'huqan.experience_learn');
  assert.equal(schema.annotations.readOnlyHint, true);
  assert.equal(schema.annotations.destructiveHint, false);
});

/** Seed a sealed, positively verified run so it can serve as a baseline. */
function seedSealedPositive(journal, runId) {
  // Seal the way production does: append the terminal `run_closed` event.
  // `journal.close(runId)` only sets an in-memory flag and does not survive a
  // restart, so it cannot back a read-back that must replay after restart.
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-start', type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-finished',
    type: 'execution_finished', executionStatus: 'completed',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-verified', type: 'verification',
    verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-closed', type: 'run_closed',
    causedByEventId: 'event-verified', executionStatus: 'completed', outcomeStatus: 'verified',
    payload: { verdict: 'complete', coverage: { covered: true } },
  }).ok, true);
}

test('a run reads its prior sealed run back as a checkable baseline (run A→B)', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-baseline-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedSealedPositive(journal, 'run-a');
  seedSealedPositive(journal, 'run-b');

  const baselineA = buildLearningProposal(journal, { runId: 'run-a', workspaceId: 'workspace-a' });
  assert.equal(baselineA.ok, true);
  assert.deepEqual(baselineA.baselineSourceHashes, [], 'a first run chains from nothing');

  const chained = buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'],
  });
  assert.equal(chained.ok, true);
  assert.deepEqual(chained.baselineSourceHashes, [baselineA.sourceHash]);

  // The baseline is bound into the proposal's identity: a proposal that names
  // no baseline is a different record, not the same record with a footnote.
  const unchained = buildLearningProposal(journal, { runId: 'run-b', workspaceId: 'workspace-a' });
  assert.equal(unchained.ok, true);
  assert.notEqual(unchained.hash, chained.hash);

  // The MCP surface reaches the same chained proposal from the same record.
  const mcp = callTool(kernel, {
    name: 'huqan.experience_learn',
    arguments: { runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'] },
  });
  assert.equal(mcp.ok, true);
  assert.deepEqual(mcp.data.baselineSourceHashes, [baselineA.sourceHash]);
  assert.equal(mcp.data.hash, chained.hash);
});

test('a baseline that is missing, open or mismatched refuses the proposal', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-baseline-refuse-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedSealedPositive(journal, 'run-a');
  seedSealedPositive(journal, 'run-b');
  seedOpen(journal, 'run-open');

  // A run in another workspace must not be readable as this workspace's
  // baseline, even though it is sealed and positively verified.
  assert.equal(journal.append({
    runId: 'run-other-ws', workspaceId: 'workspace-b', eventId: 'event-start', type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId: 'run-other-ws', workspaceId: 'workspace-b', eventId: 'event-finished',
    type: 'execution_finished', executionStatus: 'completed',
  }).ok, true);
  assert.equal(journal.append({
    runId: 'run-other-ws', workspaceId: 'workspace-b', eventId: 'event-verified', type: 'verification',
    verdict: 'verified',
    proofs: { integrity: true, coverage: true, verification: true, provenance: true, permission: true },
  }).ok, true);
  assert.equal(journal.append({
    runId: 'run-other-ws', workspaceId: 'workspace-b', eventId: 'event-closed', type: 'run_closed',
    causedByEventId: 'event-verified', executionStatus: 'completed', outcomeStatus: 'verified',
    payload: { verdict: 'complete', coverage: { covered: true } },
  }).ok, true);

  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a', 'run-a'],
  }).code, 'baseline_invalid', 'a duplicated baseline is invalid, not read twice');
  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: [],
  }).code, 'baseline_invalid', 'an empty baseline list is invalid, not "no baseline"');
  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-missing'],
  }).code, 'run_not_found');
  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-open'],
  }).code, 'baseline_not_sealed');
  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-other-ws'],
  }).code, 'baseline_workspace_mismatch');
  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'], kind: 'replace_text',
  }).ok, true, 'a valid baseline still succeeds');

  const mcp = callTool(kernel, {
    name: 'huqan.experience_learn',
    arguments: { runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-open'] },
  });
  assert.equal(mcp.ok, false);
  assert.equal(mcp.error.message, 'baseline_not_sealed');
});

test('a chained proposal replays identically across a journal restart', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-baseline-replay-'));
  const dbPath = path.join(root, 'memory.db');
  let storage = new HuqanStorage({ kernel: {}, dbPath });
  // Close before removing: Windows cannot unlink an open SQLite file, and the
  // reopen below replaces `storage`, so one hook must close the current handle
  // first. Two hooks would remove the directory while it is still open.
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel: {} }, storage);
  seedSealedPositive(journal, 'run-a');
  seedSealedPositive(journal, 'run-b');
  const before = buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'],
  });
  assert.equal(before.ok, true);

  // Restart: close the store and read the same record back through a new
  // handle and a new kernel. A seal that only lived in process memory would
  // not survive, so a chained proposal must replay from the durable record.
  storage.close();
  storage = new HuqanStorage({ kernel: {}, dbPath });
  const reopened = resolveExperienceJournal({ kernel: {} }, storage);
  const after = buildLearningProposal(reopened, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'],
  });
  assert.deepEqual(after.baselineSourceHashes, before.baselineSourceHashes);
  assert.equal(after.hash, before.hash);
});

test('a baseline whose record is corrupt is refused as an integrity mismatch', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-experience-learn-baseline-tamper-'));
  const kernel = {};
  const storage = new HuqanStorage({ kernel, dbPath: path.join(root, 'memory.db') });
  t.after(() => {
    storage.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const journal = resolveExperienceJournal({ kernel }, storage);
  seedSealedPositive(journal, 'run-a');
  seedSealedPositive(journal, 'run-b');

  // A tampered record is one the journal's integrity check rejects on read.
  // The chain must translate that into a baseline-specific refusal rather than
  // silently chaining from a record it could not verify.
  const corrupting = {
    read(runId, opts) {
      if (runId === 'run-a') {
        const error = new Error('record hash does not match');
        error.code = 'INTEGRITY_MISMATCH';
        throw error;
      }
      return journal.read(runId, opts);
    },
    manifest: (runId) => journal.manifest(runId),
  };

  const refused = buildLearningProposal(corrupting, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'],
  });
  assert.equal(refused.ok, false);
  assert.equal(refused.code, 'baseline_integrity_mismatch');

  // The same record read clean still chains, so the refusal is about the
  // record's integrity, not about chaining at all.
  assert.equal(buildLearningProposal(journal, {
    runId: 'run-b', workspaceId: 'workspace-a', sourceRunIds: ['run-a'],
  }).ok, true);
});
