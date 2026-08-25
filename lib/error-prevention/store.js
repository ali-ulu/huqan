'use strict';

class ErrorPreventionStore {
  constructor(memoryStore) {
    if (!memoryStore || typeof memoryStore.store !== 'function' || typeof memoryStore.list !== 'function') {
      throw new TypeError('memoryStore with store/list support is required');
    }
    if (typeof memoryStore.get !== 'function' || typeof memoryStore.supersede !== 'function') {
      throw new TypeError('memoryStore with get/supersede support is required');
    }
    this.memoryStore = memoryStore;
  }

  storeContent(content, opts = {}) {
    return this.memoryStore.store({
      content,
      workspaceId: opts.workspaceId || content.workspaceId || 'default',
      actor: opts.actor || 'error-prevention',
      provenance: opts.provenance,
      trustPolicyVersion: opts.trustPolicyVersion,
      metadata: {
        huqanKind: content.kind,
        domainId: content.failureId || content.ruleId || '',
      },
    });
  }

  get(memoryId, workspaceId = 'default') {
    return this.memoryStore.get(memoryId, { workspaceId });
  }

  listKind(kind, opts = {}) {
    // contentKind is pushed into the store so the filter runs before records
    // are cloned. Listing the whole workspace and filtering the returned array
    // meant preflight deep-copied every record in the workspace on every gated
    // action, whether or not a single prevention rule existed (#1541).
    const result = this.memoryStore.list({
      workspaceId: opts.workspaceId || 'default',
      includeTombstoned: opts.includeTombstoned === true,
      contentKind: kind,
    });
    if (!result.ok) return result;
    return { ok: true, memories: result.memories, total: result.memories.length };
  }

  supersede(memoryId, content, opts = {}) {
    return this.memoryStore.supersede(memoryId, content, {
      workspaceId: opts.workspaceId || content.workspaceId || 'default',
      actor: opts.actor || 'error-prevention',
      provenance: opts.provenance,
      trustPolicyVersion: opts.trustPolicyVersion,
      metadata: {
        huqanKind: content.kind,
        domainId: content.failureId || content.ruleId || '',
      },
    });
  }
}

module.exports = ErrorPreventionStore;
