'use strict';

/**
 * The shared shape behind every entry-based connector in plugins/repo-memory.js.
 *
 * The markdown, json, yaml, git-log, pdf and http ingesters were six
 * line-for-line copies of the same loop. Only three things ever differed: the
 * provenance labels (`json_entry` against `yaml_entry`), the edge's `source`
 * string, and where the entry's title/actor/timestamp were read from. The
 * copies were drifting apart in exactly the way copies do -- git-log grew a
 * `commitHash` detail and markdown a `sectionTitle` one, and nothing forced the
 * other four to be reviewed alongside them.
 *
 * So the loop lives here once, and each connector supplies its entries already
 * normalized. The admission-record order is part of the contract: consumers
 * read `result.admissions` positionally, so the pushes below must stay in the
 * order file-node, entry-node, edge-from, edge-to, edge.
 *
 * `ingestGithubRepo` deliberately does not use this: its graph is two levels
 * deep (repo -> file -> section) and it pins a per-file commit SHA, so folding
 * it in would mean parameterizing the shape rather than the labels.
 */

/**
 * Reads the `path` and `rootPath` pair every file-backed connector requires.
 *
 * The missing-path error is a plain Error and the missing-root error carries a
 * code, because that is the contract callers were already written against.
 */
function requireRootedPath(input = {}, { label, rootCode }) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error(`${label} path is required`);
  }

  const rootPath = input.rootPath || input.workspaceRoot || input.allowedRoot || '';
  if (!rootPath) {
    const err = new Error(`${label} rootPath is required`);
    err.code = rootCode;
    throw err;
  }

  return { targetPath, rootPath };
}

/**
 * Walks normalized entries, proposing the file node, the entry node and the
 * edge between them, and records an admission for every proposal.
 *
 * Each entry is `{ filePath, sourceRef, key, label, actor, timestamp, details }`
 * where `details` is merged into the entry node's own admission record.
 */
function runEntryIngest({
  kernel,
  entries = [],
  buildEntryNodeId,
  buildGraphAdmissionRecord,
  addCompanyEdge,
  source,
  provenanceSourceType,
  fileSubType,
  entrySubType,
  confidence,
  buildConnectorProvenance,
  fileRefPrefix = 'file:',
  fileActor,
  fileTimestamp,
  sessionId = '',
  workspaceId = 'default',
}) {
  const admissions = [];
  let added = 0;

  for (const entry of entries) {
    const fileRef = `${fileRefPrefix}${entry.filePath}`;
    const { sourceRef } = entry;
    const entryNode = buildEntryNodeId(entry);

    const fileProvenance = buildConnectorProvenance({
      sourceType: provenanceSourceType,
      sourceSubType: fileSubType,
      sourceRef: fileRef,
      sourceTitle: entry.filePath,
      actor: fileActor,
      workspaceId,
      confidence,
      timestamp: fileTimestamp,
    });
    const entryProvenance = buildConnectorProvenance({
      sourceType: provenanceSourceType,
      sourceSubType: entrySubType,
      sourceRef,
      sourceTitle: entry.label,
      actor: entry.actor,
      workspaceId,
      confidence,
      timestamp: entry.timestamp,
    });

    const fileNodeResult = kernel.proposeNode(fileRef, entry.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: entry.filePath,
      },
    }));

    const entryNodeResult = kernel.proposeNode(entryNode, entry.label, entryProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        ...entry.details,
      },
    }));

    const entryProposal = addCompanyEdge(kernel, fileRef, entryNode, 'özellik', {
      source,
      sourceRef,
      sessionId,
      sourceType: provenanceSourceType,
      evidence: [entry.key],
      confidence,
      workspaceId,
      provenance: entryProvenance,
      fromProvenance: fileProvenance,
      toProvenance: entryProvenance,
      fromLabel: entry.filePath,
      toLabel: entry.label,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: entryProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: entryNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${entryNode}`,
      provenance: entryProvenance,
      proposal: entryProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));

    if (entryProposal.edge) added += 1;
  }

  return { added, admissions };
}

module.exports = {
  requireRootedPath,
  runEntryIngest,
};
