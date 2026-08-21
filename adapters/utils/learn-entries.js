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

function learnEntriesSync(result, kernel, options, sourceType, sourceSubType) {
  if (!result || !result.entries) return result;
  
  const learned = [];
  for (const entry of result.entries) {
    if (!entry.content) continue;
    
    const provenance = generateProvenance(entry, options, sourceType, sourceSubType);
    
    try {
      const r = kernel.learn(entry.content, { provenance, sourceType, sourceSubType, sourceRef: provenance.sourceRef });
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
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
      learned.push({ entryKey: entry.entryKey, learned: r.data.learned, ok: true });
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
  generateProvenance
};
