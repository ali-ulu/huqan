'use strict';

// Shared fixture for the #4065 HTTP Coder routes: a real Git source repository,
// a real oversight runtime on the kernel graph, a real experience journal and
// the production createAgent. Requests go straight to the route handler.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const KernelV2 = require('../../kernel.v2');
const { createAgent } = require('../../agentRuntime');
const { createTrustEvidenceLedger } = require('../../lib/trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('../../lib/human-oversight-approval-runtime');
const { createExperienceJournal } = require('../../lib/experience/journal');
const { openJournalConnection } = require('../../lib/experience/journal-connection');
const { createMcpOperatorCapability } = require('../../lib/mcp-operator-capability');
const { operatorCapabilityBinding } = require('../../lib/mcp/operator-authorization');
const { createAgentCoderRoutes } = require('../../lib/http/agent-coder-routes');

const SECRET = 'coder-operator-secret';
const HEADER = 'x-huqan-operator-capability';
const GOAL = 'create the approved double API';

function projectSpec(failing = false) {
  return { kind: 'project_spec', name: 'double-api', archetype: 'node_computed_json_api',
    routes: [{ path: '/double', compute: { family: 'array-map', examples: [
      { input: [], expected: [] }, { input: [2], expected: [4] }, { input: [3, 4], expected: [6, 8] },
    ], acceptanceExamples: [{ input: [-3, 8], expected: [failing ? 999 : -6, 16] }, { input: [7], expected: [14] },
      { input: [-2, 0, 5], expected: [-4, 0, 10] }] } }] };
}

function httpCoderFixture(t, options = {}) {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'http-coder-')));
  const source = path.join(dir, 'source'); fs.mkdirSync(source);
  const targets = path.join(dir, 'targets'); fs.mkdirSync(targets);
  const git = (...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'feature/coder'); git('config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(source, 'seed.txt'), 'source'); git('add', 'seed.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'fixture');
  const kernel = new KernelV2({ noLoad: true, useSQLite: false, loadPlugins: false, memoryPath: path.join(dir, 'graph.json') });
  const connection = openJournalConnection({ dbPath: path.join(dir, 'journal.db') });
  const journal = createExperienceJournal({ store: connection });
  const agents = [];
  t.after(() => {
    for (const agent of agents) { try { agent.storage?.close(); } catch (_) {} }
    connection.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const runtime = createHumanOversightApprovalRuntime({ graph: kernel.graph, ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ context, action }) => ({ decision: 'allow', identity: {
      identityRef: context.identityRef, identityHash: `${context.identityRef}-hash`, workspaceId: action.workspaceId,
      agentId: '', ownerActorId: context.identityRef, authorityRef: 'fixture-owner' } }) });
  const environment = { HUQAN_CODER_ROOTS: source, HUQAN_CODER_TARGET_ROOT: targets, ...options.environment };
  const responses = [];
  const handle = createAgentCoderRoutes({
    parseJsonRequest: async req => req.body,
    writeJson: (req, res, status, body) => responses.push({ status, body }),
    getOversightConfig: () => (options.unconfigured ? null : { runtime: options.runtimeOverride ? options.runtimeOverride(runtime) : runtime,
      humanOversightRequesterContext: { identityRef: 'agent:coder' },
      humanOversightApproverContext: { identityRef: options.approver || 'human:operator' } }),
    resolveAuthorityMode: () => ({ mode: options.authority || 'legacy' }),
    emergencyStop: options.emergencyStop,
    operatorToken: SECRET,
    operatorCapabilityNonces: new Set(),
    readEnvironment: name => environment[name],
    getExperienceJournal: () => journal,
    createAgent: agentOptions => {
      const agent = (options.createAgent || createAgent)({ kernel, dbPath: path.join(dir, `agent-${agents.length}.db`),
        dreamExperimentLoop: false, ...agentOptions });
      agents.push(agent);
      return agent;
    },
  });
  async function call(pathname, body, capability) {
    const req = { method: 'POST', headers: capability ? { [HEADER]: capability } : {}, body };
    assert.equal(await handle(req, {}, { pathname }), true);
    return responses.at(-1);
  }
  const task = (name = 'project', { target = path.join(targets, name), failing = false } = {}) => {
    fs.mkdirSync(target, { recursive: true });
    return { id: name, operation: { type: 'initialize_project', targetRoot: target, spec: projectSpec(failing) } };
  };
  const open = (overrides = {}) => call('/api/v2/agent/coder/cases',
    { workspaceId: 'default', root: source, goal: GOAL, task: task(), ...overrides });
  const decide = (caseId, decision = 'approved', reason = 'approve exact project') => call(
    `/api/v2/agent/coder/cases/${encodeURIComponent(caseId)}/decision`, { workspaceId: 'default', decision, reason },
    createMcpOperatorCapability({ secret: SECRET, ...operatorCapabilityBinding('huqan.approve',
      { approvalId: caseId, workspaceId: 'default', decision, reason }) }));
  const run = (runs, overrides = {}) => call('/api/v2/agent/coder/runs',
    { workspaceId: 'default', goal: GOAL, runs, ...overrides });
  async function approvedCase(taskValue = task()) {
    const opened = await open({ task: taskValue });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    const { caseId } = opened.body.data;
    assert.equal((await decide(caseId)).status, 200);
    return { caseId, root: source, task: taskValue };
  }
  return { dir, source, targets, kernel, journal, runtime, git, open, decide, call, run, task, approvedCase };
}

module.exports = { GOAL, httpCoderFixture, projectSpec };
