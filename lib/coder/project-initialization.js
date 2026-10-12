'use strict';

const { createProjectInitializationPermission } = require('./project-initialization-permission');
const { runFixLoop } = require('./fix-loop');
const { randomUUID } = require('node:crypto');
const { loadProjectMethods, rememberProjectMethods, prepareProjectMemoryOutput } = require('./project-method-memory');

function initializeProject(spec, options = {}) {
  const reject = reason => ({ ok: false, outcome: 'needs_human_decision', reason, attempts: [], kept: [], record: null });
  const memory = options.projectMemory === undefined ? null
    : loadProjectMethods({ ...options, file: options.projectMemory });
  if (memory && !memory.ok) return reject(memory.reason);
  if (options.projectMemoryOut !== undefined && (!memory?.found || !options.journal))
    return reject('PROJECT_MEMORY_OUTPUT_REQUIRES_SOURCES');
  const output = options.projectMemoryOut === undefined ? null
    : prepareProjectMemoryOutput({ ...options, file: options.projectMemoryOut });
  if (output && !output.ok) return reject(output.reason);
  const parents = memory?.found ? (memory.sources || [{ file: memory.file, hash: memory.hash,
    sourceRunId: memory.sourceRunId, sourceHash: memory.sourceHash }]) : null;
  const issued = createProjectInitializationPermission(spec, { ...options,
    projectMemoryParents: options.projectMemoryOut !== undefined ? parents : undefined,
    candidatePrograms: memory?.found ? memory.programs : undefined,
    pipelineContexts: memory?.found ? memory.pipelineContexts : undefined,
    methodContexts: memory?.found ? memory.methodContexts : undefined });
  if (!issued.ok) return { ok: false, outcome: 'needs_human_decision', reason: issued.reason,
    attempts: [], kept: [], record: null };
  if (memory && issued.plan.archetype !== 'node_computed_json_api') return reject('PROJECT_MEMORY_ARCHETYPE_UNSUPPORTED');
  const sourceSpec = memory ? JSON.parse(JSON.stringify(spec)) : null;
  const runId = options.runId || (memory ? `project:${randomUUID()}` : null);
  const result = runFixLoop({ task: issued.task, root: options.root, repoState: issued.repoState,
    projectInitializationPermission: issued.permission, journal: options.journal || null,
    workspaceId: options.workspaceId || 'default', runId });
  const completed = { ...result, plan: issued.plan };
  if (!memory || !result.ok) return completed;
  const projectMemory = options.projectMemoryOut !== undefined
    ? rememberProjectMethods({ ...options, file: output.file, parents, result: completed,
      spec: sourceSpec, runId: `${runId}:c1` }) : memory.found ? { ok: true,
      state: issued.plan.computation.routes.some(route => route.source === 'synthesis-after-memory-miss') ? 'synthesized' : 'reused',
      hash: memory.hash, replaySearch: memory.replaySearch,
    ...(memory.sources ? { sources: memory.sources } : { file: memory.file, sourceRunId: memory.sourceRunId }) }
    : rememberProjectMethods({ ...options, file: options.projectMemory, result: completed,
      spec: sourceSpec, runId: `${runId}:c1` });
  return { ...completed, ...(projectMemory.ok ? {} : { ok: false, outcome: 'partial', reason: projectMemory.reason }), projectMemory };
}

module.exports = { initializeProject };
