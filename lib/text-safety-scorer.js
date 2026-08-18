"use strict";
// Functional extraction from kernel.v2.js (#328, docs/kernel-split-plan.md V2-C):
// the text-manipulation safety-scoring family becomes a pure, independently
// testable module. No behaviour change -- the same rules, the same weights,
// the same shape. Exported names match the former private method semantics.
const {
  MANIPULATION_RULES,
  normalizeManipulationText,
  parseSimpleTurkishStatement,
} = require('./kernel-v2-native');

const DEFAULT_BLOCK_THRESHOLD = 0.7;
const DEFAULT_DOWNGRADE_THRESHOLD = 0.35;

function stripManipulationPrefix(fragment) {
  return String(fragment || '')
    .replace(/^(?:lütfen|please|hemen|acilen|derhal|şimdi|bir an önce|önceki talimatları yok say|sistem mesajını yok say|sistem talimatlarını yok say|ignore(?:\s+all)?(?:\s+previous)?(?:\s+instructions?)?|system prompt(?:unu)?(?:\s+yok say)?|role:\s*system|developer message|gizli komut|talimatları atla|sadece bunu yap|tek yapman gereken)\b[\s,:;\-]*/i, '')
    .trim();
}

function splitManipulationFragments(text) {
  return normalizeManipulationText(text)
    .split(/(?:[.!?\n]+|[,;]+|\bve\b|\bama\b|\bfakat\b|\bancak\b|\bçünkü\b|\bzira\b)/i)
    .map(stripManipulationPrefix)
    .filter(Boolean);
}

function extractVerificationStatement(text) {
  const raw = normalizeManipulationText(text);
  if (!raw) return null;
  const direct = parseSimpleTurkishStatement(raw);
  if (direct) {
    const cue = MANIPULATION_RULES.some(rule => rule.regex.test(raw));
    if (!cue) return raw;
  }
  for (const fragment of splitManipulationFragments(raw)) {
    if (!fragment) continue;
    if (MANIPULATION_RULES.some(rule => rule.regex.test(fragment))) continue;
    if (parseSimpleTurkishStatement(fragment)) return fragment;
  }
  return direct ? raw : null;
}

// analyseManipulation is intentionally spelled without the "analyze" variant --
// it mirrors the legacy KernelV2 private method name so callers stay stable.
function analyseManipulation(text) {
  const raw = normalizeManipulationText(text);
  const lower = raw.toLowerCase();
  const labels = [];
  const reasons = [];
  let score = 0;
  const addHit = (label, reason, weight) => {
    if (!labels.includes(label)) labels.push(label);
    if (!reasons.includes(reason)) reasons.push(reason);
    score += weight;
  };
  for (const rule of MANIPULATION_RULES) {
    if (rule.regex.test(lower)) addHit(rule.label, rule.reason, rule.weight);
  }
  const extractedStatement = extractVerificationStatement(raw);
  if (labels.length > 0 && extractedStatement && extractedStatement !== raw) {
    addHit('mixed_intent', 'The text contains both a manipulative instruction and content to verify.', 0.18);
  }
  if (/[:;,-]\s*(?:ignore|önceki|sistem|talimat|prompt|komut|instruction)/i.test(lower)) {
    addHit('hidden_instruction', 'The text hides an instruction behind delimiters.', 0.2);
  }
  score = Math.max(0, Math.min(1, score));
  return {
    manipulation: labels.length > 0,
    labels,
    reasons,
    score: Number(score.toFixed(2)),
    blocked: score >= DEFAULT_BLOCK_THRESHOLD,
    downgraded: score > 0 && score < DEFAULT_BLOCK_THRESHOLD,
    extractedStatement,
    source: raw,
  };
}

// Attaches the manipulation risk object to an existing kernel result envelope
// exactly as KernelV2._withManipulationRisk did. Pure -- works on any plain
// object with { data, meta }.
function withManipulationRisk(result, risk) {
  if (!risk || !risk.manipulation) return result;
  const data = result && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
    ? { ...result.data, risk }
    : result.data;
  return {
    ...result,
    data,
    meta: {
      ...(result && result.meta ? result.meta : {}),
      manipulationScore: risk.score,
      manipulationLabels: risk.labels,
    },
  };
}

module.exports = {
  DEFAULT_BLOCK_THRESHOLD,
  DEFAULT_DOWNGRADE_THRESHOLD,
  stripManipulationPrefix,
  splitManipulationFragments,
  extractVerificationStatement,
  analyseManipulation,
  withManipulationRisk,
};
