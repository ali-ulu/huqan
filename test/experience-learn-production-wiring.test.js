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
const { callTool, TOOL_SCHEMAS } = require('../mcpServer');

const PARAMS = { path: 'notes.txt', oldText: 'draft', newText: 'final' };

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
}

function seedUnverified(journal, runId) {
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-start', type: 'run_started',
  }).ok, true);
  assert.equal(journal.append({
    runId, workspaceId: 'workspace-a', eventId: 'event-finished',
    type: 'execution_finished', executionStatus: 'completed',
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
    arguments: { runId: 'run-learn-positive', workspaceId: 'workspace-a' },
  });
  assert.equal(mcp.ok, true);
  // MCP carries no compile params, so the proposal seals a different body;
  // the source record and its admission must still be the same.
  assert.equal(mcp.data.sourceHash, direct.sourceHash);
  assert.equal(mcp.data.eligibility, direct.eligibility);
  assert.equal(mcp.data.registered, false);
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

test('the learn tool is registered and read-only on the MCP surface', () => {
  const names = TOOL_SCHEMAS.map((s) => s.name);
  assert.ok(names.includes('huqan.experience_learn'));
  const schema = TOOL_SCHEMAS.find((s) => s.name === 'huqan.experience_learn');
  assert.equal(schema.annotations.readOnlyHint, true);
  assert.equal(schema.annotations.destructiveHint, false);
});
