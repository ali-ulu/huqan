'use strict';
// #2145: what the host itself says about an installed gate -- Codex's hook
// trust record -- and the newest receipt in the trail, for status reports.
const fs = require('node:fs');
const path = require('node:path');
/**
 * Codex records, per hook it has been shown, a `trusted_hash` of that hook --
 *
 *   [hooks.state.'C:\Users\sonfi\.codex\hooks.json:pre_tool_use:0:0']
 *   trusted_hash = "sha256:f6f59e70..."
 *
 * -- and silently skips a hook it has no matching record for; the CLI carries
 * `--dangerously-bypass-hook-trust` for exactly that reason. So writing a hook
 * entry disarms the gate until a human approves it in an interactive turn,
 * which was measured here: a fresh command meant PreToolUse never fired again
 * and nothing said so (#1797).
 *
 * The hash itself is not recomputed -- its input is Codex's business, and
 * guessing it would be a claim this cannot back. Only two things are read:
 * whether a record exists for this hook, and whether this install wrote the
 * entry, which is the only way its command changes.
 */
const CODEX_TRUST_KEY = /^\s*\[hooks\.state\.(?:'([^']*)'|"((?:[^"\\]|\\.)*)")\]/;
function codexTrustRecord(root, spec) {
  const store = path.join(root, '.codex', 'config.toml');
  if (!fs.existsSync(store)) return { store, present: false };
  const wanted = spec.target.toLowerCase();
  const present = fs.readFileSync(store, 'utf8').split(/\r?\n/).some(line => {
    const matched = CODEX_TRUST_KEY.exec(line);
    if (!matched) return false;
    const key = (matched[1] ?? matched[2].replace(/\\(.)/g, '$1')).toLowerCase();
    return key.startsWith(`${wanted}:`) && key.includes(':pre_tool_use:');
  });
  return { store, present };
}

/**
 * Reported on both install and status, because "is the gate approved by the
 * host" is a question you should be able to ask without reinstalling.
 */
function hostTrust(profile, root, spec, wroteEntry) {
  if (profile !== 'codex') return null;
  const { store, present } = codexTrustRecord(root, spec);
  if (!present) {
    return { host: 'codex', store, record: 'absent', reapprovalRequired: true, reason: 'Codex has no trust record for this hook, so it will skip it until you approve it in an interactive turn' };
  }
  if (wroteEntry) {
    return { host: 'codex', store, record: 'present', reapprovalRequired: true, reason: 'this install wrote the hook entry, so the stored trusted_hash is for the previous one; approve it again in an interactive turn' };
  }
  return { host: 'codex', store, record: 'present', reapprovalRequired: false, reason: '' };
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

module.exports = Object.freeze({ hostTrust, lastReceipt });
