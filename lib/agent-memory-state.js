'use strict';

const path = require('path');

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeGoal(goal) {
  return String(goal || '').trim();
}

function lower(goal) {
  return normalizeGoal(goal).toLowerCase();
}

function firstWords(text, count = 3) {
  return normalizeGoal(text)
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, count)
    .join(' ');
}

function stripQuestionMarks(text) {
  return String(text || '').replace(/[؟?]+/g, '').trim();
}

function normalizeSummaryText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeMemoryPath(opts = {}, kernel) {
  if (Object.prototype.hasOwnProperty.call(opts || {}, 'memoryPath')) {
    return opts.memoryPath;
  }
  const kernelMemoryPath = kernel?.graph?.memoryPath;
  if (typeof kernelMemoryPath === 'string' && kernelMemoryPath.endsWith('.json')) {
    return kernelMemoryPath.replace(/\.json$/, '.agent.json');
  }
  return path.join(process.cwd(), 'agent.memory.json');
}

function defaultMemoryState() {
  return {
    version: 1,
    updatedAt: null,
    plans: [],
    runs: [],
    goals: [],
    failures: [],
    stats: {
      tools: {},
      objectives: {},
    },
  };
}

module.exports = {
  cloneValue,
  nowIso,
  normalizeGoal,
  lower,
  firstWords,
  stripQuestionMarks,
  normalizeSummaryText,
  normalizeMemoryPath,
  defaultMemoryState,
};
