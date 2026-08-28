'use strict';

// HUQAN fractal-learn — çok-turlu özyinelemeli bilgi sentezi.
//
// kernel.dream({ learnFromDream: true }) zaten TEK tur "hipotez üret + admission
// gate'ten geçirip bağla" işini yapıyor (bkz. lib/kernel-dream.js). Bu modül onu
// TURLARA bağlar ve entropi ile doygunlukta durdurur:
//
//   for round in 1..maxRounds:
//     before = kernel.entropy(ws)
//     result = kernel.dream({ depth, workspaceId, learnFromDream: true, dreamLearnThreshold: minScore })
//     after  = kernel.entropy(ws)
//     delta  = |after - before|
//     eğer üretilen hipotez yoksa            -> exhausted (üretecek bilgi kalmadı)
//     eğer delta < entropyFloor              -> saturated (yeni bilgi kazancı tükendi)
//
// Her turun özeti ve toplamlar döner; grafe her yazım admission + audit üzerinden
// makbuzlanır (sinir ağı değil, kara kutu yok).

function clamp01(value) {
  if (!Number.isFinite(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function boundedInteger(value, fallback, min, max) {
  const n = Number.isFinite(value) ? Math.trunc(value) : fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

class FractalLearn {
  constructor(kernel) {
    if (!kernel
      || typeof kernel.dream !== 'function'
      || typeof kernel.entropy !== 'function') {
      const error = new Error('FractalLearn requires a kernel with dream() and entropy()');
      error.code = 'FRACTAL_LEARN_INVALID_KERNEL';
      throw error;
    }
    this.kernel = kernel;
  }

  run(opts = {}) {
    const maxRounds = boundedInteger(opts.maxRounds, 5, 1, 20);
    const depth = boundedInteger(opts.depth, 2, 1, 5);
    const entropyFloor = Number.isFinite(opts.entropyFloor) ? clamp01(Math.abs(opts.entropyFloor)) : 0.001;
    const minScore = clamp01(typeof opts.minScore === 'number' ? opts.minScore : 0.6);
    const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : 'default';

    const rounds = [];
    let stopReason = null;
    let totalGenerated = 0;
    let totalLearned = 0;
    let totalPending = 0;

    for (let round = 1; round <= maxRounds; round += 1) {
      const entropyBefore = this._entropy(workspaceId);
      const result = this.kernel.dream({
        depth,
        workspaceId,
        learnFromDream: true,
        dreamLearnThreshold: minScore,
      });
      const data = (result && result.data) ? result.data : {};
      const hypotheses = Array.isArray(data.hypotheses) ? data.hypotheses : [];
      const learned = Array.isArray(data.learned) ? data.learned : [];
      const pending = Array.isArray(data.pending) ? data.pending : [];
      const entropyAfter = this._entropy(workspaceId);
      const deltaEntropy = Math.abs(entropyAfter - entropyBefore);

      rounds.push({
        round,
        generated: hypotheses.length,
        learned: learned.length,
        pending: pending.length,
        entropyBefore,
        entropyAfter,
        deltaEntropy,
        cycle: data.cycle !== undefined ? data.cycle : null,
      });

      totalGenerated += hypotheses.length;
      totalLearned += learned.length;
      totalPending += pending.length;

      if (hypotheses.length === 0) {
        stopReason = 'exhausted';
        break;
      }
      if (deltaEntropy < entropyFloor) {
        stopReason = 'saturated';
        break;
      }
    }
    if (!stopReason) stopReason = 'maxRounds';

    return {
      ok: true,
      type: 'fractal_learn',
      data: {
        rounds,
        totals: {
          generated: totalGenerated,
          learned: totalLearned,
          pending: totalPending,
        },
        stopReason,
        workspaceId,
        params: { maxRounds, depth, entropyFloor, minScore },
      },
    };
  }

  _entropy(workspaceId) {
    try {
      const value = this.kernel.entropy(workspaceId);
      const n = Number(value);
      return Number.isFinite(n) ? n : 0;
    } catch (_e) {
      return 0;
    }
  }
}

module.exports = { FractalLearn, clamp01, boundedInteger };
