'use strict';

const CALLER_CONTROLLED_PROVENANCE_KEYS = Object.freeze([
  'provenanceId',
  'sourceRef',
  'sourceTitle',
  'sourceType',
  'sourceSubType',
  'actor',
  'timestamp',
  'confidence',
  'workspaceId',
]);

function bindHttpProvenance(provenance, {
  actor = 'http-api',
  workspaceId,
  sourceType,
  sourceRef,
  sourceTitle,
} = {}) {
  const claims = provenance && typeof provenance === 'object' && !Array.isArray(provenance)
    ? { ...provenance }
    : {};
  for (const key of CALLER_CONTROLLED_PROVENANCE_KEYS) delete claims[key];
  return {
    ...claims,
    sourceType,
    sourceRef,
    sourceTitle,
    actor,
    workspaceId,
  };
}

module.exports = { bindHttpProvenance };
