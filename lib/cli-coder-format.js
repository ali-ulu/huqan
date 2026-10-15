'use strict';

/**
 * Text rendering for the `coder` CLI command.
 *
 * Split out of lib/cli-coder.js (#3901): that file sits at the 400-line
 * ratchet in scripts/file-size-baseline.json, so the refusal-aware rendering
 * had to move rather than grow it. The renderer stays a pure function of the
 * derivation result and the repo state read by the caller.
 */

const { DERIVATION_OUTCOMES } = require('./coder/derivation-record');

function formatCoderText(result, repoState) {
  const record = result.record;
  const refused = result.outcome === DERIVATION_OUTCOMES.REFUSED;
  const lines = [];
  // A refused run wrote nothing, so it must not read as a completed one. The
  // outcome leads, the derivation/record ids (which only exist once the patch
  // actually landed) are withheld, and "Files that would change" is dropped
  // (#3901). A dry_run is not a refusal: it never claimed to write, so it keeps
  // its own "would change" preview.
  if (refused) {
    lines.push(`Outcome:    ${DERIVATION_OUTCOMES.REFUSED}${result.reason ? ` — ${result.reason}` : ''}`);
    if (result.detail) lines.push(`Detail:     ${result.detail}`);
  }
  lines.push(`Task:       ${record.taskId || '(unnamed)'}`);
  lines.push(`Transform:  ${record.operationType || '(none)'} (catalog ${record.catalogVersion})`);
  lines.push(`Runner:     ${record.runnerStatus}${record.runnerReason ? ` — ${record.runnerReason}` : ''}`);
  lines.push(`Gate:       ${record.gate.decision || '(not reached)'}${record.gate.reason ? ` — ${record.gate.reason}` : ''}`);
  if (!refused) lines.push(`Outcome:    ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
  if (!refused && result.detail) lines.push(`Detail:     ${result.detail}`);
  if (!repoState.known) lines.push('Repo state: unknown (git unavailable) — gate saw a clean, non-main tree');
  if (Array.isArray(repoState.untrackedPaths) && repoState.untrackedPaths.length) {
    lines.push('Untracked:  the gate counts these files as dirt (gitignore them, commit them, or move the task file out of the tree)');
    for (const untracked of repoState.untrackedPaths) lines.push(`  ${untracked}`);
  }
  if (!refused) {
    const observed = record.observedVerification;
    if (observed && observed.ran) {
      lines.push(`Verified:   ${observed.ok ? 'ok' : 'not ok'}${observed.evidenceRef ? ` — ${observed.evidenceRef}` : ''}`);
    }
    lines.push(`Derivation: ${record.derivationHash}`);
    lines.push(`Record:     ${record.recordHash}`);
  }
  if (result.experience) {
    lines.push(`Run:        ${result.experience.runId}`);
    const eventCount = Array.isArray(result.experience.events) ? result.experience.events.length : 0;
    lines.push(`Experience: ${eventCount} events${result.experience.failed ? ` — evidence gap: ${result.experience.failed}` : ''}`);
  }
  if (refused) return lines.join('\n');

  if (record.patch.length) {
    lines.push('');
    lines.push(result.outcome === DERIVATION_OUTCOMES.APPLIED ? 'Files written:' : 'Files that would change:');
    for (const change of record.patch) lines.push(`  ${change.path}`);
  }
  return lines.join('\n');
}

module.exports = { formatCoderText };
