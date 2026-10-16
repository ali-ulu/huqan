const { parseNumericComparison, extractNumbers, getTextCore } = require('./verify-numeric-text');
const { decomposeClaim } = require("./claim-decomposition");
const { buildContradictionEvidence } = require("./verify-contradiction-evidence");
const { extractSubjectAndPredicate } = require("./verify-subject");
const { verifyCompound } = require("./verify-compound");
const { verifyAgainstEdges } = require("./verify-edge-phases");
const { verifyAgainstGraph } = require("./verify-graph-phases");
const { installVerifyResultMethods } = require("./verify-result");
const { installVerifyContradictionScan } = require("./verify-contradiction-scan");
class VerifyService {
  /**
   * `host` is the set of kernel operations this service needs and does not
   * own. It used to reach for them as `kernel._parsePredicate` and the
   * like -- a contract with no name, so neither side could change without
   * surprising the other. Defaults to empty so a stub kernel that never
   * reaches these paths still constructs, exactly as before.
   */
  constructor(kernel, host) {
    this.kernel = kernel;
    this.host = host || {};
  }
  verify(statement, opts = {}) {
    const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : 'default';
    if (typeof statement !== 'string' || !statement.trim()) {
      return this.verifyResult(String(statement ?? ''), opts, { status: 'unknown', confidence: 0 }, [], { workspaceId });
    }
    const numericComparison = this.parseNumericComparison(statement);
    if (numericComparison) {
      return this.verifyResult(statement, opts, {
        status: numericComparison.ok ? 'verified' : 'contradicted',
        confidence: 0.98,
      }, [{
        kind: numericComparison.ok ? 'direct_edge' : 'contradiction',
        text: `Numeric comparison: "${numericComparison.left} ${numericComparison.operator} ${numericComparison.right}"`,
        confidence: 0.98,
        nodes: [String(numericComparison.left), String(numericComparison.right)],
        edges: [],
      }], { workspaceId });
    }

    const decomposition = decomposeClaim(statement, opts);
    if (decomposition.compound && !opts.skipDecomposition) {
      return verifyCompound(this, statement, opts, workspaceId, decomposition);
    }

    const parts = statement.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return this.verifyResult(statement, opts, { status: 'unknown', confidence: 0 }, [], { workspaceId, decomposition });
    }

    const subjectMatch = this._extractSubjectAndPredicate(statement, workspaceId, parts);
    let subject = subjectMatch.subject, lookupSubject = subjectMatch.subject, subjectTokenCount = 1;
    let subjectNode = this.kernel.graph.getNode(lookupSubject, workspaceId);

    if (!subjectNode) {
      const subjectResolution = this._resolveCanonicalSubjectLookup(statement, subjectMatch, parts, workspaceId, opts.domain);
      subject = subjectResolution.subjectLiteral || subject;
      lookupSubject = subjectResolution.lookupSubject || lookupSubject;
      subjectTokenCount = String(subjectResolution.subjectLiteral || '').trim().split(/\s+/).filter(Boolean).length || 1;
      subjectNode = this.kernel.graph.getNode(lookupSubject, workspaceId);
    }

    const predicate = subjectTokenCount > 1 ? (parts.slice(subjectTokenCount).join(' ') || subjectMatch.predicate || parts.slice(1).join(' ')) : (subjectMatch.predicate || parts.slice(1).join(' '));
    const edges = subjectNode ? this.kernel.graph.getEdges(lookupSubject, workspaceId) : [];
    const verifyContext = {
      workspaceId,
      subject,
      lookupSubject,
      predicate,
      edges,
      decomposition,
    };
    if (!subjectNode) {
      return this.verifyResult(statement, opts, { status: 'unknown', confidence: 0 }, [], verifyContext);
    }

    const ctx = { statement, opts, workspaceId, parts, subject, predicate, edges, verifyContext };
    return verifyAgainstEdges(this, ctx) || verifyAgainstGraph(this, ctx);
  }

  parseNumericComparison(text) {
    return parseNumericComparison(text);
  }

  _extractSubjectAndPredicate(statement, workspaceId, parts = null) {
    return extractSubjectAndPredicate(this.kernel, statement, workspaceId, parts);
  }
  contradictionEvidence(contradiction) {
    return buildContradictionEvidence(this.host, contradiction);
  }

  extractNumbers(text) {
    return extractNumbers(text);
  }

  getTextCore(text) {
    return getTextCore(text);
  }

}

installVerifyResultMethods(VerifyService.prototype);
installVerifyContradictionScan(VerifyService.prototype);

module.exports = VerifyService;

