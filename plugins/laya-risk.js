'use strict';

// Laya risk plugin (#laya-bridge, issue #3797).
//
// HUQAN's own manipulation layer (lib/text-safety-scorer.js) recognises a
// narrow slice of user->system pressure: prompt injection, coercive urgency,
// unsupported authority, false certainty. It is a rule matcher, not a
// calibrated classifier, so it cannot answer a *typed* risk question about an
// arbitrary candidate action ("is this egress action in scope for this
// workspace?", "which risk class does this payload fall in?").
//
// Laya (NandhaKishorM/laya, Apache-2.0) is a local, non-autoregressive decision
// model: it answers `noul` (binary), `choice` (multi-class) and `score`
// (ordinal) questions over a supplied state and returns calibrated
// probabilities in one forward pass. It runs CPU-only, is deterministic per
// input, and is driven by the `laya-mcp` sidecar. It is a good fit for a
// *signal producer*, never a decision authority.
//
// This plugin is the read side of that bridge. On the gate signal seam it asks
// Laya a small fixed set of typed questions about the candidate action and maps
// the calibrated answer into HUQAN's vocabulary in one place, so the two never
// drift. It proposes; core trust mechanics stay in charge
// (docs/core-plugin-boundary-contract.md). It never writes canonical state.
//
// Fail-closed: with no sidecar configured, or an unreachable/degraded model,
// the lookup returns no reading, the plugin contributes nothing, and it never
// downgrades a core decision. No cloud call, no API key.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const PLUGIN_NAME = 'laya-risk';
const PLUGIN_VERSION = '0.1.0';

// The sidecar's decision is Laya's, not HUQAN's. The bridge maps it into
// HUQAN's vocabulary in one place so the two never drift. A graded answer that
// is not a clean "allow" is a review here, not an allow: an uncertain signal
// must not read as permission.
const LAYA_DECISION_TO_HUQAN = Object.freeze({
  block: 'block',
  review: 'review',
  allow: 'allow',
});

// The fixed question set. Each entry names the Laya question kind, the question
// it asks, and the HUQAN-facing meaning of its answer. The binding between the
// model's raw answer and HUQAN's verdict lives in exactly one place,
// `questionDecision`, so a Laya upgrade cannot silently re-grade a question.
const DEFAULT_QUESTIONS = Object.freeze([
  Object.freeze({
    id: 'scope',
    kind: 'noul',
    ask: 'does this action match the workspace\'s declared scope',
    // A high probability of "no" is a scope breach.
    questionDecision: (value, threshold) => (value >= threshold ? 'review' : 'allow'),
  }),
  Object.freeze({
    id: 'risk_class',
    kind: 'choice',
    ask: 'which risk class does this payload fall in',
    // The choice label is Laya's; a non-allow class is a review regardless of
    // its ordering across Laya versions.
    questionDecision: (value) => (String(value).toLowerCase() === 'allow' ? 'allow' : 'review'),
  }),
  Object.freeze({
    id: 'severity',
    kind: 'score',
    ask: 'how severe is this payload on a 0 to 1 scale',
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

function command() {
  return envValue('LAYA_MCP_CMD') || 'laya-mcp';
}

function commandArgs(mode) {
  const template = envValue('LAYA_MCP_ARGS');
  if (template) return template.split(/\s+/).filter(Boolean);
  return [mode];
}

function callThreshold(options = {}) {
  const raw = options.callThreshold !== undefined ? options.callThreshold : envValue('LAYA_RISK_CALL_THRESHOLD');
  if (raw === undefined || raw === null || raw === '') return DEFAULT_CALL_THRESHOLD;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : DEFAULT_CALL_THRESHOLD;
}

// The sidecar's one-shot protocol: one JSON request on stdin, one JSON answer
// on stdout. Anything else -- a missing binary, a non-zero exit, a non-JSON
// stdout, no output -- is a degraded model, so the caller gets null and the
// plugin contributes nothing.
function askSidecar(mode, request) {
  let result;
  try {
    result = spawnSync(command(), commandArgs(mode), {
      encoding: 'utf8',
      input: JSON.stringify(request),
    });
  } catch (_) {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const stdout = typeof result.stdout === 'string' ? result.stdout : '';
  if (!stdout.trim()) return null;
  try {
    const parsed = JSON.parse(stdout);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

// Read Laya's answer for one question. `noul` -> {probability}, `choice` ->
// {label}, `score` -> {score}. A missing field is a degraded answer, not a low
// score, so it returns null and the plugin contributes nothing.
function questionValue(answer, question) {
  if (!answer || typeof answer !== 'object') return null;
  if (question.kind === 'noul') {
    const value = Number(answer.probability !== undefined ? answer.probability : answer.p);
    return Number.isFinite(value) ? value : null;
  }
  if (question.kind === 'choice') {
    const value = answer.label !== undefined ? answer.label : answer.choice;
    return value === undefined || value === null ? null : String(value);
  }
  if (question.kind === 'score') {
    const value = Number(answer.score !== undefined ? answer.score : answer.value);
    return Number.isFinite(value) ? value : null;
  }
  return null;
}

// Pure, deterministic read over a supplied model handle. `handle.ask(question,
// state)` answers one typed question; a missing handle is Laya unavailable.
//
// A question supplied by the pack carries only id/kind/ask; its HUQAN verdict
// mapping is resolved from the built-in set by id (or kind), so the
// answer->verdict binding still lives in exactly one place.
function decisionFor(question, value, threshold) {
  if (question && typeof question.questionDecision === 'function') {
    return question.questionDecision(value, threshold);
  }
  const builtin = DEFAULT_QUESTIONS.find((entry) => entry.id === question.id)
    || DEFAULT_QUESTIONS.find((entry) => entry.kind === question.kind);
  return builtin ? builtin.questionDecision(value, threshold) : 'review';
}

function classifyWithLaya(handle, text, questions = DEFAULT_QUESTIONS, options = {}) {
  const threshold = callThreshold(options);
  const engineAvailable = Boolean(handle && typeof handle.ask === 'function');
  const state = { text: String(text || '') };
  const readings = [];
  const signals = [];
  let riskScore = 0;

  if (engineAvailable) {
    for (const question of questions) {
      let answer = null;
      try {
        answer = handle.ask(question, state);
      } catch (_) {
        answer = null;
      }
      const value = questionValue(answer, question);
      if (value === null) continue;
      const decision = decisionFor(question, value, threshold);
      const probability = question.kind === 'noul'
        ? value
        : (answer.probability !== undefined ? Number(answer.probability) : NaN);
      readings.push({
        id: question.id,
        kind: question.kind,
        value,
        decision,
        probability: Number.isFinite(probability) ? probability : undefined,
      });
      if (decision !== 'allow') {
        signals.push(`laya:${question.id}`);
        const readingScore = question.kind === 'score'
          ? value * 100
          : (Number.isFinite(probability) ? probability * 100 : 0);
        riskScore = Math.max(riskScore, readingScore);
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
// so hashing its bytes is not meaningful; the pack pins the question set so a
// drift in what is asked is detectable.
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

// A handle backed by the `laya-mcp` sidecar. It holds a single sidecar slot so
// the warm model is reused across gate calls; an unreachable sidecar yields a
// null reading and the plugin contributes nothing.
function createSidecarHandle() {
  let slot = null;
  return {
    ask(question, state) {
      if (slot === null) {
        const started = askSidecar('mcp', { action: 'start' });
        if (!started || typeof started.slot !== 'string') return null;
        slot = started.slot;
      }
      return askSidecar('mcp', {
        action: 'ask',
        slot,
        question: { kind: question.kind, ask: question.ask },
        state,
      });
    },
  };
}

function createLayaRiskPlugin(options = {}) {
  let pack = options.pack || null;
  const getPack = () => {
    if (!pack) pack = loadPack(options);
    return pack;
  };
  const getHandle = () => (options.handle !== undefined ? options.handle : createSidecarHandle());
  const fallbackQuestions = options.questions || DEFAULT_QUESTIONS;

  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    capabilities: [],
    optional: [],
    requires: [],

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
  candidateTextFromEvent,
  classifyWithLaya,
  createSidecarHandle,
  loadPack,
  questionValue,
  questionsHash,
};
