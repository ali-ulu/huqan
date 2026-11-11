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

/**
 * #4587: the host's failure contract, which HUQAN cannot change from its side.
 *
 * The OpenHands SDK host (pinned v1.34.0, `openhands/sdk/hooks/executor.py`)
 * marks a command hook blocked only on exit code 2, or a top-level
 * `{"decision":"deny"}` / `{"continue":false}` in stdout. A hook that times
 * out, cannot be started, crashes with a non-2 exit, or emits malformed/empty
 * output is logged and the action proceeds -- the host fails OPEN. HUQAN's own
 * hook fails closed on a payload it cannot parse (exit 2), but it cannot fail
 * closed on the host's side of the boundary because the host never reaches it
 * in those cases.
 *
 * So the OpenHands integration is a *best-effort* pre-execution guard, not a
 * fail-closed security boundary, and install/status have to say so instead of
 * letting a blocked sentinel read as "protected under every failure". This is
 * the same honest-labelling move as "Signed Is Not Sandboxed"
 * (docs/core-plugin-boundary-contract.md), not a runtime change.
 */
function hostFailureBoundary(profile) {
  if (profile !== 'openhands') return null;
  return {
    host: 'openhands',
    failMode: 'open',
    classification: 'best_effort',
    securityBoundary: false,
    reason: 'the OpenHands SDK host blocks a pre_tool_use hook only on exit code 2 or a top-level {"decision":"deny"}; on hook timeout, a crash, a missing command, or malformed/empty output it proceeds with the action. HUQAN fails closed on an unreadable payload (exit 2), but the host does not invoke it in those cases, so a host-side hook failure is not stopped here.',
    docs: 'docs/automations/openhands.md',
  };
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

module.exports = Object.freeze({ hostTrust, hostFailureBoundary, lastReceipt });
