'use strict';
// #4065 G1 child process: one history build or one episode through the
// production Coder HTTP route handler (cases -> operator decision -> runs).
// The arm preload (lib/cognitive-lab-g1-arm-preload.js) is loaded with
// --require by the parent; this file never changes the scheduler itself.
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const KernelV2 = require('../kernel.v2');
const { createAgent } = require('../agentRuntime');
const { createTrustEvidenceLedger } = require('./trust-evidence-ledger');
const { createHumanOversightApprovalRuntime } = require('./human-oversight-approval-runtime');
const { createExperienceJournal } = require('./experience/journal');
const { openJournalConnection } = require('./experience/journal-connection');
const { createMcpOperatorCapability } = require('./mcp-operator-capability');
const { operatorCapabilityBinding } = require('./mcp/operator-authorization');
const { createAgentCoderRoutes } = require('./http/agent-coder-routes');

const HEADER = 'x-huqan-operator-capability';
const WORKSPACE = 'default';
const GOAL = 'build the approved computed APIs';
const RUN_TIME_BUDGET_MS = 10 * 60 * 1000;

function openRoutes({ source, stateDir, targets, observe, counters }) {
  const kernel = new KernelV2({ useSQLite: false, loadPlugins: false, memoryPath: path.join(stateDir, 'graph.json') });
  const connection = openJournalConnection({ dbPath: path.join(stateDir, 'journal.db') });
  const journal = createExperienceJournal({ store: connection });
  const runtime = createHumanOversightApprovalRuntime({ graph: kernel.graph, ledger: createTrustEvidenceLedger({ graph: kernel.graph }),
    resolveIdentity: ({ context, action }) => ({ decision: 'allow', identity: {
      identityRef: context.identityRef, identityHash: `${context.identityRef}-hash`, workspaceId: action.workspaceId,
      agentId: '', ownerActorId: context.identityRef, authorityRef: 'g1-runner-owner' } }) });
  // The proposer and the approver are different identities; the decision also
  // needs a scope-bound operator capability that the proposer never holds.
  const secret = randomBytes(32).toString('hex');
  const environment = { HUQAN_CODER_ROOTS: source, HUQAN_CODER_TARGET_ROOT: targets };
  const responses = [];
  const agents = [];
  const handle = createAgentCoderRoutes({
    parseJsonRequest: async req => req.body,
    writeJson: (req, res, status, body) => responses.push({ status, body }),
    getOversightConfig: () => ({ runtime, humanOversightRequesterContext: { identityRef: 'agent:coder' },
      humanOversightApproverContext: { identityRef: 'human:g1-operator' } }),
    resolveAuthorityMode: () => ({ mode: 'legacy' }),
    operatorToken: secret,
    operatorCapabilityNonces: new Set(),
    readEnvironment: name => environment[name],
    getExperienceJournal: () => journal,
    createAgent: options => {
      // §5: the budget unit is steps. The host's run time budget must never be the
      // binding limit, or machine speed decides how many approved tasks execute.
      const agent = createAgent({ kernel, dbPath: path.join(stateDir, `agent-${agents.length}.db`), dreamExperimentLoop: false,
        timeBudgetMs: RUN_TIME_BUDGET_MS, ...options });
      const coder = agent.baseAgent.coderExecution;
      // Calibration-only mutation (§8): cut the observation link, keep everything else.
      if (!observe) agent.baseAgent.coderExecution = { ...coder, observeAcceptance: () => null };
      agents.push(agent);
      return agent;
    },
  });
  async function call(pathname, body, capability) {
    counters.httpCalls += 1;
    const req = { method: 'POST', headers: capability ? { [HEADER]: capability } : {}, body };
    if (await handle(req, {}, { pathname }) !== true) throw new Error(`G1_ROUTE_UNHANDLED:${pathname}`);
    return responses.at(-1);
  }
  const close = () => {
    for (const agent of agents) { try { agent.storage?.close(); } catch (_) {} }
    connection.close();
  };
  return { call, secret, close };
}

function coderTask(task, targets) {
  const targetRoot = path.join(targets, task.id);
  fs.mkdirSync(targetRoot, { recursive: true });
  return { id: task.id, operation: { type: 'initialize_project', targetRoot, spec: { kind: 'project_spec',
    name: `${task.id}-api`, archetype: 'node_computed_json_api', routes: [{ path: '/compute',
      compute: { family: task.family, examples: task.examples, acceptanceExamples: task.acceptanceExamples } }] } } };
}

async function approve(routes, source, task, targets) {
  const coder = coderTask(task, targets);
  const opened = await routes.call('/api/v2/agent/coder/cases', { workspaceId: WORKSPACE, root: source, goal: GOAL, task: coder });
  if (opened.status !== 201) throw new Error(`G1_CASE_REFUSED:${task.id}:${JSON.stringify(opened.body)}`);
  const { caseId } = opened.body.data;
  const decision = { workspaceId: WORKSPACE, decision: 'approved', reason: 'G1 runner approves the exact synthetic task' };
  const capability = createMcpOperatorCapability({ secret: routes.secret,
    ...operatorCapabilityBinding('huqan.approve', { approvalId: caseId, ...decision }) });
  const decided = await routes.call(`/api/v2/agent/coder/cases/${encodeURIComponent(caseId)}/decision`, decision, capability);
  if (decided.status !== 200) throw new Error(`G1_DECISION_REFUSED:${task.id}:${JSON.stringify(decided.body)}`);
  return { caseId, root: source, task: coder };
}

// Independent oracle: the generated module, not Coder's own report, against the
// target function's real outputs on rows the synthesizer never saw.
function independentlyAccepted(task, targets) {
  const logic = path.join(targets, task.id, 'src', 'logic.js');
  try {
    delete require.cache[logic];
    const { compute } = require(logic);
    return task.acceptanceExamples.every(row => JSON.stringify(compute(0, row.input)) === JSON.stringify(row.expected));
  } catch { return false; }
}

async function runEpisode({ routes, source, tasks, targets, budget, counters }) {
  const approved = [];
  for (const task of tasks) approved.push(await approve(routes, source, task, targets));
  const byStep = new Map(approved.map((entry, at) => [`coder:${entry.task.id}`, tasks[at]]));
  const outcome = Object.fromEntries(tasks.map(task => [task.id, { executed: false, accepted: false, attempts: 0 }]));
  const steps = [];
  let remaining = approved;
  let spent = 0;
  while (remaining.length && spent < budget.maxEpisodeSteps) {
    // maxSteps bounds the plan, so the whole remaining queue is planned and the
    // scheduler chooses among all of it; maxIterations bounds execution (v3 §12).
    const response = await routes.call('/api/v2/agent/coder/runs', { workspaceId: WORKSPACE, goal: GOAL, runs: remaining,
      cognition: true, maxSteps: Math.min(budget.maxSteps, remaining.length),
      maxIterations: Math.min(budget.maxIterations, budget.maxEpisodeSteps - spent, remaining.length) });
    if (response.status !== 200) throw new Error(`G1_RUN_REFUSED:${JSON.stringify(response.body)}`);
    const returned = response.body.data.steps;
    counters.coderSteps += returned.length;
    spent += Math.max(returned.length, 1);
    steps.push({ batch: steps.length, steps: returned, trail: response.body.data.cognition?.trail || [] });
    const retry = [];
    for (const step of returned) {
      const task = byStep.get(step.id);
      if (!task) throw new Error(`G1_STEP_UNMAPPED:${step.id}`);
      outcome[task.id].attempts += 1;
      // Project initialization tests its single candidate: ALL_CANDIDATES_EXHAUSTED
      // is a finished, failed task. A blocked step cannot run again (the
      // approval reserves one execution). Any other error is resubmitted.
      if (step.status === 'done' || step.error === 'ALL_CANDIDATES_EXHAUSTED') outcome[task.id].executed = true;
      else if (step.status === 'error') retry.push(task.id);
      outcome[task.id].lastError = step.error;
    }
    // Budget-limited tasks stay failures; only interrupted ones are resubmitted.
    remaining = approved.filter(entry => retry.includes(entry.task.id));
  }
  for (const task of tasks) if (outcome[task.id].executed) outcome[task.id].accepted = independentlyAccepted(task, targets);
  return { order: tasks.map(task => task.id), outcome, steps,
    successes: tasks.filter(task => outcome[task.id].accepted).length, denominator: tasks.length };
}

async function main() {
  const payload = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const started = performance.now();
  const counters = { httpCalls: 0, coderSteps: 0 };
  fs.mkdirSync(payload.targets, { recursive: true });
  const routes = openRoutes({ source: payload.source, stateDir: payload.stateDir, targets: payload.targets,
    observe: payload.observe !== false, counters });
  try {
    let result;
    if (payload.mode === 'history') {
      // One approved task per run: history is real Coder outcomes, one at a time.
      result = { runs: [] };
      for (const task of payload.tasks) {
        result.runs.push({ id: task.id, workKind: task.workKind, ...(await runEpisode({ routes, source: payload.source,
          tasks: [task], targets: payload.targets, budget: { maxSteps: 1, maxIterations: 1, maxEpisodeSteps: 3 }, counters })) });
      }
    } else {
      result = await runEpisode({ routes, source: payload.source, tasks: payload.tasks, targets: payload.targets,
        budget: payload.budget, counters });
    }
    process.stdout.write(JSON.stringify({ ok: true, ...result, counters, wallMs: performance.now() - started,
      maxRssBytes: process.resourceUsage().maxRSS * 1024 }));
  } finally {
    routes.close();
  }
}

main().catch(error => { process.stderr.write(`${error.stack || error}\n`); process.exit(1); });
