'use strict';

// The CLI `experience-reconcile` operator command (#3033). A step that was in
// flight when a run stopped is refused on resume as EXPERIENCE_EFFECT_UNCERTAIN
// and its operation stays pending; nothing in the runtime can tell whether the
// effect reached the outside world. This command is where a person who checked
// says so:
//
//   experience-reconcile [--workspace <id>]
//       list the operations whose outcome is unknown
//   experience-reconcile <operationId> --performed|--not-performed --reason <text>
//       record the verdict; `--performed` lets the resume skip the step,
//       `--not-performed` lets it run the step once more
//
// The ledger is the agent's own (`createAgent` builds it beside the Experience
// journal), so a verdict lands in the same store the resume reads.

const ACTOR = 'operator:cli';

function ledgerOf(cli) {
  const agent = cli && cli.agent;
  const base = agent && (agent.baseAgent || agent);
  const ledger = base && base.experienceOperationLedger;
  return ledger && typeof ledger.resolve === 'function' ? ledger : null;
}

function formatPending(pending, workspaceId) {
  const scope = workspaceId ? ` in workspace ${workspaceId}` : '';
  if (pending.length === 0) return `experience-reconcile: no uncertain operations${scope}`;
  const lines = [`experience-reconcile: ${pending.length} uncertain operation(s)${scope}`];
  for (const item of pending) lines.push(`  ${item.operationId} run ${item.runId} [${item.workspaceId}]`);
  return lines.join('\n');
}

function resolutionError(args) {
  if (args.performed === args.notPerformed) return 'choose exactly one of --performed or --not-performed';
  if (!args.reason) return '--reason <text> is required: say how the effect was checked';
  return null;
}

function runExperienceReconcileCommand(cli) {
  const args = (cli && cli.args) || {};
  const ledger = ledgerOf(cli);
  if (!ledger) return 'experience-reconcile: unavailable (Experience is off or has no durable store)';
  if (!args.operationId) return formatPending(ledger.reconcile({ workspaceId: args.workspaceId }), args.workspaceId);
  const invalid = resolutionError(args);
  if (invalid) return `experience-reconcile: ${invalid}`;
  const result = ledger.resolve({
    operationId: args.operationId,
    performed: args.performed,
    actor: ACTOR,
    reason: args.reason,
  });
  if (!result.ok) return `experience-reconcile: ${result.code} for ${args.operationId}`;
  const verdict = args.performed ? 'performed (the resume will skip the step)' : 'not performed (the resume will run the step once more)';
  return `experience-reconcile: ${args.operationId} recorded as ${verdict}`;
}

module.exports = { runExperienceReconcileCommand, formatPending };
