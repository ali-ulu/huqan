'use strict';

const { attachPluginAnnotations } = require('./plugin-manager-events');
const { identitySubject, createSubjectResolver } = require('./kernel-read-use-cases-language');
const { normalizeNegationTarget } = require('./verify-turkish-text');

/**
 * The relations a stored `değil` edge can oppose. A causal edge
 * ("yangın CAUSES duman") does not assert that the subject *is* the target, so
 * a negation over the same words is not its opposite. These are the same two
 * relations lib/learn-use-case-negation-conflict.js and
 * lib/verify-contradiction-scan.js compare.
 */
const OPPOSABLE_RELATIONS = new Set(['tür', 'yapabilir']);

function createAskUseCase({ getGraph, emitPlugin, normalizeWord, ok, reason, alternatives, edgeEvidence }) {
  return function ask(question, workspaceId = 'default') {
    const event = emitPlugin('beforeAsk', { question, workspaceId });
    return attachPluginAnnotations(answer(event.question, workspaceId), event.annotations);
  };

  function answer(effectiveQuestion, workspaceId) {
    const currentGraph = getGraph();

    const raw = effectiveQuestion.toLowerCase().trim();
    // Interrogatives are noise for subject detection. Only the Turkish ones
    // were stripped, so `ask: what is a cat` kept `what` as its first word --
    // it is not a node, the lookup missed, and the answer fell back to the
    // identity subject instead of `cat` (#3639). The English set is the same
    // kind of noise: question words, articles and the copula.
    const cleaned = raw
      .replace(/\b(nedir|kimdir|nas\u0131l|nerede|nereden|nereye|ka\u00e7|hangi)\b/gi, '')
      .replace(/\b(what|is|are|was|were|who|whom|whose|which|where|when|why|how|a|an|the|do|does|did|of)\b/gi, '')
      .trim();

    const ozneBul = createSubjectResolver(currentGraph, workspaceId, normalizeWord);

    // createSubjectResolver() *synthesises* the identity subject as a
    // placeholder when it cannot detect one (`{ subject: identitySubject }`).
    // Treating that placeholder as a detected node let a question the graph
    // could not parse answer from the identity node's edges (#3908). A subject
    // is only real when a question word normalises to it. The identity node may
    // be stored under either spelling (`huqan`/`axiom`), so either counts when
    // the question actually says it.
    const IDENTITY_SUBJECTS = new Set(['huqan', 'axiom']);
    const questionNamesIdentity = raw.split(/\s+/).some((token) => IDENTITY_SUBJECTS.has(normalizeWord(token)));
    const questionNamesSubject = (id) => {
      if (!IDENTITY_SUBJECTS.has(normalizeWord(id))) return true;
      return questionNamesIdentity;
    };

    // This "I don't know" exit used to return before `afterAsk` was emitted,
    // and between them the unknown paths are the *only* reachable paths that
    // report `unknown: true` -- so no afterAsk plugin ever saw an unanswered
    // question.
    //
    // That is not a missed observation, it is a dead feature.
    // `plugins/llm-memory-plugin.js` exists to notice exactly this state
    // ("if unknown, ask the LLM and learn the answer") and its whole trigger
    // condition is `data.unknown`, which was never emitted.
    // `plugins/knowledge-freshness.js` consumes state here that `beforeAsk`
    // had just stashed, so skipping the hook left it for whichever question
    // came next instead.
    //
    // `unknown` stays true even when a plugin rewrites the text: it reports
    // what the kernel found in the graph, and a display-string edit does not
    // change that. The answered return below reads its own flag the same way.
    const answerUnknown = (subject) => {
      const event = emitPlugin('afterAsk', {
        question: effectiveQuestion,
        answer: 'Bilmiyorum',
        unknown: true,
        alternatives: 0,
      });
      const text = event && typeof event.answer === 'string' ? event.answer : 'Bilmiyorum';
      return ok('ask', { answer: text, subject, unknown: true, alternatives: 0 }, []);
    };

    if (/^(neden|niçin|nicin|niye)\b/.test(raw)) {
      const action = raw.replace(/^(neden|niçin|nicin|niye)\s+/, '');
      const { subject } = ozneBul(action);
      const subjectId = normalizeWord(subject);
      // `!!!` normalises to an empty subject. Without the emptiness guard the
      // fallback below hands `reason()` the identity node, which answers with
      // its edges and `unknown: false` -- the same confident, unrelated answer
      // #3908 removed for unparseable questions. A reason question that really
      // names `huqan`/`axiom` still passes `questionNamesSubject`.
      if (!subjectId || !questionNamesSubject(subjectId)) {
        return answerUnknown(identitySubject(currentGraph, workspaceId));
      }
      return reason(subjectId || identitySubject(currentGraph, workspaceId), workspaceId);
    }

    if (/ne olur/.test(raw) || /\w+sa\b/.test(raw) || /\w+se\b/.test(raw)) {
      const action = raw.replace(/\s+ne olur.*$/, '').replace(/\s+olursa.*$/, '').trim();
      const { subject, verb } = ozneBul(action);
      const subjectId = currentGraph.getNode(verb && normalizeWord(verb), workspaceId) ? normalizeWord(verb) : normalizeWord(subject);
      if (currentGraph.getNode(subjectId, workspaceId) && questionNamesSubject(subjectId)) {
        return reason(subjectId, workspaceId);
      }
    }

    const parts = cleaned.split(/\s+/).filter(Boolean);
    const { subject: detected } = ozneBul(parts[0] || '');
    // The first word is the subject only when it names a node. A question whose
    // real subject is not first -- word order, a leading noun the graph does not
    // know -- otherwise fell straight to the identity subject even though a
    // known node was sitting right there (#3639). The lead word still wins when
    // it hits, so this only rescues the miss.
    let finalSubject = currentGraph.getNode(detected, workspaceId) ? detected : null;
    if (!finalSubject) {
      for (const part of parts) {
        const normalized = normalizeWord(part);
        if (currentGraph.getNode(normalized, workspaceId)) { finalSubject = normalized; break; }
      }
    }
    // Whether a question word actually named a node. The identity subject is a
    // *label* to report when nothing was detected, not a subject to answer
    // from: answering from its edges meant any question the graph could not
    // parse -- "asdfqwer zzz", "the moon is made of cheese" -- returned the
    // identity node's edges with `unknown: false`, a confident unrelated answer
    // (#3908). A question that spells the identity did name it and is answered.
    let subjectDetected = finalSubject !== null;
    if (!finalSubject) finalSubject = identitySubject(currentGraph, workspaceId);
    const finalNode = currentGraph.getNode(finalSubject, workspaceId);
    if (!subjectDetected && questionNamesIdentity && finalNode) subjectDetected = true;

    if (!finalNode || !subjectDetected) {
      return answerUnknown(finalSubject);
    }

  const edges = currentGraph.getEdges(finalSubject, workspaceId);
  if (edges.length === 0) {
    return answerUnknown(finalSubject);
  }

  const hasRestriction = edges.some(edge => edge.kistlama && edge.relation === 'yapabilir');
  const allowedYapabilir = hasRestriction
    ? new Set(edges.filter(edge => edge.kistlama && edge.relation === 'yapabilir').map(edge => edge.to))
    : null;

  // #3912: `ask` answered a contradicted fact beside the negation of it. A
  // learned "kedi ucamaz" is stored as a `değil` edge and the affirmative
  // `yapabilir->ucabilir` edge stays in the graph, so "kedi ne yapabilir"
  // answered "kedi ucabilir, ucamaz": the graph's own contradiction, served as
  // grounded knowledge, while verify("kedi ucabilir") already reported
  // contradicted. The opposed affirmative is therefore not an answer.
  //
  // normalizeNegationTarget is the stem collapse verify and the learn conflict
  // detector already compare through: it folds the -abilir/-amaz pair
  // ('ucabilir' and 'ucamaz' both -> 'uc'), strips the copula marker
  // lib/learn-use-case.js appends ("hayvan [değil]"), and accepts both the
  // diacritic and the ASCII spelling.
  const negatedStems = new Set();
  for (const edge of edges) {
    if (edge.relation !== 'değil') continue;
    const stem = normalizeNegationTarget(edge.to);
    if (stem) negatedStems.add(stem);
  }
  // Only subjects that actually hold a negation pay for the comparison below;
  // without one the answer loop stays as cheap as it was (#3909).
  const hasNegations = negatedStems.size > 0;

  const sorted = [...edges].sort((left, right) => right.weight - left.weight);
  const evidence = [];
  // `results`/`targets` were arrays deduplicated with `.includes()`, a linear
  // scan per edge. For a node of degree d the loop was O(d^2) -- a 100k-edge
  // hub took ~21 s while a leaf stayed at 37 ms (#3909). A Set keeps insertion
  // order (so the answer string is unchanged) and dedup becomes O(1).
  const results = new Set();
  const seenTypeTargets = new Set();
  const collectTypeTargets = (start, depth, seen = new Set()) => {
    if (depth <= 0 || seen.has(start)) return [];
    seen.add(start);

    const targets = new Set();
    for (const edge of currentGraph.getEdges(start, workspaceId)) {
      if (edge.relation !== 'tür') continue;
      targets.add(edge.to);
      for (const transitiveTarget of collectTypeTargets(edge.to, depth - 1, seen)) {
        targets.add(transitiveTarget);
      }
    }

    return [...targets];
  };

  for (const edge of sorted) {
    if (hasRestriction && edge.relation === 'yapabilir' && !allowedYapabilir.has(edge.to)) continue;
    // #3912: the affirmative edge a stored negation refutes stays out of the
    // answer (negatedStems above); the negation itself is added below.
    if (hasNegations && OPPOSABLE_RELATIONS.has(edge.relation) && negatedStems.has(normalizeNegationTarget(edge.to))) continue;
    evidence.push(edgeEvidence(edge));
    if (edge.relation === 'tür') {
      results.add(edge.to);
      // collectTypeTargets is a depth-2 walk from `edge.to`, and the same node
      // is visited once per incoming edge -- a hub with d out-edges repeated
      // this whole walk d times. Its result depends only on `edge.to`, so cache
      // it and skip the repeat walk when the target already contributed one.
      if (!seenTypeTargets.has(edge.to)) {
        seenTypeTargets.add(edge.to);
        for (const target of collectTypeTargets(edge.to, 2)) {
          results.add(target);
        }
      }
    } else {
      results.add(edge.to);
    }
  }

  const altResult = alternatives(finalSubject, 2, workspaceId);
  const altPaths = altResult.data.paths || [];
  const altText = altPaths.length > 1
    ? `\n  alternatif: ${altPaths.map(path => `[${path.type}] ${path.to}`).join(', ')}`
    : '';

  // One computed value feeds both the hook payload and the returned flag.
  // They were written out separately -- `results.length === 0` below and a
  // hardcoded `unknown: false` on the return -- which is a trap now that
  // C3 made the flag authoritative for callers like `chooseFollowUp`. No
  // input reaches this line with an empty `results` today (every edge that
  // survives the restriction filter pushes a target, and the restriction
  // itself guarantees at least one survivor), so this is hardening, not a
  // live fix: the two can no longer drift apart if that changes.
  const resultList = [...results];
  const unanswered = resultList.length === 0;
  const answer = unanswered ? 'Bilmiyorum' : `${finalSubject} ${resultList.join(', ')}${altText}`;
  // plugins.emit() returns the same data object it was given, so a
  // plugin that mutates `answer` in place (e.g. to redact a secret
  // before it reaches the caller) is only effective if this call site
  // reads the result back -- discarding it here made every afterAsk
  // plugin observability-only, unable to actually change the response.
  // `unknown` travels with the payload so an afterAsk plugin can branch on
  // the structural signal instead of matching the Turkish display string.
  const afterAskResult = emitPlugin('afterAsk', {
    question: effectiveQuestion,
    answer,
    unknown: unanswered,
    alternatives: altPaths.length,
  });
  const finalAnswer = afterAskResult && typeof afterAskResult.answer === 'string' ? afterAskResult.answer : answer;
  return ok('ask', { answer: finalAnswer, subject: finalSubject, unknown: unanswered, alternatives: altPaths.length }, evidence);
  };
}

module.exports = { createAskUseCase };
