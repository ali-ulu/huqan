'use strict';

/*
 * self-evolve-adapter — L4 fractal-learn döngüsüne runSelfEvolve (lib/self-evolve-probe)
 * entegre eden tek-sorumluluk modülü. Modüler, teknik borç yok.
 *
 * Kural: mevcut lib/fractal-learn.js\'e dokunmadan, onun FractalLearn sınıfını
 * sarıp her turdan sonra probe (runSelfEvolve) çağrısı yapar. Ayrıca
 * lib/kernel-self-evolve içindeki gerçek runSelfEvolve\'ı, kendi
 * collaboration nesneleriyle, adapter üzerinden çalıştırabilir.
 */

const { FractalLearn, clamp01, boundedInteger } = require('./fractal-learn');
const { probeSelfEvolve } = require('./self-evolve-probe');
const { buildSelfEvolveCollaborators, runSelfEvolve } = require('./kernel-self-evolve');

function normalizeWorkspaceId(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : 'default';
}

function buildAdapterKernel(kernel) {
  if (!kernel || typeof kernel.dream !== 'function' || typeof kernel.entropy !== 'function') {
    const err = new Error('self-evolve-adapter requires a kernel with dream() and entropy()');
    err.code = 'SELF_EVOLVE_ADAPTER_INVALID_KERNEL';
    throw err;
  }
  return kernel;
}

/**
 * @param {object} kernel — FractalLearn\'e uygun kernel (dream + entropy)
 * @param {{workspaceId?: string, maxRounds?: number, depth?: number, entropyFloor?: number, minScore?: number, autoTune?: boolean, fractalLearn?: FractalLearn, readConfig?: Function, invoke?: Function}} opts
 * @returns {{ok: boolean, type: string, data: object}}
 */
function runSelfEvolveAdapter(kernel, opts = {}) {
  const validated = buildAdapterKernel(kernel);
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);

  // DI: kullanıcının kendi FractalLearn örneği varsa onu kullan, yoksa yenisini oluştur.
  const fl = (opts.fractalLearn instanceof FractalLearn) ? opts.fractalLearn
    : (opts.fractalLearn || new FractalLearn(validated));

  const maxRounds = boundedInteger(opts.maxRounds, 5, 1, 20);
  const depth = boundedInteger(opts.depth, 2, 1, 5);
  const entropyFloor0 = Number.isFinite(opts.entropyFloor) ? clamp01(Math.abs(opts.entropyFloor)) : 0.001;
  const minScore0 = clamp01(typeof opts.minScore === 'number' ? opts.minScore : 0.6);
  const autoTune = opts.autoTune === true;

  const rounds = [];
  const selfEvolveResults = [];
  const thresholdChanges = [];
  let stopReason = null;
  let totalGenerated = 0;
  let totalLearned = 0;
  let totalPending = 0;

  let minScore = minScore0;
  let entropyFloor = entropyFloor0;

  for (let round = 1; round <= maxRounds; round += 1) {
    const entropyBefore = fl._entropy ? fl._entropy(workspaceId) : 0;

    // L4 fractal-learn turu: dream + admission gate
    const result = fl.run({
      maxRounds: 1,
      depth,
      entropyFloor: entropyFloor,
      minScore: minScore,
      autoTune: false,
      workspaceId,
    });

    const data = (result && result.data) ? result.data : {};
    const hypotheses = Array.isArray(data.hypotheses) ? data.hypotheses : [];
    const learned = Array.isArray(data.learned) ? data.learned : [];
    const pending = Array.isArray(data.pending) ? data.pending : [];

    const entropyAfter = fl._entropy ? fl._entropy(workspaceId) : 0;
    const deltaEntropy = Math.abs(entropyAfter - entropyBefore);

    // Her turdan sonra runSelfEvolve (probe.invoke ile) çağrılır.
    // Adapter, kendi collaboration nesnelerini kernel\'den alıp probe\'a iletir.
    const probeResult = probeSelfEvolve(validated, {
      workspaceId,
      invoke: () => {
        // Gerçek self-evolve çağrısı — kernel\'in collaboration\'ları kullanılarak
        const collaborators = buildSelfEvolveCollaborators(
          validated,
          require('./kernel-dream').Dream || (() => ({ dream: () => ({}) })),
          workspaceId,
        );
        return runSelfEvolve({ workspaceId, minConfidence: 0.25 }, collaborators);
      },
      readConfig: typeof opts.readConfig === 'function' ? opts.readConfig : () => ({ confidenceFloor: 0.3, criticalInDegree: 1, smallComponentSize: 1 }),
    });

    selfEvolveResults.push({
      round,
      verdict: probeResult.verdict,
      symbols: probeResult.symbols,
      measurement: probeResult.measurement,
    });

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
    type: 'fractal_learn_with_self_evolve',
    data: {
      workspaceId,
      rounds,
      totals: { generated: totalGenerated, learned: totalLearned, pending: totalPending },
      thresholdChanges,
      stopReason,
      fractalLearn: fl,
      selfEvolveResults,
      params: { maxRounds, depth, entropyFloor: entropyFloor0, minScore: minScore0, autoTune },
    },
  };
}

module.exports = { runSelfEvolveAdapter, normalizeWorkspaceId, buildAdapterKernel };
