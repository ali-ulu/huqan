const { Graph } = require('./graph');

// Scoring helpers, per-chain scoring and the prose report live in
// lib/causal-simulator-*.js (#2187).
const { clamp01, findScopedNode, simulationOverlay, uniqueStrings } = require('./lib/causal-simulator-scoring');
const { dedupeAffectedNodes, missingNodeResult, scoreChains } = require('./lib/causal-simulator-chains');
const { describeChain, deriveRecommendation, generateSummary } = require('./lib/causal-simulator-report');

class CausalSimulator {
  constructor(graph) {
    if (!graph || !(graph instanceof Graph)) {
      throw new Error('CausalSimulator requires a Graph instance');
    }
    this.graph = graph;
  }

  /**
   * Simulate a change and return causal consequences
   * @param {object} opts
   * @param {string} opts.action - Action description
   * @param {string} opts.nodeId - Node to simulate change on
   * @param {string} opts.changeType - Type of change (add, remove, modify)
   * @param {object} opts.newState - New state if modify
   * @param {number} opts.maxDepth - Maximum causal chain depth (default: 10)
   * @param {string} opts.workspaceId - Workspace scope (default: default)
   * @returns {object} Simulation result
   */
  simulateChange(opts = {}) {
    const { action, nodeId, changeType, newState, maxDepth = 10, workspaceId = 'default' } = opts;

    if (!nodeId) {
      throw new Error('simulateChange requires nodeId');
    }

    const scopedNodes = this.graph.getNodes(workspaceId);
    const node = findScopedNode(scopedNodes, nodeId);
    if (!node) {
      return missingNodeResult({ action, nodeId, changeType, newState, maxDepth, workspaceId });
    }

    const simulation = simulationOverlay(changeType, newState);
    const traversal = this.graph.getCausalChain(nodeId, { maxDepth, workspaceId });
    const causalChains = Array.isArray(traversal)
      ? traversal
      : (traversal && Array.isArray(traversal.chain) ? traversal.chain : []);

    const { outcomes, risks, affectedNodes, evidence, unknowns, totalConfidence, confidenceCount } =
      scoreChains(causalChains, scopedNodes, simulation);
    const dedupAffectedNodes = dedupeAffectedNodes(affectedNodes);

    const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : 0;
    const traversalMetadata = traversal && typeof traversal === 'object' ? traversal : null;
    const traversalLoops = Array.isArray(traversalMetadata?.loops) ? traversalMetadata.loops : [];
    const traversalStoppedReason = traversalMetadata?.stoppedReason || (causalChains.length === 0 ? 'insufficient-data' : 'exhausted');
    const traversalMaxDepth = Number.isFinite(traversalMetadata?.maxDepth) ? traversalMetadata.maxDepth : maxDepth;
    const traversalConfidence = Number.isFinite(traversalMetadata?.confidence) ? traversalMetadata.confidence : avgConfidence;
    const mode = causalChains.length === 0 ? 'insufficient-data' : 'causal-backed';

    if (causalChains.length === 0) {
      unknowns.push(`No causal chain found for ${nodeId}`);
    }

    if (traversalStoppedReason === 'maxDepth') {
      unknowns.push(`Traversal stopped at maxDepth ${traversalMaxDepth}`);
    }

    if (traversalLoops.length > 0) {
      for (const loop of traversalLoops) {
        unknowns.push(`Loop detected: ${loop.join(' -> ')}`);
      }
    }

    const uniqueEvidence = uniqueStrings(evidence);
    const simulatedConfidence = clamp01(traversalConfidence * simulation.stateImpact);
    const recommendation = this._deriveRecommendation(risks, simulatedConfidence, mode, simulation);

    return {
      ok: true,
      mode,
      action: action || `Simulate change on ${nodeId}`,
      nodeId,
      changeType: changeType || 'unknown',
      simulation,
      workspaceId,
      input: {
        action: action || `Simulate change on ${nodeId}`,
        nodeId,
        changeType: changeType || 'unknown',
        newState: typeof newState === 'undefined' ? null : newState,
        maxDepth: traversalMaxDepth,
        workspaceId,
      },
      affectedNodes: dedupAffectedNodes,
      causalChains: causalChains.length,
      causalChainDetails: causalChains,
      outcomes,
      risks,
      evidence: uniqueEvidence,
      unknowns: uniqueStrings(unknowns),
      confidence: simulatedConfidence,
      traversal: traversalMetadata,
      recommendation,
      summary: this._generateSummary({
        mode,
        outcomes,
        risks,
        confidence: simulatedConfidence,
        unknowns,
        traversalStoppedReason,
        simulation,
      })
    };
  }

  _describeChain(chain) {
    return describeChain(chain);
  }

  _generateSummary(input) {
    return generateSummary(input);
  }

  _deriveRecommendation(risks, confidence, mode, simulation = null) {
    return deriveRecommendation(risks, confidence, mode, simulation);
  }

  /**
   * Get all causal relations in the graph
   */
  getCausalRelations() {
    return this.graph.getCausalRelations();
  }

  /**
   * Check if a relation is causal
   */
  isCausalRelation(relation) {
    return this.graph.isCausalRelation(relation);
  }
}

module.exports = { CausalSimulator };
