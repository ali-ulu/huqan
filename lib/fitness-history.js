'use strict';

/**
 * Fitness geçmişi deposu — `huqan fitness` skorlarını zaman damgasıyla
 * kalıcı bir JSONL dosyasına ekler ve okur.
 *
 * Bu modül, görsel dashboard'un (fitness zaman serisi) veri kaynağıdır.
 * buildFitnessReport read-only kaldığı için kayıt burada ayrı bir adımdır:
 * raporu üreten komut isterse kaydeder, kendiliğinden hiçbir yere yazmaz.
 */

const fs = require('node:fs');
const { siblingPersistencePath } = require('./memory-store-utils');

const HISTORY_SUFFIX = '.fitness-history.jsonl';

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

/** Bellek dosyasının yanında duran geçmiş dosyasının yolu. */
function fitnessHistoryPath(kernel) {
  const memoryPath = kernel && kernel.graph && kernel.graph.memoryPath;
  if (typeof memoryPath !== 'string' || !memoryPath.trim()) {
    const error = new Error('The graph has no memory path to hang a fitness history off.');
    error.code = 'FITNESS_HISTORY_NO_STORE';
    throw error;
  }
  return siblingPersistencePath(memoryPath, HISTORY_SUFFIX);
}

/**
 * Bir fitness raporunu geçmişe ekler (JSONL, tek satır).
 * Fail-closed: yazma hatası sessizce yutulmaz, yukarı fırlar.
 */
function recordFitnessEntry(historyPath, report) {
  const entry = {
    type: 'fitness',
    ts: new Date().toISOString(),
    workspaceId: normalizeWorkspaceId(report && report.meta && report.meta.workspaceId),
    score: report && typeof report.score === 'number' ? report.score : null,
    grade: report && report.grade ? report.grade : null,
    components: Array.isArray(report && report.components)
      ? report.components.map((c) => ({ name: c.name, value: c.value }))
      : [],
    meta: report && report.meta ? report.meta : {},
  };
  fs.appendFileSync(historyPath, `${JSON.stringify(entry)}\n`, 'utf8');
  return entry;
}

/** Geçmişi okur; en yeni kayıtlar sonda. Bozuk satırlar atlanır. */
function readFitnessHistory(historyPath, limit = 200) {
  if (!fs.existsSync(historyPath)) return [];
  const raw = fs.readFileSync(historyPath, 'utf8');
  const entries = raw
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try { return JSON.parse(line); } catch (_e) { return null; }
    })
    .filter(Boolean);
  const n = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 200;
  return entries.slice(-n);
}

module.exports = {
  HISTORY_SUFFIX,
  fitnessHistoryPath,
  recordFitnessEntry,
  readFitnessHistory,
};
