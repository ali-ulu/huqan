'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { evaluateHookInvocation } = require('./external-action-adapter');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');

const PROFILES = Object.freeze(['claude-code', 'codex', 'opencode', 'pi', 'hermes']);
const ADAPTER_ROOT = path.resolve(__dirname, '..', 'adapters', 'external-action');
const SENTINEL_RUNNER = path.resolve(__dirname, 'external-action-gate-sentinel.js');
const SENTINEL_TIMEOUT_MS = 30000;

function fail(message) { throw new Error(message); }
function plain(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function readJson(target) {
  if (!fs.existsSync(target)) return {};
  let value;
  try { value = JSON.parse(fs.readFileSync(target, 'utf8')); } catch (_) { fail(`invalid JSON config: ${target}`); }
  if (!plain(value)) fail(`config root must be an object: ${target}`);
  return value;
}
function writeJson(target, value) {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
function template(name) { return fs.readFileSync(path.join(ADAPTER_ROOT, name), 'utf8'); }
function jsonTemplate(name) { return JSON.parse(template(name)); }
function same(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

function profileSpec(profile, root, home) {
  if (!PROFILES.includes(profile)) fail(`unsupported profile: ${profile}`);
  if (profile === 'claude-code') return { kind: 'json-hook', target: path.join(root, '.claude', 'settings.json'), source: 'claude-code-hooks.json' };
  if (profile === 'codex') return { kind: 'json-hook', target: path.join(root, '.codex', 'hooks.json'), source: 'codex-hooks.json' };
  if (profile === 'opencode') return { kind: 'file', target: path.join(root, '.opencode', 'plugin', 'huqan.mjs'), source: 'opencode-plugin.mjs' };
  if (profile === 'pi') return { kind: 'file', target: path.join(root, '.pi', 'extensions', 'huqan.js'), source: 'pi-extension.js' };
  return { kind: 'directory', target: path.join(home, '.hermes', 'plugins', 'huqan-external-action-guard'), source: 'hermes' };
}

function hookEntry(profile) {
  return jsonTemplate(profile === 'claude-code' ? 'claude-code-hooks.json' : 'codex-hooks.json').hooks.PreToolUse[0];
}
function validateHookConfig(config, target) {
  if (config.hooks !== undefined && !plain(config.hooks)) fail(`hooks must be an object: ${target}`);
  if (config.hooks?.PreToolUse !== undefined && !Array.isArray(config.hooks.PreToolUse)) fail(`hooks.PreToolUse must be an array: ${target}`);
}
function ownsHook(entry, profile) {
  return same(entry, hookEntry(profile));
}
function mentionsHuqanHook(entry, profile) {
  return plain(entry) && Array.isArray(entry.hooks) && entry.hooks.some(hook => plain(hook)
    && [hook.command, hook.commandWindows].some(command => typeof command === 'string'
      && command.includes(`huqan-gate${command.includes('.cmd') ? '.cmd' : ''} --profile ${profile}`)));
}
function installJsonHook(spec, profile) {
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  const current = config.hooks?.PreToolUse || [];
  if (!current.some(entry => ownsHook(entry, profile))) {
    if (current.some(entry => mentionsHuqanHook(entry, profile))) fail(`refusing to overwrite modified HUQAN hook: ${spec.target}`);
    current.push(hookEntry(profile));
  }
  config.hooks = { ...(config.hooks || {}), PreToolUse: current };
  writeJson(spec.target, config);
}
function uninstallJsonHook(spec, profile) {
  if (!fs.existsSync(spec.target)) return false;
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  const before = config.hooks?.PreToolUse || [];
  if (before.some(entry => mentionsHuqanHook(entry, profile) && !ownsHook(entry, profile))) {
    fail(`refusing to remove modified HUQAN hook: ${spec.target}`);
  }
  const after = before.filter(entry => !ownsHook(entry, profile));
  if (after.length === before.length) return false;
  config.hooks = { ...(config.hooks || {}), PreToolUse: after };
  writeJson(spec.target, config);
  return true;
}
function installFile(spec) {
  const content = template(spec.source);
  if (fs.existsSync(spec.target) && fs.readFileSync(spec.target, 'utf8') !== content) fail(`refusing to overwrite non-HUQAN file: ${spec.target}`);
  fs.mkdirSync(path.dirname(spec.target), { recursive: true });
  fs.writeFileSync(spec.target, content, 'utf8');
}
function uninstallFile(spec) {
  if (!fs.existsSync(spec.target)) return false;
  if (fs.readFileSync(spec.target, 'utf8') !== template(spec.source)) fail(`refusing to remove modified file: ${spec.target}`);
  fs.unlinkSync(spec.target);
  return true;
}
function installDirectory(spec) {
  if (fs.existsSync(spec.target)) {
    for (const source of fs.readdirSync(path.join(ADAPTER_ROOT, spec.source))) {
      const target = path.join(spec.target, source);
      if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') !== template(path.join(spec.source, source))) {
        fail(`refusing to overwrite modified file: ${target}`);
      }
    }
  }
  fs.mkdirSync(spec.target, { recursive: true });
  for (const source of fs.readdirSync(path.join(ADAPTER_ROOT, spec.source))) {
    fs.writeFileSync(path.join(spec.target, source), template(path.join(spec.source, source)), 'utf8');
  }
}
function uninstallDirectory(spec) {
  if (!fs.existsSync(spec.target)) return false;
  const expected = fs.readdirSync(path.join(ADAPTER_ROOT, spec.source)).sort();
  const actual = fs.readdirSync(spec.target).sort();
  if (!same(actual, expected) || actual.some(name => fs.readFileSync(path.join(spec.target, name), 'utf8') !== template(path.join(spec.source, name)))) {
    fail(`refusing to remove modified directory: ${spec.target}`);
  }
  fs.rmSync(spec.target, { recursive: true });
  return true;
}

function sentinelPayload(profile, root) {
  const base = { session_id: 'huqan-install-sentinel', tool_use_id: 'huqan-install-sentinel', tool_name: 'Bash', tool_input: { command: 'rm -rf /' }, cwd: root };
  if (profile === 'opencode') return { sessionID: base.session_id, callID: base.tool_use_id, tool: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  // Pi nests the call under `event` and names the fields in camelCase (see
  // normalizeHookInvocation). The flat snake_case payload this used to send
  // normalized to `toolName: undefined`, so the sentinel blocked -- but as
  // `malformed_external_action_blocked`, proving the malformed-input path
  // rather than the denylist it was written to prove.
  if (profile === 'pi') {
    return { event: { toolCallId: base.tool_use_id, toolName: 'bash', input: { command: 'rm -rf /' } }, sessionId: base.session_id, cwd: root };
  }
  if (profile === 'hermes') return { session_id: base.session_id, tool_call_id: base.tool_use_id, tool_name: 'bash', args: { command: 'rm -rf /' }, cwd: root };
  return base;
}
/**
 * The artifacts installed for `file` profiles import the `huqan` package by
 * bare specifier. A bare specifier resolves from the *installed file's*
 * directory, not from this process, and a global npm install is invisible to
 * it -- so an install can look perfect and still leave a plugin that dies with
 * ERR_MODULE_NOT_FOUND the first time the host loads it (#1792).
 *
 * Checked before anything is written, so a refused install leaves no trace.
 */
function assertDependencyResolvable(spec, root) {
  if (spec.kind !== 'file') return;
  try {
    require.resolve('huqan', { paths: [path.dirname(spec.target), root] });
  } catch (_) {
    fail(`huqan is not resolvable from ${root}: the installed plugin imports it by name, `
      + 'so install the package there (npm install huqan) before installing the gate. '
      + 'A global npm install does not satisfy a bare import.');
  }
}

/**
 * Load the artifact that was just written and drive it through its host's
 * contract, in a child process anchored at the artifact's own directory so the
 * bare `huqan` import resolves exactly as it will for the host.
 *
 * Receipts are redirected to a throwaway file: the sentinel is a synthetic
 * `rm -rf /`, and a deployment's evidence trail should not open with a block
 * that never happened. The redirect doubles as proof -- a guard that blocks
 * without leaving a receipt has lost the half of the product that matters
 * (#1794), and here that shows up as an install failure rather than silence.
 */
function exerciseArtifact(spec, profile, payload, root) {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-sentinel-'));
  const receiptPath = path.join(scratch, 'receipts.jsonl');
  try {
    const run = spawnSync(process.execPath, [SENTINEL_RUNNER, profile, spec.target, root], {
      input: JSON.stringify(payload),
      cwd: root,
      encoding: 'utf8',
      timeout: SENTINEL_TIMEOUT_MS,
      env: { ...process.env, HUQAN_EXTERNAL_GUARD_RECEIPTS: receiptPath },
    });
    if (run.error) fail(`could not run the installed artifact: ${run.error.message}`);
    let outcome;
    try { outcome = JSON.parse(run.stdout || '{}'); } catch (_) { outcome = {}; }
    if (outcome.error) fail(`installed artifact is not loadable: ${outcome.error}`);
    if (!outcome.decision) fail(`installed artifact returned no decision: ${(run.stderr || run.stdout || '').trim()}`);
    return { ...outcome, receiptWritten: fs.existsSync(receiptPath) && fs.readFileSync(receiptPath, 'utf8').trim() !== '' };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * `file` profiles are validated through the artifact itself, so `live: true`
 * means the installed plugin blocked the sentinel under its host's contract.
 * The other profiles reach their guard by spawning `huqan-gate`, which this
 * still does not execute -- they keep `via: 'evaluator'`, which claims only
 * what it checked: the decision path blocks *in this process*. Resolving and
 * running that command is the remaining item of #1792.
 */
function selfValidate(profile, root, spec) {
  const payload = sentinelPayload(profile, root);
  const evaluated = evaluateHookInvocation(profile, payload, { workspaceRoot: root, allowControlPlane: true });
  if (evaluated.result.decision !== 'block') fail(`sentinel did not block for profile ${profile}: ${evaluated.result.decision}`);
  const expected = { decision: evaluated.result.decision, reason: evaluated.result.reason };
  if (spec.kind !== 'file') return { live: true, via: 'evaluator', ...expected };
  const artifact = exerciseArtifact(spec, profile, payload, root);
  if (artifact.decision !== expected.decision || artifact.reason !== expected.reason) {
    fail(`installed artifact decided ${artifact.decision}/${artifact.reason} where the guard decides ${expected.decision}/${expected.reason}`);
  }
  if (!artifact.receiptWritten) fail(`installed artifact blocked the sentinel without writing a receipt: ${spec.target}`);
  return { live: true, via: 'artifact', ...expected, receiptWritten: true };
}
function lastReceipt(pathname) {
  if (!fs.existsSync(pathname)) return null;
  const lines = fs.readFileSync(pathname, 'utf8').trim().split(/\r?\n/).filter(Boolean);
  if (!lines.length) return null;
  try {
    const receipt = JSON.parse(lines.at(-1));
    return { path: pathname, createdAt: receipt.createdAt || receipt.timestamp || null, receiptId: receipt.receiptId || null, decision: receipt.decision || null };
  } catch (_) { return { path: pathname, invalid: true }; }
}
function installed(spec, profile) {
  if (spec.kind === 'json-hook') {
    if (!fs.existsSync(spec.target)) return false;
    const config = readJson(spec.target); validateHookConfig(config, spec.target);
    return (config.hooks?.PreToolUse || []).some(entry => ownsHook(entry, profile));
  }
  if (spec.kind === 'file') return fs.existsSync(spec.target) && fs.readFileSync(spec.target, 'utf8') === template(spec.source);
  if (!fs.existsSync(spec.target)) return false;
  return fs.readdirSync(path.join(ADAPTER_ROOT, spec.source)).every(name => fs.existsSync(path.join(spec.target, name))
    && fs.readFileSync(path.join(spec.target, name), 'utf8') === template(path.join(spec.source, name)));
}

function manageGate(command, options = {}) {
  if (!options.deploymentAuthorized) fail('gate management requires deployment authority');
  const root = path.resolve(options.root || process.cwd());
  const home = path.resolve(options.home || os.homedir());
  const profiles = options.profile ? [options.profile] : PROFILES;
  if (command === 'status') {
    return { command, clients: profiles.map(profile => { const spec = profileSpec(profile, root, home); return { profile, installed: installed(spec, profile), target: spec.target }; }), lastReceipt: lastReceipt(options.receiptPath || defaultExternalActionReceiptPath()) };
  }
  if (profiles.length !== 1) fail(`${command} requires --profile`);
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
    if (spec.kind === 'json-hook') installJsonHook(spec, profile);
    else if (spec.kind === 'file') installFile(spec);
    else installDirectory(spec);
    let sentinel;
    try {
      sentinel = selfValidate(profile, root, spec);
    } catch (error) {
      if (!preexisting && spec.kind === 'file') fs.rmSync(spec.target, { force: true });
      throw error;
    }
    return { command, profile, target: spec.target, installed: true, sentinel };
  }
  if (command === 'uninstall') {
    const removed = spec.kind === 'json-hook' ? uninstallJsonHook(spec, profile) : spec.kind === 'file' ? uninstallFile(spec) : uninstallDirectory(spec);
    return { command, profile, target: spec.target, removed };
  }
  fail(`unsupported gate command: ${command}`);
}

module.exports = Object.freeze({ PROFILES, manageGate });
