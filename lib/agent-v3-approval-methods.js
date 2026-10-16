'use strict';

// Approval-surface method group of AgentV3 (#2120): the tool-approval seam
// factory plus the read half of the approval surface. Moved verbatim out of
// agent.v3.js; the class is installed on AgentV3.prototype by
// lib/agent-v3-method-install.js so the public surface is unchanged.

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

/**
 * #329: the baseAgent below is built without storage on purpose -- plan() and
 * the step executors share that instance, so a full storage object would
 * switch on agent.js's own saveRun()/saveGoalMemory() paths underneath v3,
 * which owns that persistence itself. But Agent.inspectToolPolicy() queues its
 * approval record through this.storage.saveToolApproval(), so a storage-less
 * baseAgent made the v3 approval gate record nothing at all.
 *
 * This is the narrowest seam that closes it: one capability, forwarded lazily
 * to v3's storage (which is constructed after baseAgent). Every other v1
 * persistence path stays disabled by its own
 * `typeof this.storage.X === 'function'` guard, because those methods are
 * simply absent here.
 */
function createToolApprovalSeam(getStorage) {
  return {
    saveToolApproval(record) {
      const storage = getStorage();
      if (!storage || typeof storage.saveToolApproval !== 'function') return null;
      return storage.saveToolApproval(record);
    },
  };
}

class AgentV3ApprovalMethods {
  inspectToolPolicy(tool, input = '', context = {}) {
    return this.baseAgent.inspectToolPolicy(tool, input, context);
  }

  // The read half of the approval surface. inspectToolPolicy() writes through
  // the baseAgent seam above; these read straight from v3's storage, mirroring
  // the guards agent.js uses so a storage without the approval tables degrades
  // to empty rather than throwing.
  listPendingToolApprovals(limit = 20, workspaceId = 'default') {
    if (!this.storage || typeof this.storage.listPendingToolApprovals !== 'function') return [];
    return this.storage.listPendingToolApprovals(limit, workspaceId);
  }

  countPendingToolApprovals(workspaceId = 'default') {
    if (!this.storage || typeof this.storage.countPendingToolApprovals !== 'function') return 0;
    return this.storage.countPendingToolApprovals(workspaceId);
  }
}

module.exports = { normalizeGoal, createToolApprovalSeam, AgentV3ApprovalMethods };
