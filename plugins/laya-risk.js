'use strict';

// Laya risk plugin (#laya-bridge, issue #3797; MCP protocol fix #3974).
//
// HUQAN's own manipulation layer (lib/text-safety-scorer.js) recognises a
// narrow slice of user->system pressure: prompt injection, coercive urgency,
// unsupported authority, false certainty. It is a rule matcher, not a
// calibrated classifier, so it cannot answer a *typed* risk question about an
// arbitrary candidate action ("is this egress action in scope?", "which risk
// class does this payload fall in?").
//
// Laya (NandhaKishorM/laya, Apache-2.0) is a local, non-autoregressive decision
// model: it answers `noul` (binary), `choice` (multi-class) and `score`
// (ordinal) questions over a supplied state and returns calibrated
// probabilities in one forward pass. It runs CPU-only, is deterministic per
// input, and is driven by the `laya-mcp-server` sidecar. It is a good fit for a
// *signal producer*, never a decision authority.
//
// The sidecar is an MCP stdio server, not a bespoke one-shot protocol: the
// documented entry point is `laya-mcp-server` and the documented tool is
// `laya_predict`. lib/laya-mcp-client.js speaks that protocol in a short-lived
// helper process, so the synchronous gate seam this plugin feeds is never
// blocked by a pipe it cannot flush (#3974).
//
// This plugin is the read side of that bridge: it asks Laya a small fixed set
// of typed questions and maps the calibrated answer into HUQAN's vocabulary in
// one place, so the two never drift. It proposes; core trust mechanics stay in
// charge (docs/core-plugin-boundary-contract.md), and it never writes state.
//
// Fail-closed: with no sidecar configured, or an unreachable/degraded model,
// the lookup returns no reading, the plugin contributes nothing, and it never
// downgrades a core decision. The client bounds the call with an explicit
// timeout and output cap so an unresponsive sidecar cannot block the
// synchronous gate path. No cloud call, no API key.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { LayaMcpClient } = require('../lib/laya-mcp-client');

const PLUGIN_NAME = 'laya-risk';
const PLUGIN_VERSION = '0.2.0';

// The sidecar's decision is Laya's, not HUQAN's; the bridge maps it into
// HUQAN's vocabulary in one place so the two never drift. A graded answer that
// is not a clean "allow" is a review: an uncertain signal must not read as
// permission.
const LAYA_DECISION_TO_HUQAN = Object.freeze({
  block: 'block',
  review: 'review',
  allow: 'allow',
});

// The fixed question set: the Laya question kind, the question it asks, the
// Laya criteria the answer is drawn from, and the HUQAN-facing meaning of its
// answer. The binding between the model's raw answer and HUQAN's verdict lives
// in exactly one place, `questionDecision`, so a Laya upgrade cannot silently
// re-grade a question.
const DEFAULT_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'scope',
    kind: 'noul',
    // Worded as a breach question on purpose. `noul` is P(true), and every
    // question here is read as "a higher value is riskier", so the decision
    // mapping and the risk score share one orientation. Asking the matching
    // form instead ("does this action match the workspace's declared scope")
    // reads a high P(true) as in-scope while the mapping still treats it as a
    // breach -- the inversion #3971 reports.
    ask: 'is this action outside the workspace\'s declared scope',
    // A high probability of "yes" is a scope breach.
    questionDecision: (value, threshold) => (value >= threshold ? 'review' : 'allow'),
  }),
  Object.freeze({
    id: 'risk_class',
    kind: 'choice',
    ask: 'which risk class does this payload fall in',
    criteria: Object.freeze({
      allow: 'an ordinary, in-policy action with no restricted capability',
      restricted: 'an action that needs review before it runs',
      high_risk: 'an action that could destroy data or leave the machine',
    }),
    // The choice label is Laya's; a non-allow class is a review regardless of
    // its ordering across Laya versions.
    questionDecision: (value) => (String(value).toLowerCase() === 'allow' ? 'allow' : 'review'),
  }),
  Object.freeze({
    id: 'severity',
    kind: 'score',
    ask: 'how severe is this payload on a 0 to 1 scale',
    // An ordinal rubric. Laya answers a `score` question with the *expected
    // level index* (0..k-1), not a 0..1 fraction, so the bridge normalizes by
    // the rubric length before comparing against the threshold (#3974).
    criteria: Object.freeze(['none', 'low', 'medium', 'high']),
    // Ordinal severity: a high score is a review.
    questionDecision: (value, threshold) => (value >= threshold ? 'review' : 'allow'),
  }),
]);

const DEFAULT_CALL_THRESHOLD = 0.6;
const HIGH_RISK_SCORE = 70;

function envValue(name) {
  const raw = process.env[name];
  return typeof raw === 'string' && raw.trim() ? raw.trim() : '';
}

function callThreshold(options = {}) {
  const raw = options.callThreshold !== undefined ? options.callThreshold : envValue('LAYA_RISK_CALL_THRESHOLD');
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CALL_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CALL_THRESHOLD;
}

// Laya's question schema (`laya.mcp.tools.validate_questions`): a `choice` needs
// a non-empty object of label -> description, a `score` needs a non-empty list
// of rubric levels, and a `noul` needs neither. A question this plugin cannot
// express in that schema is dropped, so the model is never asked a malformed one.
function layaQuestionSpec(question) {
  const spec = { type: question.kind, instructions: question.ask };
  if (question.kind === 'choice') {
    const criteria = question.criteria;
    if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria) || Object.keys(criteria).length === 0) return null;
    spec.criteria = { ...criteria };
  } else if (question.kind === 'score') {
    const criteria = question.criteria;
    if (!Array.isArray(criteria) || criteria.length === 0) return null;
    spec.criteria = criteria.slice();
  }
  return spec;
}

function layaQuestions(questions) {
  const out = {};
  for (const question of questions || []) {
    const spec = layaQuestionSpec(question);
    if (spec) out[question.id] = spec;
  }
  return out;
}

// The rubric length a `score` answer is an index into, so the index normalizes
// onto the same 0..1 scale the decision mapping assumes.
function scoreLevelCount(question) {
  return Array.isArray(question.criteria) ? question.criteria.length : 0;
}

// Read Laya's answer for one question. `noul` -> P(true), `choice` -> the chosen
// label, `score` -> the expected level index normalized onto 0..1. A missing
// field is a degraded answer, not a low score, so it returns null.
function questionValue(answer, question) {
  if (!answer || typeof answer !== 'object') return null;
  if (question.kind === 'noul') {
    const value = Number(answer.noul);
    return Number.isFinite(value) ? value : null;
  }
  if (question.kind === 'choice') {
    const value = answer.choice;
    return value === undefined || value === null ? null : String(value);
  }
  if (question.kind === 'score') {
    const raw = Number(answer.score);
    if (!Number.isFinite(raw)) return null;
    const levels = scoreLevelCount(question);
    if (levels > 1) return Math.min(1, Math.max(0, raw / (levels - 1)));
    return Math.min(1, Math.max(0, raw));
  }
  return null;
}

// The calibrated confidence that rides with an answer, used only for the risk
// score. For `choice` it is the chosen label's probability.
function answerProbability(answer, question, value) {
  if (!answer || typeof answer !== 'object') return NaN;
  if (question.kind === 'noul' || question.kind === 'score') return value;
  const probabilities = answer.probabilities;
  if (probabilities && typeof probabilities === 'object') {
    const chosen = Number(probabilities[answer.choice]);
    if (Number.isFinite(chosen)) return chosen;
  }
  const confidence = Number(answer.answer_confidence !== undefined ? answer.answer_confidence : answer.confidence);
  return Number.isFinite(confidence) ? confidence : NaN;
}

// A question supplied by the pack carries only id/kind/ask; its HUQAN verdict
// mapping is resolved from the built-in set by id (or kind), so the binding
// still lives in exactly one place.
function decisionFor(question, value, threshold) {
  if (question && typeof question.questionDecision === 'function') {
    return question.questionDecision(value, threshold);
  }
  const builtin = DEFAULT_QUESTIONS.find((entry) => entry.id === question.id)
    || DEFAULT_QUESTIONS.find((entry) => entry.kind === question.kind);
  return builtin ? builtin.questionDecision(value, threshold) : 'review';
}

// Pure, deterministic read over a supplied model handle. `handle.predict(state,
// questions)` answers the whole typed question set in one Laya forward pass and
// returns an `answers` map keyed by question id; a missing handle or a null map
// is Laya unavailable.
function classifyWithLaya(handle, text, questions = DEFAULT_QUESTIONS, options = {}) {
  const threshold = callThreshold(options);
  const engineAvailable = Boolean(handle && typeof handle.predict === 'function');
  const readings = [];
  const signals = [];
  let riskScore = 0;

  if (engineAvailable) {
    let answers = null;
    try {
      answers = handle.predict({ text: String(text || '') }, questions);
    } catch (_) {
      answers = null;
    }
    const map = answers && typeof answers === 'object' ? answers : null;
    for (const question of questions) {
      const answer = map ? map[question.id] : null;
      const value = questionValue(answer, question);
      if (value === null) continue;
      const decision = decisionFor(question, value, threshold);
      const probability = answerProbability(answer, question, value);
      readings.push({
        id: question.id,
        kind: question.kind,
        value,
        decision,
        probability: Number.isFinite(probability) ? probability : undefined,
      });
      if (decision !== 'allow') {
        signals.push(`laya:${question.id}`);
        const readingScore = (question.kind === 'score' ? value : probability) * 100;
        riskScore = Math.max(riskScore, Number.isFinite(readingScore) ? readingScore : 0);
      }
    }
  }

  return {
    engineAvailable,
    readings,
    signalIds: [...new Set(signals)].sort(),
    decision: signals.length > 0 ? 'review' : 'allow',
    riskScore: Math.round(riskScore),
    highRisk: riskScore >= HIGH_RISK_SCORE,
  };
}

// The gate event carries no single "text" field: a learn carries `text`, an ask
// `question`, an agent `goal`. Scan the bounded metadata for the first string
// that looks like the user's request.
function candidateTextFromEvent(event) {
  if (!event || typeof event !== 'object') return '';
  const payload = event.payload && typeof event.payload === 'object' ? event.payload : {};
  const metadata = payload.metadata && typeof payload.metadata === 'object' ? payload.metadata : {};
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

// A pack mirrors aura-signal-pack's pin seam: approve the plugin's questions,
// not the sidecar binary. The sidecar is addressed by command/env, not bundled,
// so hashing its bytes is meaningless; the pack pins the question set instead.
function questionsHash(questions) {
  return crypto.createHash('sha256')
    .update(JSON.stringify((questions || []).map((q) => ({ id: q.id, kind: q.kind, ask: q.ask }))))
    .digest('hex');
}

function emptyPack(drift = false) {
  return { packVersion: '', contentHash: '', engineAvailable: false, questions: [], pinned: false, drift };
}

function packPath(options = {}) {
  return options.packPath || envValue('LAYA_RISK_PACK') || path.join(__dirname, 'laya-risk.pack.json');
}

function loadPack(options = {}) {
  const file = packPath(options);
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const questions = Array.isArray(parsed.questions) ? parsed.questions : [];
    const hash = questionsHash(questions);
    const pinned = options.expectedContentHash || envValue('LAYA_RISK_PACK_HASH') || '';
    if (pinned && pinned !== hash) return emptyPack(true);
    return {
      packVersion: parsed.packVersion || '',
      contentHash: hash,
      engineAvailable: parsed.engineAvailable === true,
      questions,
      pinned: Boolean(pinned),
      drift: false,
    };
  } catch (_) {
    return emptyPack(false);
  }
}

// A handle backed by the `laya-mcp-server` sidecar. The client confirms the
// sidecar once, then runs one bounded MCP exchange per call (see
// lib/laya-mcp-client.js); an unreachable sidecar yields a null reading.
function createLayaHandle(options = {}) {
  let client = null;
  return {
    predict(state, questions) {
      const spec = layaQuestions(questions);
      if (Object.keys(spec).length === 0) return null;
      if (!client) client = options.client || new LayaMcpClient(options);
      if (!client.start()) return null;
      // The tool returns its whole payload; the read wants just `answers`.
      const payload = client.callTool('laya_predict', { state, questions: spec });
      return payload && payload.answers && typeof payload.answers === 'object' ? payload.answers : null;
    },
    status: () => (client ? client.status() : { available: false, reason: 'not_started', command: '' }),
    close() {
      if (client) { client.close(); client = null; }
    },
  };
}

function createLayaRiskPlugin(options = {}) {
  let pack = options.pack || null;
  const getPack = () => {
    if (!pack) pack = loadPack(options);
    return pack;
  };
  let handle = null;
  const getHandle = () => {
    if (options.handle !== undefined) return options.handle;
    if (!handle) handle = createLayaHandle(options);
    return handle;
  };
  const fallbackQuestions = options.questions || DEFAULT_QUESTIONS;

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    capabilities: [],
    optional: [],
    requires: [],

    // Whether the bridge can answer right now: how an operator tells a degraded
    // sidecar apart from an ordinary allow, which the gate reads as no evidence.
    status() {
      return getHandle().status();
    },

    // The contribution half of the boundary contract. This method is the
    // *signal* seam -- lib/gate-signal-provider.js calls it for every loaded
    // plugin and folds the signals it returns into one most-restrictive verdict
    // that the gate is free to merge. It returns a bounded signal, never a
    // payload mutation.
    gateSignal(_kernel, data) {
      if (!data || typeof data !== 'object') return undefined;
      const text = candidateTextFromEvent(data);
      if (!text) return undefined;
      const packValue = getPack();
      // Fail-closed on a drifted pack: the questions this plugin asks are the
      // ones the operator approved, or it asks none.
      if (packValue.drift) return undefined;
      const questions = Array.isArray(packValue.questions) && packValue.questions.length > 0
        ? packValue.questions
        : fallbackQuestions;
      const reading = classifyWithLaya(getHandle(), text, questions, options);
      if (!reading.engineAvailable || reading.decision === 'allow') return undefined;
      return {
        id: PLUGIN_NAME,
        decision: LAYA_DECISION_TO_HUQAN[reading.decision] || 'review',
        reason: `laya_signals:${reading.signalIds.join(',')}`,
        riskScore: Math.max(0, Math.min(100, reading.riskScore)),
        signals: reading.signalIds,
      };
    },
  };
}

const defaultInstance = createLayaRiskPlugin();

module.exports = defaultInstance;
module.exports.create = createLayaRiskPlugin;
module.exports.LAYA_DECISION_TO_HUQAN = LAYA_DECISION_TO_HUQAN;
module.exports._test = {
  PLUGIN_NAME,
  DEFAULT_QUESTIONS,
  DEFAULT_CALL_THRESHOLD,
  HIGH_RISK_SCORE,
  answerProbability,
  candidateTextFromEvent,
  classifyWithLaya,
  createLayaHandle,
  layaQuestionSpec,
  layaQuestions,
  loadPack,
  questionValue,
  questionsHash,
  scoreLevelCount,
};
