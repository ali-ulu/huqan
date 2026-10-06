'use strict';
// #2145: the JSON hook entries the installer writes into Claude Code and Codex
// configs -- building them, recognising the ones it owns, and refusing to touch
// entries someone has edited.
const fs = require('node:fs');
const path = require('node:path');
const { fail, plain, readJson, writeJson, jsonTemplate } = require('./external-action-gate-install-spec');
function hookEvents(profile) {
  return profile === 'claude-code' ? ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] : ['PreToolUse'];
}
/**
 * OpenHands reads the same hook format as Claude Code but spells the event keys
 * in snake_case in the repository's `.openhands/hooks.json`; the JSON-hook
 * installer works in the PascalCase names and translates here, so every other
 * profile is untouched.
 */
function hookKey(profile, event = 'PreToolUse') {
  return profile === 'openhands' ? event.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase() : event;
}
function hookTemplate(profile, event = 'PreToolUse') {
  const file = profile === 'claude-code' ? 'claude-code-hooks.json'
    : profile === 'openhands' ? 'openhands-hooks.json'
      : 'codex-hooks.json';
  return jsonTemplate(file).hooks[hookKey(profile, event)][0];
}
// The identity material an operator can bind to a recorded hook command. The
// values are file paths, so the command keeps working from any cwd the host
// chooses; the flags are appended in one canonical order (see #2505) so
// ownership below can recognise the shape this install writes.
const IDENTITY_FLAG_NAMES = Object.freeze(['--identity-card', '--identity-card-signature', '--trusted-identity-keys']);
function identitySuffix(identityFlags = []) {
  return identityFlags.length ? ` ${identityFlags.join(' ')}` : '';
}
/**
 * The canonical `--flag path` list for the identity material an operator binds
 * to a recorded hook command. Paths are resolved absolute so the recorded
 * command does not depend on the cwd the host happens to hand the hook.
 *
 * The recorded command is unquoted: quoting is not portable across the shells a
 * host may run, and a path split by whitespace would make `argumentValue` read
 * only the first token, so a benign probe would fail closed for a reason the
 * operator cannot see. A path that carries whitespace, a glob, a shell operator
 * or a Windows `%`/`^` is refused before it is read or probed -- a shell
 * operator could otherwise run during the probe itself (#2505).
 */
function identityFlagsFor(options = {}) {
  const supplied = {
    '--identity-card': options.identityCard,
    '--identity-card-signature': options.identityCardSignature,
    '--trusted-identity-keys': options.trustedIdentityKeys,
  };
  return IDENTITY_FLAG_NAMES.flatMap((name) => {
    const value = typeof supplied[name] === 'string' ? supplied[name].trim() : '';
    if (!value) return [];
    const resolved = path.resolve(value);
    // `~` is left out: it only expands at the start of a word, and a resolved
    // path is absolute, so a mid-path `~` (a Windows short name) is literal.
    const shellUnsafe = /[\s"'`$&|;<>%^()!*?[\]{}]/.test(resolved)
      || (process.platform !== 'win32' && resolved.includes('\\'));
    if (shellUnsafe) {
      fail(`${name} path cannot be used in an unquoted hook command: ${resolved}. Use a path without whitespace or shell metacharacters.`);
    }
    return [name, resolved];
  });
}
function hookEntry(profile, command, event = 'PreToolUse', identityFlags = []) {
  const entry = hookTemplate(profile, event);
  // Identity material is bound to the admission call only; the browser-outcome
  // event records a result and never evaluates identity, so it is left plain.
  const suffix = event === 'PreToolUse' ? identitySuffix(identityFlags) : '';
  const invocation = `${command}${event === 'PreToolUse' ? '' : ' browser-outcome'} --profile ${profile}${suffix}`;
  entry.hooks = entry.hooks.map(hook => ({
    ...hook,
    ...(hook.command === undefined ? {} : { command: invocation }),
    ...(hook.commandWindows === undefined ? {} : { commandWindows: invocation }),
  }));
  return entry;
}
function validateHookConfig(config, target) {
  if (config.hooks !== undefined && !plain(config.hooks)) fail(`hooks must be an object: ${target}`);
  if (config.hooks?.PreToolUse !== undefined && !Array.isArray(config.hooks.PreToolUse)) fail(`hooks.PreToolUse must be an array: ${target}`);
  for (const event of ['PostToolUse', 'PostToolUseFailure', 'pre_tool_use']) {
    if (config.hooks?.[event] !== undefined && !Array.isArray(config.hooks[event])) fail(`hooks.${event} must be an array: ${target}`);
  }
}
function hookCommands(entry) {
  return plain(entry) && Array.isArray(entry.hooks)
    ? entry.hooks.filter(plain).flatMap(hook => [hook.command, hook.commandWindows]).filter(command => typeof command === 'string')
    : [];
}
/**
 * A command this install could have written: some spelling of the gate entry,
 * then `--profile <profile>`, then nothing or the canonical identity flags in
 * canonical order. Anything else -- an added flag such as `--require-identity`,
 * a reordered identity block, a wrapper script -- is a local edit, and the
 * caller refuses to overwrite or remove those rather than silently reclaiming
 * them (#2145, extended for identity binding in #2505).
 */
function matchesIdentityFlags(tail) {
  if (tail.length === 0) return true;
  if (tail.length % 2 !== 0) return false;
  let last = -1;
  for (let index = 0; index < tail.length; index += 2) {
    const position = IDENTITY_FLAG_NAMES.indexOf(tail[index]);
    // Unknown flag, a repeat, or out of canonical order is not ours.
    if (position <= last) return false;
    if (!tail[index + 1] || tail[index + 1].startsWith('--')) return false;
    last = position;
  }
  return true;
}
function ownedCommand(command, profile, event = 'PreToolUse') {
  const tokens = command.trim().split(/\s+/);
  const profileIndex = tokens.indexOf('--profile');
  if (profileIndex < 1 || tokens[profileIndex + 1] !== profile) return false;
  // The non-admission events name themselves between the gate entry and
  // `--profile`, and carry no identity material.
  let headEnd = profileIndex;
  if (event !== 'PreToolUse') {
    if (tokens[profileIndex - 1] !== 'browser-outcome') return false;
    headEnd = profileIndex - 1;
  }
  const head = tokens.slice(0, headEnd).join(' ');
  if (!(/(^|[\\/])huqan-gate(\.cmd)?"?$/.test(head) || /huqan-gate-hook\.js"?$/.test(head))) return false;
  if (event !== 'PreToolUse') return profileIndex === tokens.length - 2;
  return matchesIdentityFlags(tokens.slice(profileIndex + 2));
}
function ownsHook(entry, profile, event = 'PreToolUse') {
  const expected = hookTemplate(profile, event);
  const commands = hookCommands(entry);
  return plain(entry) && entry.matcher === expected.matcher
    && Array.isArray(entry.hooks) && entry.hooks.length === expected.hooks.length
    && entry.hooks.every((hook, index) => plain(hook) && hook.type === expected.hooks[index].type && hook.timeout === expected.hooks[index].timeout)
    && commands.length > 0 && commands.every(command => ownedCommand(command, profile, event));
}
function mentionsHuqanHook(entry, profile) {
  return hookCommands(entry).some(command => command.includes('huqan-gate') && command.includes(`--profile ${profile}`));
}
function installJsonHook(spec, profile, command, identityFlags = []) {
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  config.hooks = { ...(config.hooks || {}) };
  for (const event of hookEvents(profile)) {
    const key = hookKey(profile, event);
    const current = [...(config.hooks[key] || [])];
    const desired = hookEntry(profile, command, event, identityFlags);
    const desiredCommand = hookCommands(desired)[0];
    const ownedIndex = current.findIndex(entry => ownsHook(entry, profile, event));
    // An owned entry is left in place when it already records the desired
    // command: a dead recorded command must fail over rather than be silently
    // refreshed, and a reinstall that changes nothing must not disturb the
    // host's trust record. Rebinding an owned entry to a different capability
    // card is the one exception -- it is our entry, and the sentinel below
    // proves the replacement (#2505).
    if (ownedIndex === -1) {
      if (current.some(entry => mentionsHuqanHook(entry, profile))) fail(`refusing to overwrite modified HUQAN hook: ${spec.target}`);
      current.push(desired);
    } else if (event === 'PreToolUse' && identityFlags.length
      && !hookCommands(current[ownedIndex]).includes(desiredCommand)) {
      current[ownedIndex] = desired;
    }
    config.hooks[key] = current;
  }
  writeJson(spec.target, config);
}
function uninstallJsonHook(spec, profile) {
  if (!fs.existsSync(spec.target)) return false;
  const config = readJson(spec.target);
  validateHookConfig(config, spec.target);
  let changed = false;
  config.hooks = { ...(config.hooks || {}) };
  for (const event of hookEvents(profile)) {
    const key = hookKey(profile, event);
    const before = config.hooks[key] || [];
    if (before.some(entry => mentionsHuqanHook(entry, profile) && !ownsHook(entry, profile, event))) {
      fail(`refusing to remove modified HUQAN hook: ${spec.target}`);
    }
    const after = before.filter(entry => !ownsHook(entry, profile, event));
    if (after.length !== before.length) { config.hooks[key] = after; changed = true; }
  }
  if (!changed) return false;
  writeJson(spec.target, config);
  return true;
}
function installedHookCommand(spec, profile) {
  const entry = (readJson(spec.target).hooks?.[hookKey(profile)] || []).find(candidate => ownsHook(candidate, profile));
  const hook = entry && entry.hooks.find(plain);
  const command = hook && (process.platform === 'win32' && hook.commandWindows ? hook.commandWindows : hook.command);
  if (!command) fail(`no HUQAN hook command to validate: ${spec.target}`);
  return command;
}

module.exports = Object.freeze({
  hookEvents, hookKey, validateHookConfig, ownsHook, installJsonHook, uninstallJsonHook, installedHookCommand,
  identityFlagsFor,
});
