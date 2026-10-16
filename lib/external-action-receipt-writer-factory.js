'use strict';

/**
 * Composition root for the durable external-action receipt writer (#2192, #2118).
 *
 * Building (and owning) the Graph the writer projects receipts into is this
 * module's job, which is why the Graph constructor lives here rather than in
 * lib/external-action-receipt.js. The receipt module still exposes the public
 * `createDurableExternalActionReceiptWriter`: it creates the JSONL trail and
 * hands it to `buildDurableReceiptWriter`. This module deliberately requires
 * nothing from the receipt module, so the dependency points one way and
 * index.js does not gain a new dependency.
 *
 * Behaviour is unchanged: an injected `options.graph` wins and is never closed
 * by the writer; a graph the writer built is closed by `close()`; Graph is
 * still required lazily.
 */

function buildDurableReceiptWriter(options = {}) {
  const jsonlWriter = options.jsonlWriter;
  if (!jsonlWriter || typeof jsonlWriter.append !== 'function') {
    throw new TypeError('buildDurableReceiptWriter requires a jsonlWriter with append(receipt)');
  }
  const Graph = require('../graph');
  const graph = options.graph || new Graph({
    memoryPath: options.memoryPath,
    dbPath: options.dbPath,
    useSQLite: options.useSQLite,
  });
  const ownsGraph = !options.graph;
  return Object.freeze({
    path: jsonlWriter.path,
    append(receipt) {
      // The JSONL append is an independent crash-safe receipt trail. The
      // graph append additionally projects the bounded receipt into HUQAN's
      // append-only audit_log when SQLite is available.
      jsonlWriter.append(receipt);
      graph.appendAuditEvent({
        auditId: receipt.receiptId,
        eventType: String(receipt.receiptKind || 'EXTERNAL_ACTION_RECEIPT').toUpperCase(),
        targetType: 'external_agent_action',
        targetId: receipt.admissionId,
        workspaceId: receipt.workspaceId,
        actor: receipt.actor,
        timestamp: receipt.createdAt,
        sourceRef: receipt.receiptHash,
        provenanceId: receipt.provenanceId,
        trustPolicyVersion: receipt.trustPolicyVersion,
        details: receipt,
      });
      return receipt;
    },
    close() {
      if (ownsGraph && typeof graph.close === 'function') graph.close();
    },
    graph,
  });
}

module.exports = { buildDurableReceiptWriter };
