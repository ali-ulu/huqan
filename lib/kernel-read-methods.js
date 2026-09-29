'use strict';

// Kernel read-side facades moved out of kernel.js (#2122): the read use cases
// (ask/reason/compare/entropy/detectGaps), verify and its VerifyService
// facades, and introspect. None of them writes to the graph. Installed on
// Kernel.prototype by kernel.js with the descriptors they had as class
// methods; `this` is the Kernel instance. verify() still takes the Kernel
// critical section, which stays on Kernel with learn().

const { normalizeWorkspaceId } = require('./cli-mutation-audit-intent');
const { buildIntrospectReport } = require('./kernel-introspect-report');
const { installKernelMethods } = require('./kernel-method-install');

// An opts object or a bare workspace id; kernel.js selfEvolve() uses it too.
function workspaceIdFrom(options) { return normalizeWorkspaceId(options && typeof options === 'object' && !Array.isArray(options) ? options.workspaceId : options); }

class KernelReadMethods {
  _contradictionEvidence(contradiction) {
    return this._verifyService.contradictionEvidence(contradiction);
  }

  ask(question, opts = {}) { return this._readUseCases.ask(question, workspaceIdFrom(opts)); }

  entropy(workspaceId = 'default') { return this._readUseCases.entropy(workspaceId); }

  detectGaps(workspaceId = 'default') { return this._readUseCases.detectGaps(workspaceId); }

  reason(subject, opts = 'default') { return this._readUseCases.reason(subject, workspaceIdFrom(opts)); }

  compare(a, b, opts = 'default') { return this._readUseCases.compare(a, b, workspaceIdFrom(opts)); }

  _parseNumericComparison(text) {
    return this._verifyService.parseNumericComparison(text);
  }

  /**
   * Bir ifadeyi bilgi grafiğiyle doğrula.
   * "kedi balık yer" → özne=kedi, nesne=balık yer → kenar var mı?
   * Takes the critical section itself -- verifyAsync() adds no locking on
   * top of this (#368), so calling verify() directly is not "the unlocked
   * path"; it is the same path.
   */
  verify(statement, opts = {}) {
    this._enterCriticalSection('verify');
    try {
      return this._verifyInternal(statement, opts);
    } finally {
      this._exitCriticalSection();
    }
  }

  // Promise-returning form of verify(), for callers in an async context.
  // It is NOT a stronger concurrency guarantee: the lock lives in verify()
  // itself and this adds nothing to it (#368). Unlike learnAsync() there is
  // no async pre-pass here -- verify() does not mutate the graph, so it has
  // no preIngest equivalent.
  async verifyAsync(statement, opts = {}) {
    return this.verify(statement, opts);
  }

  // r1: Internal verify implementation (the critical section is entered by
  // verify(), not here -- call verify() unless you deliberately want the
  // unlocked path)
  _verifyInternal(statement, opts = {}) {
    return this._verifyService.verify(statement, opts);
  }

  detectContradictions(subject = '', workspaceId = 'default') {
    return this._verifyService.detectContradictions(subject, workspaceId);
  }

  _extractNumbers(text) {
    return this._verifyService.extractNumbers(text);
  }

  _getTextCore(text) {
    return this._verifyService.getTextCore(text);
  }

  introspect(workspaceId = 'default') {
    this.plugins.emit('beforeIntrospect', {});
    // Report body lives in lib/kernel-introspect-report.js; the plugin
    // lifecycle events and the envelope wrap stay here.
    const result = buildIntrospectReport({
      graph: this.graph,
      workspaceId,
      contradictions: this.detectContradictions('', workspaceId),
      gaps: this.detectGaps(workspaceId),
      entropy: this.entropy(workspaceId),
      dreamCount: this._dreamCount || 0,
    });
    this.plugins.emit('afterIntrospect', result);
    return this.ok('introspect', result);
  }
}

function install(Kernel) {
  installKernelMethods(Kernel, KernelReadMethods);
}

module.exports = { install, workspaceIdFrom };
