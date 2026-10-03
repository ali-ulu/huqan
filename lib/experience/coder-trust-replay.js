'use strict';

const { readSealedRun } = require('./learning-intake');

function replayCoderTrust({ journal, workspaceId, requestId, capabilityId, procedureHash, trust, seededRunIds }) {
  if (typeof journal.runIds !== 'function') return { ok: false, code: 'experience_history_unavailable' };
  const seeds = new Set(seededRunIds);
  const records = [];
  let fallbackCount = 0;
  for (const runId of journal.runIds(workspaceId)) {
    if (runId === requestId) continue;
    const events = journal.read(runId, { workspaceId });
    const routing = events.find(event => event.type === 'routing_decided');
    if (routing?.payload?.fallback?.capabilityIds?.includes(capabilityId)) {
      const sealed = readSealedRun(journal, runId, workspaceId);
      if (!sealed.ok) return sealed;
      // A dry run records the fallback it would have taken but changes nothing,
      // so only runs that executed count as a preferred-over event.
      if (events.some(event => event.type === 'execution_finished')) fallbackCount += 1;
    }
    if (!seeds.has(runId) && routing?.payload?.chosenCapabilityId !== capabilityId) continue;
    if (routing && routing.payload.boundProcedureVersion !== procedureHash) return { ok: false, code: 'capability_binding_changed' };
    const sealed = readSealedRun(journal, runId, workspaceId);
    if (!sealed.ok) return sealed;
    const occurredAt = Date.parse(events.find(event => event.type === 'run_started')?.payload?.createdAt);
    if (!Number.isFinite(occurredAt)) return { ok: false, code: 'experience_timestamp_missing' };
    records.push({ workspaceId, capabilityId, eventId: events.at(-1).eventId,
      runId, procedureVersion: procedureHash, learningEligibility: sealed.manifest.learningEligibility, occurredAt });
  }
  records.sort((a, b) => a.occurredAt - b.occurredAt || a.runId.localeCompare(b.runId));
  for (const record of records) {
    const result = trust.recordRun(record);
    if (!result.ok) return result;
  }
  for (let index = 0; index < fallbackCount; index += 1) {
    const result = trust.incrementFallbackPreferredOverCount({ workspaceId, capabilityId });
    if (!result.ok) return result;
  }
  return { ok: true };
}

module.exports = { replayCoderTrust };
