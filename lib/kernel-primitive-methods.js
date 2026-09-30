'use strict';

// Kernel primitive facades moved out of kernel.js (#2122): NLP, result
// envelope, predicate parsing and graph traversal. The implementations live
// in lib/kernel-envelope.js, lib/predicate-parser.js and lib/graph-traversal.js;
// these stay Kernel methods because lib/verify.js, lib/learn-use-case.js,
// lib/kernel-read-use-cases.js, plugins and the test suite call them off a
// kernel instance. Installed on Kernel.prototype by kernel.js with the
// descriptors they had as class members; `this` is the Kernel instance.

const {
  normalizeExplicitRelationObject,
  parseExplicitRelationPredicate,
  parsePredicate,
} = require('./predicate-parser');
const {
  forwardChain,
  backwardChain,
  detectCycleBounded,
  resolveCycleOrder,
  findPath,
  findPathWithTimeout,
} = require('./graph-traversal');
const {
  ok: envelopeOk,
  fail: envelopeFail,
  validateResult,
  edgeRef,
  rankEvidence,
  edgeEvidence,
  pathEvidence,
} = require('./kernel-envelope');
const { installKernelMethods } = require('./kernel-method-install');

class KernelPrimitiveMethods {
  normalizeWord(word) {
    return this.nlp.normalize(word);
  }

  tokenizeText(text) {
    return this.nlp.tokenize(text);
  }

  isStopWord(word) {
    return this.nlp.isStopWord(word);
  }

  extractFacts(text, knownNodes = null) {
    return this.nlp.extractFacts(text, knownNodes);
  }

  // Implementations live in lib/kernel-envelope.js. These stay as methods
  // because lib/verify.js, lib/learn-use-case.js, lib/kernel-read-use-cases.js,
  // plugins and the test suite all call them off a kernel instance.
  get _envelopeContext() {
    return { graph: this.graph, contractVersion: this.contractVersion, paranoidMode: this.paranoidMode };
  }

  ok(type, data = null, evidence = [], meta = {}) {
    return envelopeOk(this._envelopeContext, type, data, evidence, meta);
  }

  fail(type, code, message, meta = {}) {
    return envelopeFail(this._envelopeContext, type, code, message, meta);
  }

  _validateResult(result) {
    return validateResult(result);
  }

  _edgeRef(edge) {
    return edgeRef(edge);
  }

  _rankEvidence(evidence = []) {
    return rankEvidence(evidence);
  }

  _edgeEvidence(edge, kind = 'direct_edge', confidence) {
    return edgeEvidence(edge, kind, confidence);
  }

  _pathEvidence(pathArr, kind = 'path', confidence = 0.5, workspaceId = 'default') {
    return pathEvidence(this.graph, pathArr, kind, confidence, workspaceId);
  }

  // Public/private compatibility facades; implementation lives in lib/predicate-parser.js.
  _normalizeExplicitRelationObject(rawObject, opts = {}) {
    return normalizeExplicitRelationObject(rawObject, opts, (word) => this.normalizeWord(word));
  }

  _parseExplicitRelationPredicate(predicate) {
    return parseExplicitRelationPredicate(predicate, (word) => this.normalizeWord(word));
  }

  parsePredicate(predicate) {
    return parsePredicate(predicate, (word) => this.normalizeWord(word));
  }

  _parsePredicate(predicate) { return this.parsePredicate(predicate); }

  // Implementations live in lib/graph-traversal.js. These stay as methods
  // because lib/kernel-read-use-cases.js takes them as injected callbacks,
  // lib/verify.js calls _findPathWithTimeout off the kernel, and the test
  // suite calls them off a kernel instance.
  _forwardChain(id, chain, visited, depth, workspaceId = 'default', opts = {}) {
    return forwardChain(this.graph, id, chain, visited, depth, workspaceId, opts);
  }

  _backwardChain(id, chain, visited, depth, workspaceId = 'default', opts = {}) {
    return backwardChain(this.graph, id, chain, visited, depth, workspaceId, opts);
  }

  _detectCycle(start, visited, pathArr, workspaceId = 'default', opts = {}) {
    return detectCycleBounded(this.graph, start, { workspaceId, visited, pathArr, ...opts });
  }

  _resolveCycleOrder(cycle, workspaceId = 'default', opts = {}) {
    return resolveCycleOrder(this.graph, cycle, workspaceId, opts);
  }

  _findPath(from, to, visited, pathArr, depth, workspaceId = 'default') {
    return findPath(this.graph, from, to, visited, pathArr, depth, workspaceId);
  }

  _findPathWithTimeout(from, to, timeoutMs = 100, workspaceId = 'default', maxDepth = 5) {
    return findPathWithTimeout(this.graph, from, to, timeoutMs, workspaceId, maxDepth);
  }
}

function install(Kernel) {
  installKernelMethods(Kernel, KernelPrimitiveMethods);
}

module.exports = { install };
