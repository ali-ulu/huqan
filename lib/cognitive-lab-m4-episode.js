'use strict';

/**
 * #4070 COG-M4 Lab episode: one group x one arm.
 *
 * The episode runs the real reversible-forgetting path, not a simulation of
 * it: the group's memories are seeded into a fresh Kernel memory store with
 * fixed timestamps (so the retention score is decided by the record's own
 * fields, never a clock), MemoryLifecycle.consolidate runs the real selector,
 * and each candidate is archived through the receipt-bound archive primitive.
 *
 * The arm is `candidate` (opts.retention.enabled: true) or `control` (retention
 * absent: the default superseded-only selector, which selects nothing here).
 * Both arms run the same real path; the episode only reads what it did.
 *
 * The archived records are restored at the end, so the run is always
 * reversible and the restore rate the evaluator checks is measured, not
 * assumed.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');
const chain = require('./receipt/receipt-chain');
const { MemoryLifecycle } = require('./memory-lifecycle');
const { createdAtFor, NOW, RECALL_K } = require('./cognitive-lab-m4-corpus');

const WORKSPACE = 'default';

function toStoredMemory(group, item) {
  const createdAt = createdAtFor(item.ageDays);
  return {
    memoryId: item.memoryId, workspaceId: WORKSPACE, status: 'active', createdAt,
    content: { fact: item.token, token: item.token }, trustPolicyVersion: '1.0.0',
    provenance: {
      provenanceId: `${item.memoryId}-prov`, sourceRef: `m4-lab:${group.sourceGroup}`, sourceTitle: 'M4 Lab',
      sourceType: 'lab-fixture', actor: 'm4-lab', timestamp: createdAt, workspaceId: WORKSPACE,
      trustPolicyVersion: '1.0.0', confidence: 1,
    },
    metadata: {
      importance: item.importance, importanceSource: item.importanceSource, uses: item.uses,
      pinned: item.pinned, dependencyProtected: item.dependencyProtected,
    },
  };
}

function measureRecall(store, group) {
  let hits = 0;
  for (const query of group.queries) {
    const result = store.query({ workspaceId: WORKSPACE, text: query.text, limit: query.k });
    const found = result.ok === true && Array.isArray(result.memories)
      && result.memories.some((memory) => memory.memoryId === query.targetMemoryId);
    if (found) hits += 1;
  }
  return { queries: group.queries.length, recallHits: hits };
}

/**
 * @param {{group: object, arm: 'candidate'|'control'}} input
 * @returns {object} the per-group execution record the evaluator consumes
 */
function runM4Episode({ group, arm } = {}) {
  if (!group || !Array.isArray(group.memories) || !Array.isArray(group.queries) || !['candidate', 'control'].includes(arm)) {
    throw new TypeError('M4_EPISODE_INPUT_INVALID');
  }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m4-episode-'));
  try {
    const kernel = new Kernel({ noLoad: true, useSQLite: false, memoryPath: path.join(directory, 'memory.json'), dbPath: null });
    const store = kernel.memory;
    store.importPackage({
      version: '1.0.0', schemaVersion: 'memory-package-v1', workspaceId: WORKSPACE,
      memories: group.memories.map((item) => toStoredMemory(group, item)), events: [], links: [],
    }, { workspaceId: WORKSPACE });

    const lifecycle = new MemoryLifecycle(kernel, { memoryStore: store, chain });
    const options = { workspaceId: WORKSPACE, actor: 'm4-lab', now: NOW, dryRun: false };
    if (arm === 'candidate') options.retention = { enabled: true };
    const consolidation = lifecycle.consolidate(options);

    // Measure the default read set and recall before any restore, so the
    // numbers describe what an ordinary read sees after forgetting.
    const readSetSize = store.list({ workspaceId: WORKSPACE }).total;
    const recall = measureRecall(store, group);

    // Reversibility guard (§3): every archived record must come back, so the
    // run only ever offloaded reversibly. `neededArchived` counts the archived
    // records a held-out query still needs -- the wrong forgetting the restore
    // rate reports. Every archived record is restored here, and any record that
    // will not restore is a non-reversible mutation the evaluator rejects.
    const archived = consolidation.ok === true ? consolidation.archived : [];
    const targets = new Set(group.queries.map((query) => query.targetMemoryId));
    const neededArchived = archived.filter((item) => targets.has(item.memoryId)).length;
    let restoreFailures = 0;
    for (const item of archived) {
      const result = lifecycle.restore(item.memoryId, { workspaceId: WORKSPACE, actor: 'm4-lab', reason: 'reversibility check' });
      if (result.ok !== true) restoreFailures += 1;
    }

    return {
      sourceGroup: group.sourceGroup, arm, readSetSize,
      queries: recall.queries, recallHits: recall.recallHits,
      archived: archived.length, neededArchived, restoreFailures,
      refused: consolidation.ok === true ? consolidation.refused.length : 0,
      retentionEnabled: arm === 'candidate',
      recallK: RECALL_K,
    };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

module.exports = { runM4Episode, WORKSPACE };
