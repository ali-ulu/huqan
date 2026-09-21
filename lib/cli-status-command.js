'use strict';

// The CLI `durum` (status) command. Moved out of cli.js (#2136) unchanged,
// together with the two requires only it used. It receives the command
// context CLI#execute builds and reads its kernel and agent.
const { buildSystemStatus, formatSystemStatusText } = require('./system-status-report');
const { formatPluginCapabilityStatus } = require('./cli-plugin-status');
const { isWorkflowRuntime } = require('./cli-helpers');
const { runDoctorCommand } = require('./cli-doctor');

function runStatusCommand(cli) {
  // The same report huqan.status returns, rendered. Sharing the builder
  // is what keeps the two surfaces from answering differently.
  const report = buildSystemStatus(cli.kernel, {
    agentRuntime: isWorkflowRuntime(cli.agent) ? 'workflow' : null,
  });
  return formatSystemStatusText(report, formatPluginCapabilityStatus(cli.kernel?.plugins));
}

module.exports = { runStatusCommand, runDoctorCommand };
