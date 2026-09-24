'use strict';

const { createAskUseCase } = require('./kernel-read-use-cases-ask');
const { createAnalysisReadUseCases } = require('./kernel-read-use-cases-analysis');

function createKernelReadUseCases({
  getGraph,
  emitPlugin,
  normalizeWord,
  ok,
  reason,
  alternatives,
  forwardChain,
  backwardChain,
  detectCycle,
  resolveCycleOrder,
  findPath,
  edgeEvidence,
  pathEvidence,
  edgeRef,
}) {
  if (typeof getGraph !== 'function') {
    throw new TypeError('getGraph is required');
  }

  const ask = createAskUseCase({ getGraph, emitPlugin, normalizeWord, ok, reason, alternatives, edgeEvidence });
  const analysis = createAnalysisReadUseCases({ getGraph, normalizeWord, ok, forwardChain, backwardChain, detectCycle, resolveCycleOrder, findPath, edgeEvidence, pathEvidence, edgeRef });
  return Object.freeze({
    ask,
    getPersistenceDescriptor() {
      const currentGraph = getGraph();
      const memoryPath = currentGraph?.memoryPath || 'memory.json';

      return Object.freeze({
        memoryPath,
        dbPath: String(memoryPath).replace(/\.json$/i, '.db'),
      });
    },
    ...analysis,
  });
}

module.exports = { createKernelReadUseCases };
