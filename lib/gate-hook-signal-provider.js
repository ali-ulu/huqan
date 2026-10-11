'use strict';

// The live AURA signal producer for the hook CLI (egress seam, step B #3843).
//
// Step A (#3842) made lib/external-action-guard.js read `options.signalProvider`
// and forward the provider's named signals as `auraSignalIds` to the egress
// gate, but nothing in production ever set it, so the seam stayed inert. This
// module is the producer: it builds a gate-signal provider from the loaded
// `aura-risk` plugin and hands it to the guard through the hook CLI.
//
// Fail-closed, and the one rule that matters: no AURA pack -> no provider. The
// pack is an external artifact (lib/aura-signal-pack.js), absent from an
// installed package, so an install without AURA passes nothing and the egress
// gates behave exactly as before. The provider only reports a bounded signal;
// core trust mechanics still decide (docs/core-plugin-boundary-contract.md).

const { gateSignalProviderForKernel } = require('./gate-signal-provider');
const { loadSignalPack } = require('./aura-signal-pack');
const auraRisk = require('../plugins/aura-risk');

/**
 * Build the signal provider for one hook evaluation, or `null` when the AURA
 * pack is absent. `null` is the fail-closed default: the caller passes no
 * provider, nothing is planted, and no egress gate changes behaviour.
 */
function auraSignalProviderForHook(options = {}) {
  const pack = loadSignalPack(options.packPath ? { packPath: options.packPath } : {});
  if (!pack.signalIds.length) return null;
  const kernel = { plugins: { plugins: [auraRisk] } };
  return gateSignalProviderForKernel(kernel, { workspaceId: options.workspaceId || 'default' });
}

module.exports = { auraSignalProviderForHook };
