const { buildCausalPreventionConflict } = require("./verify-native");
const {
  phraseMatches, hasSharedSemanticAnchor, isPreventRelation, normalizeForVerify,
} = require("./verify-turkish-text");
const { parseNumericComparison } = require('./verify-numeric-text');
const { detectAbsoluteClaim } = require("./risk-rules");

// VerifyService#verify (lib/verify.js), against the subject's own edges:
// a numeric predicate, a negated known edge, and a direct supporting edge
// (with its prevention and sibling-opposition conflicts). Returns a result, or
// null to fall through; fills `ctx` with the derived target and claim shape.
function verifyAgainstEdges(service, ctx) {
  const { statement, opts, parts, subject, predicate, edges, verifyContext } = ctx;
  const predicateNumericComparison = service.parseNumericComparison(predicate);
  if (predicateNumericComparison) {
    return service.verifyResult(statement, opts, {
      status: predicateNumericComparison.ok ? 'verified' : 'contradicted',
      confidence: 0.95,
    }, [{
      kind: predicateNumericComparison.ok ? 'direct_edge' : 'contradiction',
      text: `Numeric comparison: "${predicateNumericComparison.left} ${predicateNumericComparison.operator} ${predicateNumericComparison.right}"`,
      confidence: 0.95,
      nodes: [subject, String(predicateNumericComparison.left), String(predicateNumericComparison.right)],
      edges: [],
    }], verifyContext);
  }

  const negMatch = predicate.match(/^(.*?)\s+(de[gğĞ]il(?:dir)?|not)\s*$/i);
  if (negMatch) {
    const positive = negMatch[1].trim();
    if (positive) {
      // Same matcher as the affirmative branch below.
      //
      // `e.to.includes(posNorm)` is a bare substring test with no word
      // boundary, so any object that happened to be a substring of a known
      // edge target -- a single letter included -- was reported contradicted
      // at 0.9 confidence, citing an unrelated edge as its evidence. "kedi a
      // değildir" was "refuted" because `hayvan` contains an `a`, and that
      // evidence goes into the Trust Receipt and the audit trail (#1032).
      //
      // phraseMatches already exists for exactly this and was already used
      // one branch down: it requires equality, multi-word containment, or a
      // substring of at least four characters.
      const posNorm = normalizeForVerify(service.kernel, positive);
      const posEdge = edges.find(e => phraseMatches(posNorm, normalizeForVerify(service.kernel, e.to)));
      if (posEdge) {
        return service.verifyResult(statement, opts, { status: 'contradicted', confidence: 0.85 }, [{
          kind: 'contradiction',
          text: `${subject} --[${posEdge.relation}]--> ${posEdge.to} is known, but the statement negates it: "${predicate}"`,
          confidence: 0.85,
          nodes: [subject, posEdge.to],
          edges: [{ from: subject, to: posEdge.to, relation: posEdge.relation }],
        }], verifyContext);
      }
    }
  }

  const rawTarget = parts[parts.length - 1];
  const target = normalizeForVerify(service.kernel, rawTarget);
  const incomingAbsolute = Boolean(detectAbsoluteClaim(statement, {}));
  const normalizedPredicate = normalizeForVerify(service.kernel, predicate);
  const incoming = {
    text: statement,
    subject,
    relation: predicate,
    object: target,
    to: target,
  };
  Object.assign(ctx, { target, incomingAbsolute, normalizedPredicate, incoming });
  const directEdge = edges.find(e => phraseMatches(normalizedPredicate, normalizeForVerify(service.kernel, e.to)));
  if (directEdge) {
    // Does the incoming claim itself assert prevention?
    //
    // The branch below reads a stored PREVENTS edge as refuting the claim,
    // which is right for an *affirmative* claim: with `smoking PREVENTS
    // health` in the graph, "Smoking is healthy" is a contradiction. It fired
    // on every claim, including one that asserted the same prevention, so
    // "Exercise prevents heart disease" was answered `contradicted` at 0.95
    // citing the very edge that states it -- a self-refuting verdict on one
    // of the four causal relations the product advertises, and on the
    // README's own worked example.
    //
    // _parsePredicate is the same parser the ingest path uses to build these
    // edges, so the claim is read with the vocabulary it was written with.
    // isPreventRelation covers the wider English/Turkish surface form when no
    // parse is available.
    const incomingParsed = typeof service.kernel._parsePredicate === 'function'
      ? service.host.parsePredicate(predicate)
      : null;
    const incomingPrevents = incomingParsed && incomingParsed.relation ? isPreventRelation(incomingParsed.relation) : isPreventRelation(String(predicate).trim().split(/\s+/)[0] || '');
    const causalConflict = buildCausalPreventionConflict(subject, directEdge, statement, incomingPrevents); if (causalConflict) return service.verifyResult(statement, opts, causalConflict.data, causalConflict.evidence, { ...verifyContext, directEdge });

    // PREVENTS edge contradicts affirmative claim
    // e.g. "sigara PREVENTS sağlık" means "Sigara sağlıklıdır" is a contradiction
    if (directEdge.relation === 'PREVENTS' && !incomingPrevents) {
      const pConfidence = Math.min(0.95, (directEdge.strength ?? directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.3);
      return service.verifyResult(statement, opts, { status: 'contradicted', confidence: pConfidence }, [{
        kind: 'contradiction',
        text: `${subject} --[PREVENTS]--> ${directEdge.to} contradicts: "${statement}"`,
        confidence: pConfidence,
        nodes: [subject, directEdge.to],
        edges: [{ from: subject, to: directEdge.to, relation: 'PREVENTS' }],
      }], { ...verifyContext, directEdge });
    }
    if (incomingAbsolute) {
      // Absolute claims should not be promoted by a single supporting edge.
    } else {
      const confidence = Math.min(0.95, (directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.4);
      const directObject = normalizeForVerify(service.kernel, directEdge.to);
      const preventConflictEdge = edges.find(edge =>
        edge !== directEdge &&
        isPreventRelation(edge.relation) &&
        hasSharedSemanticAnchor(directObject, normalizeForVerify(service.kernel, edge.to))
      );
      if (preventConflictEdge) {
        const contradictionSignal = {
          rule: 'CAUSE_PREVENT_OPPOSITION',
          kind: 'contradiction',
          severity: 0.9,
          confidence: 0.95,
          flags: ['CAUSE_PREVENT_OPPOSITION', 'SEMANTIC_OPPOSITION'],
          detail: 'Direct support conflicts with sibling prevent/opposition evidence.',
          evidence: [
            { text: `${subject} ${directEdge.relation} ${directEdge.to}`, role: 'support' },
            { text: `${subject} ${preventConflictEdge.relation} ${preventConflictEdge.to}`, role: 'opposition' },
          ],
          meta: {
            storedRelation: preventConflictEdge.relation,
            incomingRelation: directEdge.relation || predicate,
            oppositionFamily: 'cause_prevent',
          },
        };
        return service.verifyResult(statement, opts, { status: 'contradicted', confidence: 0.85 }, [{
          kind: 'contradiction',
          text: `${subject} --[${preventConflictEdge.relation}]--> ${preventConflictEdge.to} contradicts: "${statement}"`,
          confidence: 0.85,
          nodes: [subject, directEdge.to, preventConflictEdge.to].filter(Boolean),
          edges: [
            { from: subject, to: directEdge.to, relation: directEdge.relation },
            { from: subject, to: preventConflictEdge.to, relation: preventConflictEdge.relation },
          ],
        }], { ...verifyContext, directEdge, contradictionSignals: [contradictionSignal] });
      }
      return service.verifyResult(statement, opts, { status: 'verified', confidence }, [service.host.edgeEvidence(directEdge, 'direct_edge', confidence)], { ...verifyContext, directEdge });
    }
  }
  return null;
}

module.exports = { verifyAgainstEdges };
