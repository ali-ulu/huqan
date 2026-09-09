'use strict';

// Tracks agent memory-persistence health across a run (#1985).
//
// agent.js used to swallow every memory-write failure inside catch(_){} and
// still report ok:true, so a run could lose its goals/runs/file snapshot
// while looking successful. These helpers record each failure on the agent
// instance; run() copies the verdict into the result envelope as
// meta.memoryPersisted / meta.memoryErrors (mirroring agent.v3's
// _storageFailure pattern, without changing v1's ok:true contract).

function resetMemoryPersistence(agent) {
  if (!agent) return;
  agent._memoryPersisted = true;
  agent._memoryErrors = [];
}

function noteMemoryFailure(agent, operation, error) {
  if (!agent) return;
  agent._memoryPersisted = false;
  if (!Array.isArray(agent._memoryErrors)) agent._memoryErrors = [];
  agent._memoryErrors.push({
    operation: String(operation || 'unknown'),
    message: (error && error.message) || String(error),
    code: (error && error.code) || null,
  });
}

function memoryPersistenceMeta(agent) {
  return {
    memoryPersisted: !agent || agent._memoryPersisted !== false,
    memoryErrors: Array.isArray(agent && agent._memoryErrors) ? agent._memoryErrors : [],
  };
}

module.exports = { memoryPersistenceMeta, noteMemoryFailure, resetMemoryPersistence };
