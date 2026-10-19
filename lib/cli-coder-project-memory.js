'use strict';

const { reportCommandStatus } = require('./cli-helpers');

function addProjectMemoryFile(flags, value) {
  const file = value || '';
  flags.projectMemory = flags.projectMemory === undefined ? file : [].concat(flags.projectMemory, file);
}

function formatProjectTrainingQuestions(plan) {
  return (plan?.computation?.routes || []).filter(route => route.trainingQuestion?.witness).map(route => {
    const { input, predictions } = route.trainingQuestion.witness;
    return `\nTraining question (${route.path}): ${JSON.stringify(input)} -> ? (candidate outputs: ${[...new Set(predictions.map(row => Array.isArray(row.value) ? JSON.stringify(row.value) : row.value))].join(', ')}; bounded diagnostic, not an answer)`;
  }).join('');
}

// The memory path initializes directly so preview generation cannot secretly
// enumerate fresh programs before the sealed-memory selection.
function runCliProjectMemory({ spec, root, flags, opts, repoState, openJournal }) {
  if (typeof opts.coderLoop?.initializeProject !== 'function') throw new Error('Coder project initializer is unavailable');
  const store = openJournal(flags.journal);
  try {
    const result = opts.coderLoop.initializeProject(spec, { root, sourceRoot: flags.sourceRoot,
      initialize: true, projectMemory: flags.projectMemory, projectMemoryOut: flags.projectMemoryOut, journal: store.journal,
      workspaceId: opts.workspaceId || 'default', runId: flags.runId || null });
    const status = result.ok ? 'completed' : 'refused';
    reportCommandStatus(opts, status);
    if (opts.json) return { status, data: { outcome: result.outcome, reason: result.reason,
      attempts: result.attempts, kept: result.kept, record: result.record, plan: result.plan,
      projectMemory: result.projectMemory, repoStateKnown: repoState.known } };
    const memory = result.projectMemory;
    return opts.coderLoop.formatLoopText(result, repoState) + formatProjectTrainingQuestions(result.plan)
      + (memory ? `\nProject memory: ${memory.ok ? memory.state : `refused (${memory.reason})`}` : '');
  } finally { store.close(); }
}

function runCliProjectRevisionMemory({ spec, root, flags, opts, repoState, openJournal }) {
  const { loadProjectMethods, produceProjectRevision, runFixLoop, formatLoopText,
    prepareProjectMemoryOutput, rememberProjectMethods } = opts.coderLoop || {};
  if ([loadProjectMethods, produceProjectRevision, runFixLoop, formatLoopText].some(fn => typeof fn !== 'function'))
    throw new Error('Coder project revision memory is unavailable');
  const store = openJournal(flags.journal);
  try {
    const workspaceId = opts.workspaceId || 'default';
    const memory = loadProjectMethods({ file: flags.projectMemory, journal: store.journal, root, sourceRoot: root, workspaceId });
    if (flags.projectMemoryOut !== undefined && [prepareProjectMemoryOutput, rememberProjectMethods].some(fn => typeof fn !== 'function'))
      throw new Error('Coder revision method persistence is unavailable');
    const output = flags.projectMemoryOut === undefined ? null
      : prepareProjectMemoryOutput({ file: flags.projectMemoryOut, root, sourceRoot: root });
    const runId = flags.runId || `revision:${require('node:crypto').randomUUID()}`;
    const refused = reason => ({ ok: false, outcome: 'needs_human_decision', reason, attempts: [], kept: [], record: null });
    const produced = memory.ok && memory.found ? produceProjectRevision(spec, { candidatePrograms: memory.programs,
      methodContexts: memory.methodContexts, pipelineContexts: memory.pipelineContexts }) : null;
    let result;
    if (!memory.ok || !memory.found) result = refused(memory.reason || 'PROJECT_MEMORY_NOT_FOUND');
    else if (output && !output.ok) result = refused(output.reason);
    else if (!produced.ok) result = refused(produced.reason);
    else {
      produced.task.id += `-methods-${memory.hash}`;
      result = runFixLoop({ task: produced.task, root, repoState: { known: repoState.known, branch: repoState.branch,
        dirty: repoState.dirty, hasUntracked: repoState.hasUntracked }, authorized: flags.authorize === true,
      journal: store.journal, workspaceId, runId,
      projectRevision: { spec, memoryHash: memory.hash, candidatePrograms: memory.programs,
        methodContexts: memory.methodContexts, pipelineContexts: memory.pipelineContexts } });
    }
    let projectMemory = memory.ok && memory.found ? { ok: true, state: 'loaded', hash: memory.hash,
      sources: memory.sources, replaySearch: memory.replaySearch } : undefined;
    if (result.ok && output) {
      const parents = memory.sources || [{ file: memory.file, hash: memory.hash,
        sourceRunId: memory.sourceRunId, sourceHash: memory.sourceHash }];
      projectMemory = rememberProjectMethods({ file: output.file, root, sourceRoot: root, workspaceId,
        journal: store.journal, runId: `${runId}:c1`, parents, revision: spec, spec: spec.next,
        result: { ...result, plan: produced.plan } });
      if (!projectMemory.ok) result = { ...result, ok: false, outcome: 'partial', reason: projectMemory.reason };
    }
    const status = result.ok ? 'completed' : 'refused';
    reportCommandStatus(opts, status);
    if (opts.json) return { status, data: { ...result, ...(produced?.ok ? { plan: produced.plan } : {}),
      ...(projectMemory ? { projectMemory } : {}), repoStateKnown: repoState.known } };
    return formatLoopText(result, repoState) + formatProjectTrainingQuestions(produced?.plan)
      + (projectMemory ? `\nProject memory: ${projectMemory.ok ? projectMemory.state : `refused (${projectMemory.reason})`}` : '');
  } finally { store.close(); }
}

module.exports = { runCliProjectMemory, runCliProjectRevisionMemory, formatProjectTrainingQuestions, addProjectMemoryFile };
