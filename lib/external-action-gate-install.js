'use strict';
// The gate installer's entry points: install, uninstall and status for one
// agent profile, runtime re-validation, and connect-everything-detected.
// The mechanics live in external-action-gate-install-*.js (#2145).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');
const { customAgentGateStatus } = require('./external-action-custom-agent-status');
const { detectAgents } = require('./external-action-agent-detection');
const { PROFILES, GENERIC_PROFILE, fail, profileSpec } = require('./external-action-gate-install-spec');
const { installJsonHook, uninstallJsonHook } = require('./external-action-gate-install-hooks');
const {
  installFile, uninstallFile, installDirectory, uninstallDirectory, installed,
} = require('./external-action-gate-install-files');
const { pickGateCommand } = require('./external-action-gate-install-command');
const { assertDependencyResolvable, selfValidate } = require('./external-action-gate-install-validate');
const { hostTrust, lastReceipt } = require('./external-action-gate-install-host-trust');
/**
 * Runtime re-evaluation of an installed gate artifact (#1890).
 *
 * `selfValidate` above runs once at install; a permission granted then
 * silently survives every later edit of the artifact. This is the hook for
 * per-call or periodic re-validation: it reads whatever is installed *now*
 * and drives it through the same sentinel contract, without writing
 * anything. Returns `{ live: true, ... }` on success and a fail-closed
 * `{ live: false, error }` result (rather than throwing) so a periodic
 * checker can report instead of crash.
 */
function revalidateGateArtifact(profile, root, options = {}) {
  const resolvedRoot = path.resolve(root || options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const spec = profileSpec(profile, resolvedRoot, home);
  if (!installed(spec, profile)) {
    return { profile, target: spec.target, installed: false, live: false, reason: 'gate_not_installed' };
  }
  try {
    const sentinel = selfValidate(profile, resolvedRoot, spec);
    return { profile, target: spec.target, installed: true, ...sentinel };
  } catch (error) {
    return {
      profile,
      target: spec.target,
      installed: true,
      live: false,
      reason: 'revalidation_failed',
      error: String((error && error.message) || error),
    };
  }
}

/**
 * Detect every agent on this machine and connect the gate to each one (#2050).
 *
 * One command, no profile name, no question about hooks. Each detected agent
 * goes through the same install that proves itself with a live sentinel, so a
 * `connected` verdict here means what it means there: a known destructive
 * action was actually blocked through that agent's own contract. An agent
 * whose install refuses is reported with the refusal, never skipped quietly --
 * a connect run that hid a failure would be the fake green this whole surface
 * exists to avoid.
 */
function connectDetectedAgents(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const detections = detectAgents({ root, home, environment: options.environment });
  const agents = detections.map((detection) => {
    if (!detection.detected) return { ...detection, state: 'not-detected' };
    if (options.detectOnly === true) return { ...detection, state: 'detected' };
    try {
      const result = manageGate('install', {
        ...options, root, home, profile: detection.profile, deploymentAuthorized: true,
      });
      return { ...detection, state: 'connected', target: result.target, sentinel: result.sentinel };
    } catch (error) {
      return { ...detection, state: 'refused', reason: String(error && error.message ? error.message : error) };
    }
  });

  return {
    command: 'connect',
    root,
    agents,
    connected: agents.filter(agent => agent.state === 'connected').length,
    refused: agents.filter(agent => agent.state === 'refused').length,
    // No detected agent is not an error: the user may be running their own.
    // That path is observable rather than installable (#2048).
    customAgent: {
      profile: GENERIC_PROFILE,
      how: 'send the huqan.external-action.v1 envelope to `huqan-gate --profile generic` from the agent pre-tool hook',
      verify: 'huqan-gate status --profile generic',
    },
  };
}

function manageGate(command, options = {}) {
  if (!options.deploymentAuthorized) fail('gate management requires deployment authority');
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const profiles = options.profile ? [options.profile] : PROFILES;
  if (command === 'status') {
    const receiptPath = options.receiptPath || defaultExternalActionReceiptPath();
    // A custom agent cannot be inspected, only observed, so it is reported
    // beside the artifact-backed clients rather than among them (#2048).
    const custom = (!options.profile || options.profile === GENERIC_PROFILE)
      ? customAgentGateStatus(receiptPath, { knownProfiles: PROFILES, agentName: options.agentName })
      : null;
    if (options.profile === GENERIC_PROFILE) return { command, clients: [], custom, lastReceipt: lastReceipt(receiptPath) };
    return {
      command,
      ...(custom ? { custom } : {}),
      clients: profiles.map(profile => {
        const spec = profileSpec(profile, root, home);
        const client = { profile, installed: installed(spec, profile), target: spec.target, hostTrust: hostTrust(profile, root, spec, false) };
        // Opt-in runtime re-evaluation (#1890): status stays cheap by
        // default, and only drives the live sentinel when asked.
        if (options.revalidate === true) client.revalidation = revalidateGateArtifact(profile, root, { home });
        return client;
      }),
      lastReceipt: lastReceipt(receiptPath),
    };
  }
  if (profiles.length !== 1) fail(`${command} requires --profile`);
  if (profiles[0] === GENERIC_PROFILE) {
    // Refuse, but say what the custom-agent path actually is instead of
    // reporting the profile as unknown -- the adapter does understand it.
    fail(`profile ${GENERIC_PROFILE} has no artifact to ${command}: a custom agent connects by sending the `
      + 'huqan.external-action.v1 envelope to `huqan-gate --profile generic` from its own pre-tool hook. '
      + 'Use `huqan-gate status --profile generic` to see whether those envelopes are arriving.');
  }
  const profile = profiles[0];
  const spec = profileSpec(profile, root, home);
  if (command === 'install') {
    assertDependencyResolvable(spec, root);
    // An artifact has to exist before it can be loaded, so validation happens
    // after the write -- and a write this call made is undone when validation
    // fails, so a refused install still leaves nothing behind. An artifact that
    // was already there is left alone: removing someone else's working gate
    // because our sentinel was unhappy would be the worse failure.
    const preexisting = installed(spec, profile);
    if (spec.kind === 'json-hook') installJsonHook(spec, profile, pickGateCommand(profile, root));
    else if (spec.kind === 'file') installFile(spec);
    else installDirectory(spec, pickGateCommand(profile, root));
    let sentinel;
    try {
      sentinel = selfValidate(profile, root, spec);
    } catch (error) {
      if (!preexisting && spec.kind === 'file') fs.rmSync(spec.target, { force: true });
      if (!preexisting && spec.kind === 'json-hook') uninstallJsonHook(spec, profile);
      if (!preexisting && spec.kind === 'directory') uninstallDirectory(spec);
      throw error;
    }
    return { command, profile, target: spec.target, installed: true, sentinel, hostTrust: hostTrust(profile, root, spec, !preexisting) };
  }
  if (command === 'uninstall') {
    const removed = spec.kind === 'json-hook' ? uninstallJsonHook(spec, profile) : spec.kind === 'file' ? uninstallFile(spec) : uninstallDirectory(spec);
    return { command, profile, target: spec.target, removed };
  }
  fail(`unsupported gate command: ${command}`);
}

module.exports = Object.freeze({ PROFILES, manageGate, revalidateGateArtifact, connectDetectedAgents });
