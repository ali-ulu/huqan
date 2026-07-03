'use strict';

function emptyMemoryAdmission() {
  return {
    status: null,
    decision: null,
    reason: null,
  };
}

function emptyContextIntegrity() {
  return {
    status: null,
    flags: null,
  };
}

function emptyProvenance() {
  return {
    traceId: null,
    workspaceId: null,
    receiptId: null,
  };
}

function sourceMeta() {
  return { readOnly: true };
}

function baseResult(ok, status, extras = {}) {
  return {
    ok,
    status,
    memoryAdmission: emptyMemoryAdmission(),
    contextIntegrity: emptyContextIntegrity(),
    provenance: emptyProvenance(),
    source: sourceMeta(),
    ...extras,
  };
}

function trimText(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

function cloneArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item)) : null;
}

function readBySource(source, query) {
  if (typeof source === 'function') return source(query);
  if (!source || typeof source !== 'object') return null;
  if (typeof source.readMemoryContext === 'function') return source.readMemoryContext(query);
  if (typeof source.getMemoryContext === 'function') return source.getMemoryContext(query);
  if (typeof source.read === 'function') return source.read(query);
  if (Array.isArray(source.records)) {
    return source.records.find((record) => recordMatches(record, query)) || null;
  }
  return null;
}

function recordMatches(record, query) {
  if (!record || typeof record !== 'object') return false;
  const recordId = trimText(query.recordId);
  const workspaceId = trimText(query.workspaceId);
  const candidates = [
    record.recordId,
    record.id,
    record.receiptId,
    record.traceId,
    record.memoryAdmission?.receiptId,
    record.memoryAdmission?.traceId,
    record.meta?.memoryAdmission?.receiptId,
    record.meta?.memoryAdmission?.traceId,
  ].map(trimText);
  if (!candidates.includes(recordId)) return false;
  if (!workspaceId) return true;
  const recordWorkspace = trimText(
    record.workspaceId
      || record.memoryAdmission?.workspaceId
      || record.meta?.memoryAdmission?.workspaceId,
  );
  return recordWorkspace === workspaceId;
}

function readMemoryAdmission(record) {
  if (!record || typeof record !== 'object') return null;
  if (record.memoryAdmission && typeof record.memoryAdmission === 'object') return record.memoryAdmission;
  if (record.meta?.memoryAdmission && typeof record.meta.memoryAdmission === 'object') return record.meta.memoryAdmission;
  return null;
}

function contextFlags(context) {
  if (!context || typeof context !== 'object') return null;
  if (Array.isArray(context.flags)) return cloneArray(context.flags);

  const flags = [];
  if (context.workspaceScoped === true) flags.push('workspace_scoped');
  if (context.canonicalMutation === true) flags.push('canonical_mutation');
  if (context.mutationAllowed === true) flags.push('mutation_allowed');
  return flags;
}

function normalizeRecord(record, query) {
  const admission = readMemoryAdmission(record);
  if (!admission) {
    return baseResult(false, 'not_found', {
      missingFields: ['memoryAdmission'],
    });
  }

  const context = admission.contextIntegrity && typeof admission.contextIntegrity === 'object'
    ? admission.contextIntegrity
    : null;
  const traceId = trimText(admission.traceId || record.traceId || record.toolVerdict?.traceId);
  const workspaceId = trimText(admission.workspaceId || record.workspaceId || query.workspaceId);
  const receiptId = trimText(admission.receiptId || record.receiptId || record.toolVerdict?.receiptId);
  const missingFields = [];

  if (!trimText(admission.status)) missingFields.push('memoryAdmission.status');
  if (!trimText(admission.verdict || admission.decision)) missingFields.push('memoryAdmission.decision');
  if (!trimText(admission.reason)) missingFields.push('memoryAdmission.reason');
  if (!context) missingFields.push('contextIntegrity');

  return baseResult(true, 'ok', {
    memoryAdmission: {
      status: trimText(admission.status) || null,
      decision: trimText(admission.decision || admission.verdict) || null,
      reason: trimText(admission.reason) || null,
    },
    contextIntegrity: {
      status: trimText(context?.status) || (context ? 'present' : null),
      flags: contextFlags(context),
    },
    provenance: {
      traceId: traceId || null,
      workspaceId: workspaceId || null,
      receiptId: receiptId || null,
    },
    missingFields,
  });
}

function inspectMemoryContext(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return baseResult(false, 'invalid_request', {
      missingFields: ['input'],
    });
  }

  const recordId = trimText(input.recordId || input.id || input.receiptId || input.traceId);
  if (!recordId) {
    return baseResult(false, 'invalid_request', {
      missingFields: ['recordId'],
    });
  }

  const source = input.source;
  if (!source) {
    return baseResult(false, 'invalid_request', {
      missingFields: ['source'],
    });
  }

  const query = {
    recordId,
    workspaceId: trimText(input.workspaceId) || null,
  };

  let record;
  try {
    record = readBySource(source, query);
  } catch (_error) {
    return baseResult(false, 'read_error');
  }

  if (!record || typeof record !== 'object') {
    return baseResult(false, 'not_found');
  }

  return normalizeRecord(record, query);
}

module.exports = {
  inspectMemoryContext,
};
