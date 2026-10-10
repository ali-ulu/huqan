'use strict';

// AURA risk plugin (#AURA-bridge).
//
// HUQAN's own manipulation layer (lib/text-safety-scorer.js) recognises
// user->system pressure: prompt injection, coercive urgency, unsupported
// authority, false certainty. It does not recognise the *social* vectors a
// user aims at another person: camouflage personas, alibis, targeted
// reconnaissance, extortion leverage, high-value targeting. AURA
// (kate8382/AURA) carries exactly those signals.
//
// This plugin is the read side of the loop. It loads a deterministic AURA
// signal pack (lib/aura-signal-pack.js) and, on learn/ask, annotates the
// payload with the AURA signals the text matches. It never decides on its
// own and never writes canonical state: it proposes a signal, core trust
// mechanics stay in charge (docs/core-plugin-boundary-contract.md).
//
// Fail-closed: with no pack the plugin contributes nothing. It does not
// invent a signal and does not downgrade a decision.

const fs = require('node:fs');
const { analyseManipulation } = require('../lib/text-safety-scorer');
const { computeContentHash, defaultPackPath } = require('../lib/aura-signal-pack');

const PLUGIN_NAME = 'aura-risk';
const PLUGIN_VERSION = '0.1.0';

// The pack's AURA decision is AURA's, not HUQAN's. The loop maps it into
// HUQAN's vocabulary in one place so the two never drift: a cross-check that
// is still unanswered ('pending') is human review here, not an allow.
const AURA_DECISION_TO_HUQAN = Object.freeze({
  block: 'block',
  review: 'review',
  pending: 'review',
  allow: 'allow',
});

// Fraction of the input's tokens that must appear in a case's scenario text
// before that case is considered the match. Deliberately high: a weak overlap
// is not evidence. At 0.5 a two-word question ("what is a cat") shares a token
// with some scenario and clears the bar; a real paraphrase shares far more.
const DEFAULT_CASE_MATCH_THRESHOLD = 0.6;
const HIGH_RISK_THRESHOLD = 0.7;

function packPath(options = {}) {
  return options.packPath || process.env.AURA_SIGNAL_PACK || defaultPackPath();
}

function emptyPack() {
  return { packVersion: '', contentHash: '', engineAvailable: false, signalIds: [], triggerToSignal: {}, cases: [] };
}

function loadPack(options = {}) {
  const file = packPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return emptyPack();
    const triggerToSignal = parsed.triggerToSignal && typeof parsed.triggerToSignal === 'object' ? parsed.triggerToSignal : {};
    const contentHash = computeContentHash({ signalIds: parsed.signalIds, triggerToSignal });
    const pinned = options.expectedContentHash || process.env.AURA_SIGNAL_PACK_HASH || '';
    if (pinned && pinned !== contentHash) return emptyPack();
    return {
      packVersion: parsed.packVersion || '',
      contentHash,
      engineAvailable: parsed.engineAvailable === true,
      signalIds: Array.isArray(parsed.signalIds) ? parsed.signalIds : [],
      triggerToSignal,
      cases: Array.isArray(parsed.cases) ? parsed.cases : [],
    };
  } catch (_) {
    return emptyPack();
  }
}

function tokenize(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

// Containment of the input's tokens inside a case's scenario text. Chosen over
// Jaccard so a short paraphrase still matches a long scenario.
function containment(inputTokens, scenarioText) {
  if (inputTokens.length === 0) return 0;
  const scenario = new Set(tokenize(scenarioText));
  if (scenario.size === 0) return 0;
  let hits = 0;
  for (const token of new Set(inputTokens)) if (scenario.has(token)) hits += 1;
  return hits / new Set(inputTokens).size;
}

function bestCaseMatch(text, cases, threshold) {
  const inputTokens = tokenize(text);
  let best = null;
  for (const entry of cases) {
    const scenarioText = Array.isArray(entry.scenario_texts) ? entry.scenario_texts.join(' ') : '';
    const score = containment(inputTokens, scenarioText);
    if (score >= threshold && (!best || score > best.overlap)) {
      best = {
        case_id: entry.case_id,
        category: entry.category,
        decision: entry.decision,
        confidence: entry.confidence,
        signal_ids: Array.isArray(entry.signal_ids) ? entry.signal_ids : [],
        overlap: Math.round(score * 100) / 100,
      };
    }
  }
  return best;
}

// Pure, deterministic classification. The baseline is HUQAN's own scorer; the
// AURA layer adds the social vectors it lacks. riskScore is the max of the two
// so neither layer can lower the other's finding.
function classifyText(text, pack, options = {}) {
  const threshold = typeof options.caseMatchThreshold === 'number'
    ? options.caseMatchThreshold
    : DEFAULT_CASE_MATCH_THRESHOLD;
  const normalized = String(text || '').toLowerCase();
  const signals = new Map();
  const addSignal = (signalId, source, detail) => {
    if (!signals.has(signalId)) signals.set(signalId, { signalId, sources: [], triggers: [], cases: [] });
    const entry = signals.get(signalId);
    if (source === 'trigger' && detail && !entry.triggers.includes(detail)) entry.triggers.push(detail);
    if (source === 'case' && detail && !entry.cases.includes(detail)) entry.cases.push(detail);
    if (!entry.sources.includes(source)) entry.sources.push(source);
  };

  for (const [trigger, signalId] of Object.entries(pack.triggerToSignal)) {
    if (trigger && normalized.includes(trigger)) addSignal(signalId, 'trigger', trigger);
  }

  const caseMatch = bestCaseMatch(text, pack.cases, threshold);
  if (caseMatch) for (const signalId of caseMatch.signal_ids) addSignal(signalId, 'case', caseMatch.case_id);

  const baseline = analyseManipulation(text);
  // The AURA layer's strength is how much of *this input* the matched case
  // explains, not the case's stored corpus confidence: confidence is a property
  // of the case, so using it would score every matched input the same no matter
  // how little of it the case actually covers.
  const caseEvidence = caseMatch ? caseMatch.overlap : 0;
  const riskScore = Math.max(baseline.score || 0, caseEvidence);

  return {
    signals: [...signals.values()].sort((a, b) => a.signalId.localeCompare(b.signalId)),
    signalIds: [...signals.keys()].sort(),
    caseMatch,
    baseline: { score: baseline.score || 0, labels: baseline.labels || [], blocked: baseline.blocked === true },
    riskScore: Math.round(riskScore * 100) / 100,
    highRisk: riskScore >= HIGH_RISK_THRESHOLD,
    engineAvailable: pack.engineAvailable === true,
  };
}

// The gate event carries no single "text" field: a learn carries `text`, an
// ask `question`, an agent `goal`. Scan the bounded metadata for the first
// string that looks like the user's request.
function candidateTextFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
  // Gate events carry the call under `args` (the MCP gate input shape); learn
  // and ask events carry the text at the top level. Both are read here.
  const args = event.args && typeof event.args === 'object' ? event.args : {};
  for (const value of [
    event.text, event.question, event.goal, event.statement,
    args.text, args.question, args.goal, args.statement,
    metadata.text, metadata.question, metadata.goal, metadata.statement,
  ]) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return '';
}

function createAuraRiskPlugin(options = {}) {
  let pack = options.pack || null;
  const getPack = () => {
    if (!pack) pack = loadPack(options);
    return pack;
  };
  const threshold = typeof options.caseMatchThreshold === 'number' ? options.caseMatchThreshold : DEFAULT_CASE_MATCH_THRESHOLD;

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    capabilities: [],
    optional: [],
    requires: [],

    // learn path: attach AURA signals to the incoming text before it is learned.
    beforeLearn(_kernel, data) {
      if (!data || typeof data.text !== 'string' || !data.text.trim()) return data;
      data.aura = classifyText(data.text, getPack(), { caseMatchThreshold: threshold });
      return data;
    },

    // ask path: the question is the user's text.
    beforeAsk(_kernel, data) {
      if (!data || typeof data.question !== 'string' || !data.question.trim()) return data;
      data.aura = classifyText(data.question, getPack(), { caseMatchThreshold: threshold });
      return data;
    },

    // observation: when HUQAN's gate allowed something AURA scores high, the
    // plugin flags the blind spot on the event. It does not change the
    // decision — recording it is the loop's job, not a plugin's.
    afterGateDecision(_kernel, data) {
      if (!data || typeof data !== 'object') return data;
      const text = candidateTextFromEvent(data);
      if (!text) return data;
      const aura = classifyText(text, getPack(), { caseMatchThreshold: threshold });
      data.aura = aura;
      const decision = typeof data.decision === 'string' ? data.decision : '';
      if (decision === 'allow' && aura.highRisk) {
        data.auraBlindSpot = true;
      }
      return data;
    },

    // The contribution half of the boundary contract. This is NOT the MCP gate
    // hook: the MCP gate's own `beforeGateDecision` is dispatched by
    // collectEvidence and takes the payload directly. This method is the
    // *signal* seam — lib/gate-signal-provider.js calls it for every loaded
    // plugin and folds the signals it returns into one most-restrictive verdict
    // that the gate is free to merge. It returns a bounded signal (a decision
    // plus the AURA signal ids that produced it), never a payload mutation.
    gateSignal(_kernel, data) {
      if (!data || typeof data !== 'object') return undefined;
      const text = candidateTextFromEvent(data);
      if (!text) return undefined;
      const aura = classifyText(text, getPack(), { caseMatchThreshold: threshold });
      if (!aura.highRisk) return undefined;
      return {
        decision: AURA_DECISION_TO_HUQAN[aura.caseMatch && aura.caseMatch.decision] || 'review',
        reason: `aura_signals:${aura.signalIds.join(',')}`,
        riskScore: Math.round(aura.riskScore * 100),
        signals: aura.signalIds,
      };
    },
  };
}

const defaultInstance = createAuraRiskPlugin();

module.exports = defaultInstance;
module.exports.create = createAuraRiskPlugin;
module.exports.AURA_DECISION_TO_HUQAN = AURA_DECISION_TO_HUQAN;
module.exports._test = {
  PLUGIN_NAME,
  HIGH_RISK_THRESHOLD,
  DEFAULT_CASE_MATCH_THRESHOLD,
  bestCaseMatch,
  candidateTextFromEvent,
  classifyText,
  containment,
  loadPack,
  tokenize,
};
