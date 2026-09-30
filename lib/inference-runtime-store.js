'use strict';

const { randomUUID } = require('node:crypto');
const { digest } = require('./inference-runtime-snapshot');
const { downgradeWithdrawnEdges } = require('./inference-runtime-projection');
function prefix(workspaceId) { return `inference-runtime:${digest(workspaceId)}:`; }
function readRuns(graph, workspaceId) {
  const rows = graph.getCommittedMutationResultsByPrefix(prefix(workspaceId));
  if (!Array.isArray(rows)) throw new TypeError('inference journal read failed');
  return rows.map(row => row.result)
    .filter(row => row?.inferenceRuntime === true && row.workspaceId === workspaceId)
    .sort((a, b) => a.revision - b.revision);
}
function latestRecords(runs) { return runs.at(-1)?.records || []; }
function commitRun(graph, workspaceId, previousRevision, value) {
  const result = { ...value, inferenceRuntime: true, workspaceId, revision: previousRevision + 1 };
  return graph.runMutationOnce(`${prefix(workspaceId)}${randomUUID()}`, () => {
    if ((readRuns(graph, workspaceId).at(-1)?.revision || 0) !== previousRevision) {
      throw new Error('inference state changed; retry with current graph');
    }
    result.projectionChanges = downgradeWithdrawnEdges(graph, result.records || [], result.at);
    return result;
  }).result;
}
module.exports = { readRuns, latestRecords, commitRun };
