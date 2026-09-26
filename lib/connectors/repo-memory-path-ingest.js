const { buildConnectorProvenance } = require('../repo-file-pin');
const { requireRootedPath, runEntryIngest } = require('./entry-ingest-flow');
const { executeGuardedConnectorIngest } = require('./repo-memory-firewall');
const {
  nowIso,
  trackIngestSuccess,
  addCompanyEdge,
  buildGraphAdmissionRecord,
  summarizeGraphAdmissions,
  buildSectionNodeId,
} = require('./repo-memory-records');

/**
 * The six entry-based connectors of plugins/repo-memory.js are the same walk
 * over a list of entries; only their labels and where a title/actor/timestamp
 * is read from differ. lib/connectors/entry-ingest-flow.js holds the walk, and
 * each connector supplies its entries already normalized to
 * `{ filePath, sourceRef, key, label, actor, timestamp, details }`.
 */
function runPathIngest(kernel, input, connector) {
  const workspaceId = input.workspaceId || 'default';
  return runEntryIngest({
    kernel,
    entries: connector.entries,
    buildEntryNodeId: (entry) => buildSectionNodeId(entry.filePath, entry.key),
    buildGraphAdmissionRecord,
    addCompanyEdge,
    buildConnectorProvenance,
    source: connector.source,
    provenanceSourceType: connector.provenanceSourceType,
    fileSubType: connector.fileSubType,
    entrySubType: connector.entrySubType,
    confidence: connector.confidence,
    fileRefPrefix: connector.fileRefPrefix,
    fileActor: input.actor || 'repo-memory',
    fileTimestamp: input.timestamp || nowIso(),
    sessionId: input.sessionId || '',
    workspaceId,
  });
}

/**
 * The default entry shape: title, actor and timestamp all come from the entry
 * key and the caller's input. git-log is the one connector that overrides it.
 */
function plainEntry(entry, input) {
  return {
    filePath: entry.filePath,
    sourceRef: entry.sourceRef,
    key: entry.entryKey,
    label: entry.entryKey,
    actor: input.actor || 'repo-memory',
    timestamp: input.timestamp || nowIso(),
    details: { entryKey: entry.entryKey },
  };
}

/**
 * One guarded ingest. `spec.ingest` is the adapter call the plugin owns; it
 * runs only inside the firewall's executor. A spec with a `rootCode` ingests a
 * rooted path; one without supplies its own `target` (http).
 */
async function ingestGuardedSource(kernel, input, spec) {
  const request = { connector: spec.connector, input };
  if (spec.rootCode) {
    const { targetPath, rootPath } = requireRootedPath(input, {
      label: spec.connector,
      rootCode: spec.rootCode,
    });
    request.target = targetPath;
    request.rootPath = rootPath;
  } else {
    request.target = spec.target(input);
  }

  const guarded = await executeGuardedConnectorIngest({
    ...request,
    execute: async decision => {
      const ingested = await spec.ingest(decision, input);
      const { added, admissions } = runPathIngest(kernel, input, {
        ...spec.flow,
        source: spec.connector,
        entries: spec.entries(ingested, input),
      });
      return { ingested, added, admissions };
    },
  });
  if (!guarded.ok) return guarded;

  const { ingested, added, admissions } = guarded.value;
  trackIngestSuccess(kernel, spec.connector, added);
  return {
    ok: true,
    sourceType: spec.connector,
    ...spec.counts(ingested),
    added,
    ...(spec.extra ? spec.extra(ingested) : {}),
    admission: summarizeGraphAdmissions(admissions),
    admissions,
    ...(guarded.connectorFirewall ? { connectorFirewall: guarded.connectorFirewall } : {}),
  };
}

module.exports = { ingestGuardedSource, plainEntry };
