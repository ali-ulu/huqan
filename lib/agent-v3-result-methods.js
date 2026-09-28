'use strict';

// Result-envelope method group of AgentV3 (#2120): ok/fail delegation to the
// kernel with a local fallback, plus the storage-failure constructor. Moved
// verbatim out of agent.v3.js; installed on AgentV3.prototype by
// lib/agent-v3-method-install.js so the public surface is unchanged.

class AgentV3ResultMethods {
  ok(type, data = null, evidence = [], meta = {}) {
    if (this.kernel && typeof this.kernel.ok === 'function') {
      return this.kernel.ok(type, data, evidence, meta);
    }
    return {
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta,
    };
  }

  fail(type, code, message, evidence = [], meta = {}, data = null) {
    if (this.kernel && typeof this.kernel.fail === 'function') {
      const result = this.kernel.fail(type, code, message, meta);
      result.data = data;
      if (Array.isArray(evidence) && evidence.length) {
        result.evidence = evidence;
      }
      return result;
    }
    return {
      ok: false,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: { code, message },
      meta,
    };
  }

  _storageFailure(operation, err, state = null) {
    const detail = err && err.message ? err.message : 'unknown error';
    return this.fail('agent', 'AGENT_STORAGE_ERROR',
      `Agent storage operation "${operation}" failed: ${detail}.`,
      state?.evidence || [], { operation }, state);
  }
}

module.exports = { AgentV3ResultMethods };
