'use strict';

const { createProjectInitializationPermission } = require('./project-initialization-permission');
const { runFixLoop } = require('./fix-loop');

function initializeProject(spec, options = {}) {
  const issued = createProjectInitializationPermission(spec, options);
  if (!issued.ok) return { ok: false, outcome: 'needs_human_decision', reason: issued.reason,
    attempts: [], kept: [], record: null };
  const result = runFixLoop({ task: issued.task, root: options.root, repoState: issued.repoState,
    projectInitializationPermission: issued.permission, journal: options.journal || null,
    workspaceId: options.workspaceId || 'default', runId: options.runId || null });
  return { ...result, plan: issued.plan };
}

module.exports = { initializeProject };
