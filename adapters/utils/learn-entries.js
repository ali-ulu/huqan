'use strict';

const crypto = require('node:crypto');
const CONTENT_HASH_ALGORITHM = 'sha256';

function generateProvenance(entry, options = {}, sourceType, sourceSubType) {
  const provenance = {
    provenanceId: `${sourceSubType}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    source: `${sourceSubType}-adapter`,
    sourceRef: entry.sourceRef || options.sourceRef || entry.url || entry.path || 'unknown',
    sourceType,
    sourceSubType,
    contentHash: crypto.createHash(CONTENT_HASH_ALGORITHM).update(entry.content).digest('hex'),
    contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
    actor: options.actor || `${sourceSubType}-adapter`,
    timestamp: (entry.commit && entry.commit.date) || new Date().toISOString(),
  };
  
  if (entry.sourceVersion) {
    provenance.sourceVersion = entry.sourceVersion;
    provenance.sourceVersionKind = entry.sourceVersionKind;
  } else if (entry.etag) {
    provenance.sourceVersion = entry.etag;
    provenance.sourceVersionKind = 'etag';
  } else if (entry.lastModified) {
    provenance.sourceVersion = entry.lastModified;
    provenance.sourceVersionKind = 'last_modified';
  }
  
  return provenance;
}

/**
 * Project one `kernel.learn()` result into the per-entry ingest record.
 *
 * `kernel.learn()` answers `ok: true` with `learned: 0` whenever the memory
 * admission gate holds the write for review or rejects it -- it returns an
 * envelope, it does not throw (#1990, #3846). The adapter previously stamped
 * `ok: true` on every non-throwing call, so a document whose every section was
 * queued for review reported the same success as one that was written. This
 * derives `ok` from what actually happened: a fact reached the graph.
 *
 * A held-for-review entry is not an error (nothing threw), so `ok: false` is
 * paired with `status: 'review_required'` rather than `error`, matching the
 * vocabulary the HTTP upload and MCP learn surfaces already report (#1990,
 * #3846).
 */
function projectLearnOutcome(r) {
  const data = r && typeof r === 'object' ? r.data : null;
  const admission = data && typeof data === 'object' ? data.admission : null;
  const learned = Number(data?.learned || 0);
  const outcome = admission && typeof admission.outcome === 'string' ? admission.outcome : null;
  const reason = admission && typeof admission.reason === 'string' ? admission.reason : null;

  if (learned > 0) return { learned, ok: true, status: 'learned' };
  if (outcome === 'review' || outcome === 'quarantine') {
    return { learned, ok: false, status: 'review_required', reason };
  }
  if (outcome === 'reject' || outcome === 'block') {
    return { learned, ok: false, status: 'blocked', reason };
  }
  // No admission verdict and nothing learned: the text parsed to no fact.
  return { learned, ok: false, status: 'skipped', reason };
}

function learnEntriesSync(result, kernel, options, sourceType, sourceSubType) {
  if (!result || !result.entries) return result;
  
  const learned = [];
  for (const entry of result.entries) {
    if (!entry.content) continue;
    
    const provenance = generateProvenance(entry, options, sourceType, sourceSubType);
    
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType, sourceSubType, sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, ...projectLearnOutcome(r) });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

async function learnEntriesAsync(result, kernel, options, sourceType, sourceSubType) {
  if (!result || !result.entries) return result;
  
  const learned = [];
  for (const entry of result.entries) {
    if (!entry.content) continue;
    
    const provenance = generateProvenance(entry, options, sourceType, sourceSubType);
    
    try {
      let r;
      if (typeof kernel.learnAsync === 'function') {
        r = await kernel.learnAsync(entry.content, { provenance, sourceType, sourceSubType, sourceRef: provenance.sourceRef });
      } else {
        r = kernel.learn(entry.content, { provenance, sourceType, sourceSubType, sourceRef: provenance.sourceRef });
      }
      learned.push({ entryKey: entry.entryKey, ...projectLearnOutcome(r) });
    } catch (e) {
      learned.push({ entryKey: entry.entryKey, error: e.message, ok: false });
    }
  }
  return { ...result, learned };
}

module.exports = {
  learnEntriesSync,
  learnEntriesAsync,
  learnEntries: learnEntriesAsync, // Aliased for tests that still use the old name
  generateProvenance,
  projectLearnOutcome
};
