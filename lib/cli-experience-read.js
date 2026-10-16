'use strict';

// The CLI `experience-read` command renderer (E6, #2400). Receives the
// command context the same way cli-status-command does and renders the
// shared projection from lib/experience/read-model.js. The journal arrives
// on the context (`cli.experienceJournal`) once the runtime seam wiring
// (#2378) lands a production instance; until then this module is exercised
// directly, which is exactly what the parity tests do.

const { buildExperienceRead } = require('./experience/read-model');

function formatExperienceReadText(projection) {
  if (!projection || projection.ok !== true) {
    return `experience: ${(projection && projection.code) || 'unavailable'}`;
  }
  const lines = [
    `experience ${projection.runId} [${projection.workspaceId}]`,
    `hash: ${projection.hash}`,
    `events: ${projection.events.length} head: ${projection.manifest.head} closed: ${projection.manifest.closed}`,
    `outcome: ${projection.manifest.outcomeStatus} eligibility: ${projection.manifest.learningEligibility}`,
  ];
  for (const event of projection.events) {
    lines.push(`  #${event.sequence} ${event.eventId} ${event.type}`);
  }
  return lines.join('\n');
}

function runExperienceReadCommand(cli) {
  const args = (cli && cli.args) || {};
  const journal = cli && cli.experienceJournal;
  const projection = buildExperienceRead(journal, { runId: args.runId, workspaceId: args.workspaceId });
  return formatExperienceReadText(projection);
}

module.exports = { formatExperienceReadText, runExperienceReadCommand };
