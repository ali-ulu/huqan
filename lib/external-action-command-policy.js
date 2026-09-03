'use strict';

/**
 * The deployment's list of shell commands it does not want to approve on every
 * turn.
 *
 * Why a file rather than a flag: the hook command is written once by
 * `huqan-gate install` and then belongs to the host's config, so anything
 * expressed as a flag can only be changed by reinstalling -- and a reinstall
 * changes the command, which drops the host's persisted hook trust. A file the
 * guard reads at call time can be edited without touching either.
 *
 * The list can only promote a command the classifier would otherwise treat as
 * an unclassified tool chain; see `allowlistMatch` in external-action-envelope
 * for what it can never override.
 */

const fs = require('node:fs');
const path = require('node:path');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');

const MAX_POLICY_BYTES = 64 * 1024;

function defaultExternalActionPolicyPath(environment = process.env) {
  const override = typeof environment.HUQAN_EXTERNAL_GUARD_POLICY === 'string'
    ? environment.HUQAN_EXTERNAL_GUARD_POLICY.trim()
    : '';
  if (override) return path.resolve(override);
  return path.join(path.dirname(defaultExternalActionReceiptPath(environment)), 'external-action-policy.json');
}

function parseAllowedCommands(raw, target) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw new Error(`invalid JSON in command policy: ${target}`); }
  const list = Array.isArray(value) ? value : value && value.allowedCommands;
  if (list === undefined) return [];
  if (!Array.isArray(list)) throw new Error(`allowedCommands must be an array: ${target}`);
  return list.filter(entry => typeof entry === 'string' && entry.trim()).map(entry => entry.trim());
}

/**
 * Cached on the file's mtime and size so a long-lived editor process picks up
 * an edit without a restart, while a per-tool-call read stays a stat.
 */
const cache = new Map();
function readAllowedCommands(target = defaultExternalActionPolicyPath()) {
  let stats;
  try { stats = fs.statSync(target); } catch (_) { cache.delete(target); return []; }
  const stamp = `${stats.mtimeMs}:${stats.size}`;
  const cached = cache.get(target);
  if (cached && cached.stamp === stamp) return cached.allowedCommands;
  if (stats.size > MAX_POLICY_BYTES) throw new Error(`command policy exceeds ${MAX_POLICY_BYTES} bytes: ${target}`);
  const allowedCommands = parseAllowedCommands(fs.readFileSync(target, 'utf8'), target);
  cache.set(target, { stamp, allowedCommands });
  return allowedCommands;
}

/**
 * The declared data residency, or null when the deployment has not made one.
 *
 * Parsed separately from allowedCommands because the two answer different
 * questions -- one promotes a command past classification, the other refuses a
 * transfer outright. A malformed residency block must not silently disable the
 * command allowlist, nor the other way round.
 *
 * An empty or absent list reads as "not declared" rather than "nothing is
 * allowed": a residency rule is a legal commitment about a jurisdiction, and an
 * empty array is far more likely to be an unfinished edit than a deliberate
 * decision to refuse every transfer.
 */
function parseDataResidency(raw, target) {
  let value;
  try { value = JSON.parse(raw); } catch (_) { throw new Error(`invalid JSON in command policy: ${target}`); }
  const residency = value && value.dataResidency;
  if (residency === undefined || residency === null) return null;
  if (typeof residency !== 'object' || Array.isArray(residency)) {
    throw new Error(`dataResidency must be an object: ${target}`);
  }
  const list = residency.allowedDestinations;
  if (list === undefined) return null;
  if (!Array.isArray(list)) throw new Error(`dataResidency.allowedDestinations must be an array: ${target}`);
  const allowedDestinations = list
    .filter((entry) => typeof entry === 'string' && entry.trim())
    .map((entry) => entry.trim().toLowerCase());
  return allowedDestinations.length > 0 ? Object.freeze({ allowedDestinations }) : null;
}

function readDataResidency(target = defaultExternalActionPolicyPath()) {
  let stats;
  try { stats = fs.statSync(target); } catch (_) { return null; }
  if (stats.size > MAX_POLICY_BYTES) throw new Error(`command policy exceeds ${MAX_POLICY_BYTES} bytes: ${target}`);
  return parseDataResidency(fs.readFileSync(target, 'utf8'), target);
}

module.exports = Object.freeze({
  defaultExternalActionPolicyPath,
  readAllowedCommands,
  parseDataResidency,
  readDataResidency,
});
