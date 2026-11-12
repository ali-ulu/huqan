'use strict';

// The hook context both entry paths build for one invocation: the optional AURA
// signal provider and the approval-authority verifier. It lives here, not in
// bin/huqan-gate-hook.js, because the gate daemon (lib/gate-hook-daemon.js)
// must build the exact same context per request -- a daemon that dropped
// `--aura-signals` would silently stop feeding AB14, which is a security
// difference, not a performance one.
//
// Every argument here is the *invocation's* argv, never `process.argv`: under
// the daemon the process argv belongs to the server, not to the call.

const { readCompatibleEnvironmentVariable } = require('./environment-compat');
const { writeStructuredLog } = require('./http/structured-log');

// #3843: the live AURA signal producer. AURA is an external, domain plugin, so
// core must not require it statically -- the boundary contract keeps the action
// gate in core and domain interpretation in plugins. This composition root is
// the one place that may pull the plugin in and hand its bounded signals to the
// hook path as an opt-in provider. Off by default: with no `--aura-signals`
// (or HUQAN_GATE_AURA_SIGNALS), the egress gate is exactly as before, so a
// detection-only install is unchanged.
function auraSignalProvider(argv) {
  const enabled = argv.includes('--aura-signals')
    || /^(1|true|on|yes)$/i.test(String(readCompatibleEnvironmentVariable('GATE_AURA_SIGNALS') || ''));
  if (!enabled) return {};
  try {
    const { create } = require('../plugins/aura-risk');
    const { gateSignalProviderForPlugins } = require('./gate-signal-provider');
    return { signalProvider: gateSignalProviderForPlugins({ plugins: [create()] }) };
  } catch (err) {
    // A signal source that cannot load is not evidence of safety, but it also
    // must not turn every hook call into a failure. Report and fall through to
    // the unchanged path; the operator asked for signals and did not get them.
    writeStructuredLog(console, 'error', 'gate_hook.aura_signals_unavailable', null, {
      runtime: 'gate-hook', error: err && err.message,
    });
    return {};
  }
}

function hookContextFor(argv) {
  return {
    ...auraSignalProvider(argv),
    // #3892: where an approval authority is installed, --autonomy-activation
    // names its consumed decision; this is what reads it back.
    verifyAutonomyActivation: (input) => require('./authority/autonomy-activation').verifyAutonomyActivation(input),
  };
}

module.exports = { hookContextFor };
