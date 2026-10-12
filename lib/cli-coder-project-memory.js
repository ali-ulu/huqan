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

module.exports = { runCliProjectMemory, formatProjectTrainingQuestions, addProjectMemoryFile };
