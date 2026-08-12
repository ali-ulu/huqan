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
    const result = this.memoryStore.list({
      workspaceId: opts.workspaceId || 'default',
      includeTombstoned: opts.includeTombstoned === true,
    });
    if (!result.ok) return result;
    const memories = result.memories.filter((memory) => memory?.content?.kind === kind);
    return { ok: true, memories, total: memories.length };
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
