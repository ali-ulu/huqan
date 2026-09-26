// KernelV2 methods that forward to the wrapped v1 kernel unchanged, moved out
// of kernel.v2.js (#2138). They add no v2 semantics; they exist so a v2
// caller never gets a TypeError where a v1 caller gets an answer.

const METHODS = {
  getPersistenceDescriptor() {
    return this.kernel.getPersistenceDescriptor();
  },
  recordCliMutationAudit(intent) {
    return this.kernel.recordCliMutationAudit(intent);
  },
  parsePredicate(predicate) { return this.kernel.parsePredicate(predicate); },
  commitBackgroundEdge(from, to, relation, source, opts = {}) { return this.kernel.commitBackgroundEdge(from, to, relation, source, opts); },
  reload() {
    return this.kernel.reload();
  },
  persist() {
    return this.kernel.persist();
  },
  // #1848: Windows cannot rename over an open SQLite file (EPERM) and restore
  // replaces memory.db, so the CLI closes every handle to it before the replace
  // and reopens them afterwards. These forward to the wrapped Kernel which owns
  // the graph's (and memory store's) SQLite handles.
  closeSqlite() {
    return this.kernel.closeSqlite();
  },
  reopenSqlite() {
    return this.kernel.reopenSqlite();
  },

  optimize() {
    return this.kernel.optimize();
  },

  hasCapability(name) {
    if (!this.kernel || typeof this.kernel.hasCapability !== 'function') return false;
    return this.kernel.hasCapability(name);
  },

  enableCapability(name) {
    if (!this.kernel || typeof this.kernel.enableCapability !== 'function') {
      throw new Error('Capability system is unavailable.');
    }
    return this.kernel.enableCapability(name);
  },

  requireCapability(name) {
    if (!this.kernel || typeof this.kernel.requireCapability !== 'function') {
      throw new Error('Capability system is unavailable.');
    }
    return this.kernel.requireCapability(name);
  },

  listCapabilities() {
    if (!this.kernel || typeof this.kernel.listCapabilities !== 'function') return [];
    return this.kernel.listCapabilities();
  },

  getCapability(name) {
    if (!this.kernel || typeof this.kernel.getCapability !== 'function') return null;
    return this.kernel.getCapability(name);
  },

  runCapability(name, input, opts = {}) {
    if (!this.kernel || typeof this.kernel.runCapability !== 'function') {
      throw new Error('Plugin capability runner is unavailable.');
    }
    return this.kernel.runCapability(name, input, opts);
  },

  usePlugin(plugin) {
    if (!this.kernel || typeof this.kernel.usePlugin !== 'function') {
      throw new Error('Plugin manager is unavailable.');
    }
    return this.kernel.usePlugin(plugin);
  },

  getStats() { return this.kernel.graph.getStats(); },

  entropy(workspaceId = 'default') { return this.kernel.entropy(workspaceId); },
  detectGaps(workspaceId = 'default') { return this.kernel.detectGaps(workspaceId); },
  detectContradictions(subject = '', workspaceId = 'default') { return this.kernel.detectContradictions(subject, workspaceId); },
  startAutoThink(intervalMs) { return this.kernel.startAutoThink(intervalMs); },

  stopAutoThink() {
    return this.kernel.stopAutoThink();
  },

  // #329: KernelV2 wraps Kernel instead of extending it, so any Kernel public
  // method this class does not name is simply absent under
  // HUQAN_KERNEL_VERSION=v2 -- the caller gets a TypeError, not a v1 fallback.
  // cli.js's `konsolide` and `evolve` commands did exactly that. Everything
  // below is the one-way adapter: v2 layers no extra semantics on these, so
  // they forward unchanged to the wrapped kernel, which owns the same graph
  // this instance exposes.
  normalizeWord(word) {
    return this.kernel.normalizeWord(word);
  },

  tokenizeText(text) {
    return this.kernel.tokenizeText(text);
  },

  isStopWord(word) {
    return this.kernel.isStopWord(word);
  },

  extractFacts(text, knownNodes = null) {
    return this.kernel.extractFacts(text, knownNodes);
  },

  proposeNode(id, label, provenance, opts = {}) {
    return this.kernel.proposeNode(id, label, provenance, opts);
  },

  proposeEdge(from, to, relation, opts = {}) {
    return this.kernel.proposeEdge(from, to, relation, opts);
  },

  alternatives(subject, maxPaths = 3, workspaceId = 'default') {
    return this.kernel.alternatives(subject, maxPaths, workspaceId);
  },

  contextSimilarity(a, b, context) {
    return this.kernel.contextSimilarity(a, b, context);
  },

  introspect(workspaceId = 'default') {
    return this.kernel.introspect(workspaceId);
  },

  consolidate(dryRun = true) {
    return this.kernel.consolidate(dryRun);
  },

  selfEvolve(opts = {}) {
    return this.kernel.selfEvolve(opts);
  },

  selfLearn(opts = {}) {
    return this.kernel.selfLearn(opts);
  },

  // reasonSandbox builds its own throwaway v1 Kernel internally and never
  // touches this instance's graph, so v2 semantics have nothing to add and
  // the sandbox answers are v1 answers by construction -- same as they are
  // for a v1 caller.
  reasonSandbox(opts = {}) {
    return this.kernel.reasonSandbox(opts);
  },
};

// Class methods are non-enumerable; installing these the same way keeps
// `for...in`, spreads and Object.keys over a KernelV2 unchanged.
function install(KernelV2) {
  for (const [name, fn] of Object.entries(METHODS)) {
    Object.defineProperty(KernelV2.prototype, name, { value: fn, writable: true, configurable: true, enumerable: false });
  }
}

module.exports = { install };
