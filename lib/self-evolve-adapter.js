'use strict';

/**
 * self-evolve-adapter — runSelfEvolve'u (lib/kernel-self-evolve) fractal-learn
 * L4 döngüsüne (lib/fractal-learn) bağlayan tek-sorumluluk modülü.
 *
 * FractalLearn.run() kendi çok-turlu döngüsünü koşar ve `data.rounds` +
 * `data.totals` döndürür (doğrudan `hypotheses` ALANI YOKTUR). Bu adapter onu
 * bir kez çağırır, ardından self-evolve'u probeSelfEvolve ile ölçerek çalıştırır
 * ve iki sonucu tek zarfta birleştirir.
 */

const { FractalLearn, clamp01, boundedInteger } = require('./fractal-learn');
const { probeSelfEvolve } = require('./self-evolve-probe');
const { buildSelfEvolveCollaborators, runSelfEvolve } = require('./kernel-self-evolve');
const Dream = require('../dream');

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
 * @param {object} kernel — FractalLearn'e uygun kernel (dream + entropy + graph)
 * @param {{workspaceId?: string, maxRounds?: number, depth?: number, entropyFloor?: number, minScore?: number, autoTune?: boolean, fractalLearn?: FractalLearn, readConfig?: Function}} opts
 * @returns {{ok: boolean, type: string, data: object}}
 */
function runSelfEvolveAdapter(kernel, opts = {}) {
  const validated = buildAdapterKernel(kernel);
  const workspaceId = normalizeWorkspaceId(opts.workspaceId);

  // DI: kullanıcının FractalLearn örneği varsa o kullanılır.
  const fl = (opts.fractalLearn instanceof FractalLearn) ? opts.fractalLearn : new FractalLearn(validated);

  const maxRounds = boundedInteger(opts.maxRounds, 5, 1, 20);
  const depth = boundedInteger(opts.depth, 2, 1, 5);
  const entropyFloor = Number.isFinite(opts.entropyFloor) ? clamp01(Math.abs(opts.entropyFloor)) : 0.001;
  const minScore = clamp01(typeof opts.minScore === 'number' ? opts.minScore : 0.6);
  const autoTune = opts.autoTune === true;

  // 1) Fractal-learn döngüsü: tek çağrı, kendi iç çok-turlu döngüsünü koşar.
  const flResult = fl.run({ maxRounds, depth, minScore, entropyFloor, autoTune, workspaceId });
  const flData = (flResult && flResult.data) ? flResult.data : {};

  // 2) Self-evolve: probeSelfEvolve invoke() çağrısını ölçer (öncesi/sonrası
  //    snapshot → verdict: WRITES_CONFIG / CONTENT_ONLY / INACTIVE).
  const collaborators = buildSelfEvolveCollaborators(validated, Dream, workspaceId);
  const probeResult = probeSelfEvolve(validated, {
    workspaceId,
    invoke: () => runSelfEvolve({ workspaceId, minConfidence: 0.25 }, collaborators),
    readConfig: typeof opts.readConfig === 'function' ? opts.readConfig : undefined,
  });

  return {
    ok: true,
    type: 'fractal_learn_with_self_evolve',
    data: {
      workspaceId,
      fractalLearn: flData,
      selfEvolve: {
        verdict: probeResult.verdict,
        measurement: probeResult.measurement,
      },
      params: { maxRounds, depth, entropyFloor, minScore, autoTune },
    },
  };
}

module.exports = { runSelfEvolveAdapter, normalizeWorkspaceId, buildAdapterKernel };
