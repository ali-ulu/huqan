'use strict';

const { createHash } = require('node:crypto');
const { safeData, plain, onlyKeys } = require('./coder/project-spec-data');
const { produceProject } = require('./coder/project-producer');
const { loadProjectMethods } = require('./coder/project-method-memory');
const { inspectProjectInitializationScope } = require('./coder/project-initialization-permission');
const { initializeProject } = require('./coder/project-initialization');

const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

// A task carries requirements, never executor options or mutation authority.
function scopeProjectTask({ root, task, journal, workspaceId }) {
  if (!safeData(task) || !plain(task) || !onlyKeys(task, ['id', 'operation'])
    || typeof task.id !== 'string' || !task.id.trim() || !plain(task.operation)
    || !onlyKeys(task.operation, ['type', 'targetRoot', 'spec', 'projectMemory'])
    || task.operation.type !== 'initialize_project' || typeof task.operation.targetRoot !== 'string'
    || !task.operation.targetRoot.trim()
    || (task.operation.projectMemory !== undefined && typeof task.operation.projectMemory !== 'string'))
    throw new Error('CODER_TASK_UNSUPPORTED');
  const inspected = inspectProjectInitializationScope({ root: task.operation.targetRoot, sourceRoot: root });
  const loaded = task.operation.projectMemory === undefined ? null : loadProjectMethods({
    file: task.operation.projectMemory, root: inspected.root, sourceRoot: inspected.source.root, journal, workspaceId,
  });
  if (loaded && !loaded.ok) throw new Error(loaded.reason);
  const produced = produceProject(task.operation.spec, loaded?.found ? {
    candidatePrograms: loaded.programs, pipelineContexts: loaded.pipelineContexts, methodContexts: loaded.methodContexts,
  } : {});
  if (!produced.ok) throw new Error(produced.reason);
  if (loaded && produced.plan.archetype !== 'node_computed_json_api') throw new Error('PROJECT_MEMORY_ARCHETYPE_UNSUPPORTED');
  return { source: inspected.source, targetRoot: inspected.root, taskHash: digest(produced.task),
    allowedPaths: produced.task.allowedPaths, testCommand: produced.task.test.command,
    memory: loaded ? { file: loaded.file, found: loaded.found, hash: loaded.hash ?? null } : null };
}

function checkProjectScope({ root, task, scope, journal, workspaceId }) {
  const live = scopeProjectTask({ root, task, journal, workspaceId });
  if (JSON.stringify(live.source) !== JSON.stringify(scope.source)) throw new Error('PROJECT_SOURCE_CHANGED');
  if (JSON.stringify(live.memory) !== JSON.stringify(scope.memory)) throw new Error('PROJECT_MEMORY_SOURCE_CHANGED');
  if (JSON.stringify(live) !== JSON.stringify(scope)) throw new Error('PROJECT_TASK_CHANGED');
  return live;
}

// Caller invokes this only inside its already-approved reserved executor.
function executeProjectTask({ root, task, scope, journal, workspaceId }) {
  checkProjectScope({ root, task, scope, journal, workspaceId });
  return initializeProject(task.operation.spec, { root: scope.targetRoot, sourceRoot: scope.source.root,
    initialize: true, journal, workspaceId, sourceBinding: scope.source, taskBindingHash: scope.taskHash,
    ...(scope.memory ? { projectMemory: scope.memory.file,
      projectMemoryBinding: { found: scope.memory.found, hash: scope.memory.hash } } : {}) });
}

module.exports = { scopeProjectTask, checkProjectScope, executeProjectTask };
