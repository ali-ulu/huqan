'use strict';

/**
 * Tek yönlü eşik ayarı — fractal-learn autoTune çekirdeği.
 *
 * lib/hypothesis-tuning.js yalnızca SIKILAŞTIRMA önerir (bir kuralın red
 * oranı yüksekse eşiği daha sessiz yöne taşır); gevşetme önerisi bilinçli
 * olarak üretilmez. Bu modül o sinyali fractal-learn'ün kendi iki eşiğine
 * çevirir ve TEK YÖNLÜ uygular:
 *
 *   - sıkılaştırma sinyali varsa -> minScore yükselir, entropyFloor düşer
 *   - sinyal yoksa (ya da advice bozuksa) -> hiçbir şey değişmez (fail-closed)
 *   - gevşetme hiçbir zaman otomatik yapılmaz (insan onayı gerekir)
 *
 * Deterministik: aynı girdi -> aynı çıktı. Hiçbir yere yazmaz; yalnızca
 * yeni eşik değerlerini ve değişiklik listesini döndürür.
 */

function roundStep(value, scale) {
  return Math.round(value * scale) / scale;
}

function autoTuneThresholds(current = {}, tuningAdvice = null, opts = {}) {
  const minScoreStep = Number.isFinite(opts.minScoreStep) ? opts.minScoreStep : 0.05;
  const entropyFloorStep = Number.isFinite(opts.entropyFloorStep) ? opts.entropyFloorStep : 0.001;

  const base = {
    minScore: Number.isFinite(current.minScore) ? current.minScore : 0.6,
    entropyFloor: Number.isFinite(current.entropyFloor) ? current.entropyFloor : 0.001,
  };

  // Fail-closed: geçersiz advice hiçbir eşiği oynatmaz.
  const suggestions = (tuningAdvice && Array.isArray(tuningAdvice.suggestions))
    ? tuningAdvice.suggestions
    : [];

  if (suggestions.length === 0) {
    return { changed: false, thresholds: { ...base }, changes: [] };
  }

  const changes = [];
  const next = { ...base };

  // Tek yönlü sıkılaştırma: minScore yukarı, entropyFloor aşağı. Gevşetme yok.
  const newMinScore = Math.min(1, roundStep(base.minScore + minScoreStep, 100));
  if (newMinScore !== base.minScore) {
    changes.push({ option: 'minScore', from: base.minScore, to: newMinScore, direction: 'tighten' });
    next.minScore = newMinScore;
  }

  const newEntropyFloor = Math.max(0, roundStep(base.entropyFloor - entropyFloorStep, 1000));
  if (newEntropyFloor !== base.entropyFloor) {
    changes.push({ option: 'entropyFloor', from: base.entropyFloor, to: newEntropyFloor, direction: 'tighten' });
    next.entropyFloor = newEntropyFloor;
  }

  return { changed: changes.length > 0, thresholds: next, changes };
}

module.exports = { autoTuneThresholds };
