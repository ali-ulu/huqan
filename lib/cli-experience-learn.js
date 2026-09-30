'use strict';

// The CLI `experience-learn` command renderer (production caller for
// lib/experience/learning-intake.js). Renders a learning proposal for one run.
// The journal arrives on the context (`cli.experienceJournal`) once the runtime
// seam wiring (#2378) lands a production instance.

const { buildLearningProposal } = require('./experience/learning-intake');

function formatLearningProposalText(proposal) {
  if (!proposal || proposal.ok !== true) {
    return `experience-learn: ${(proposal && proposal.code) || 'unavailable'}`;
  }
  const lines = [
    `experience-learn ${proposal.runId} [${proposal.workspaceId}]`,
    `hash: ${proposal.hash}`,
    `source: ${proposal.sourceHash}`,
    `eligibility: ${proposal.eligibility} outcome: ${proposal.outcomeStatus}`,
    `admission: ${proposal.admission.decision} (${proposal.admission.code})`,
  ];
  if (proposal.candidate) {
    lines.push(`candidate: ${proposal.candidate.status} sources: ${proposal.candidate.trace.sources.length}`);
  }
  if (proposal.procedure) {
    lines.push(`procedure: ${proposal.procedure.kind} v${proposal.procedure.version} ${proposal.procedure.hash}`);
  } else {
    lines.push(`procedure: none (${proposal.compileCode})`);
  }
  lines.push(`registered: ${proposal.registered}`);
  return lines.join('\n');
}

function runExperienceLearnCommand(cli) {
  const args = (cli && cli.args) || {};
  const journal = cli && cli.experienceJournal;
  const proposal = buildLearningProposal(journal, {
    runId: args.runId,
    workspaceId: args.workspaceId,
    kind: args.kind,
    params: args.params,
    parentVersion: args.parentVersion,
  });
  return formatLearningProposalText(proposal);
}

module.exports = { formatLearningProposalText, runExperienceLearnCommand };
