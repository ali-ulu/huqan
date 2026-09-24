'use strict';

const { identitySubject, createSubjectResolver } = require('./kernel-read-use-cases-language');

function createAskUseCase({ getGraph, emitPlugin, normalizeWord, ok, reason, alternatives, edgeEvidence }) {
  return function ask(question, workspaceId = 'default') {
    const event = emitPlugin('beforeAsk', { question, workspaceId });
    const effectiveQuestion = event.question;
    const currentGraph = getGraph();

    const raw = effectiveQuestion.toLowerCase().trim();
    const cleaned = raw
      .replace(/\b(nedir|kimdir|nas\u0131l|nerede|nereden|nereye|ka\u00e7|hangi)\b/gi, '')
      .trim();

    const ozneBul = createSubjectResolver(currentGraph, workspaceId, normalizeWord);

    if (/^(neden|niçin|nicin|niye)\b/.test(raw)) {
      const action = raw.replace(/^(neden|niçin|nicin|niye)\s+/, '');
      const { subject } = ozneBul(action);
      const subjectId = normalizeWord(subject);
      return reason(subjectId || identitySubject(currentGraph, workspaceId), workspaceId);
    }

    if (/ne olur/.test(raw) || /\w+sa\b/.test(raw) || /\w+se\b/.test(raw)) {
      const action = raw.replace(/\s+ne olur.*$/, '').replace(/\s+olursa.*$/, '').trim();
      const { subject, verb } = ozneBul(action);
      const subjectId = currentGraph.getNode(verb && normalizeWord(verb), workspaceId) ? normalizeWord(verb) : normalizeWord(subject);
      if (currentGraph.getNode(subjectId, workspaceId)) {
        return reason(subjectId, workspaceId);
      }
    }

    const parts = cleaned.split(/\s+/).filter(Boolean);
    const { subject: detected } = ozneBul(parts[0] || '');
    const node = currentGraph.getNode(detected, workspaceId);
    const finalSubject = node ? detected : identitySubject(currentGraph, workspaceId);
    const finalNode = currentGraph.getNode(finalSubject, workspaceId);

    // Both "I don't know" exits below used to return before `afterAsk` was
    // emitted, and between them they are the *only* reachable paths that
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
      return ok('ask', { answer: text, subject, unknown: true }, []);
  };

  if (!finalNode) {
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

  const sorted = [...edges].sort((left, right) => right.weight - left.weight);
  const evidence = [];
  const results = [];
  const collectTypeTargets = (start, depth, seen = new Set()) => {
    if (depth <= 0 || seen.has(start)) return [];
    seen.add(start);

    const targets = [];
    for (const edge of currentGraph.getEdges(start, workspaceId)) {
      if (edge.relation !== 'tür') continue;
      if (!targets.includes(edge.to)) targets.push(edge.to);
      for (const transitiveTarget of collectTypeTargets(edge.to, depth - 1, seen)) {
        if (!targets.includes(transitiveTarget)) targets.push(transitiveTarget);
      }
    }

    return targets;
  };

  for (const edge of sorted) {
    if (hasRestriction && edge.relation === 'yapabilir' && !allowedYapabilir.has(edge.to)) continue;
    evidence.push(edgeEvidence(edge));
    if (edge.relation === 'tür') {
      if (!results.includes(edge.to)) results.push(edge.to);
      const transitive = collectTypeTargets(edge.to, 2);
      for (const target of transitive) {
        if (!results.includes(target)) results.push(target);
      }
    } else if (edge.relation === 'yapabilir') {
      if (!results.includes(edge.to)) results.push(edge.to);
    } else if (!results.includes(edge.to)) {
      results.push(edge.to);
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
  const unanswered = results.length === 0;
  const answer = unanswered ? 'Bilmiyorum' : `${finalSubject} ${results.join(', ')}${altText}`;
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
