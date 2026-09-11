'use strict';

const { randomUUID } = require('node:crypto');
// Retry of this in-memory attempt reuses its budget row. Do not serialize this
// ID into checkpoints: a resumed run must account for its own iteration delta.
const attemptIds = new WeakMap();

/** Persist the related run records before the caller publishes completion.
 * Legacy injected stores retain their sequential contract. HuqanStorage
 * supplies a synchronous transaction covering the final status, goal memory
 * and checkpoint. An earlier finalizing row preserves already-spent budget.
 */
function finalizeAgentRun({ storage, state, goalMemory, saveCheckpoint }) {
  let operation = 'beginFinalization';
  const transactional = typeof storage.withTransaction === 'function';
  let runState = state;
  const persist = () => {
    operation = 'saveRun';
    storage.saveRun(runState);
    operation = 'saveGoalMemory';
    storage.saveGoalMemory(goalMemory);
    if (state.status === 'completed' || state.status === 'blocked') {
      operation = 'deleteCheckpoint';
      storage.deleteCheckpoint(state.checkpointId, state.goal, state.workspaceId);
    } else {
      operation = 'saveCheckpoint';
      saveCheckpoint(state);
    }
    operation = 'commitFinalization';
  };
  try {
    if (transactional) {
      const id = attemptIds.get(state) || state.memoryId || state.runId || state.id || `run-${randomUUID()}`;
      attemptIds.set(state, id);
      runState = { ...state, memoryId: id };
      operation = 'saveRun';
      // Work has already happened. Its budget must survive a failed final
      // commit, while the run must not advertise completion before that commit.
      storage.saveRun({ ...runState, status: 'finalizing' });
      operation = 'beginFinalization';
      storage.withTransaction(persist);
    } else persist();
    return { ok: true };
  } catch (error) {
    return { ok: false, operation, error };
  }
}

module.exports = { finalizeAgentRun };
