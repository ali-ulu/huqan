'use strict';

/**
 * The sentence a CLI user gets when the gate refuses a command (#1693).
 *
 * These three messages were Turkish, on a CLI whose help, quickstart output and
 * README are English -- and the Turkish itself was half-encoded ("öğret" with
 * its diacritics, "calistirma" and "yapilmadi" flattened to ASCII in the same
 * sentence), so it read as a mojibake bug rather than a deliberate refusal.
 *
 * The refusal is the product working: a mutating command does not run silently.
 * That only lands if the message says so and says what to do instead. A bare
 * "review required" leaves the reader holding a rejection with nowhere to go,
 * which is how a correct gate gets reported as a broken install.
 *
 * What it must not do is invent a next step that does not exist. The CLI gate
 * refuses *before* the command runs, so no approval record is created and
 * `huqan approvals` stays empty -- telling the reader to go approve something
 * would send them to an empty list. The honest pointer is the quickstart, which
 * demonstrates the whole propose -> review -> approve -> verify loop, and the
 * operator surfaces that carry approvals in a real deployment.
 *
 * Lifted out of cli.js, which sits exactly at the 800-line threshold
 * scripts/check-file-size.js enforces.
 */

/**
 * Internal command names are the Turkish spellings (RFC-001 decision 7 keeps
 * them permanently), but a reader who typed `learn:` should not be told that
 * "öğret" was refused -- they never typed that word. Report the English name
 * for anything the message might name.
 */
const ENGLISH_COMMAND_NAMES = Object.freeze({
  'öğret': 'learn',
  sor: 'ask',
  neden: 'why',
  'karşılaştır': 'compare',
  'doğrula': 'verify',
  'yükle': 'ingest',
  durum: 'status',
  'rüya': 'dream',
  kaydet: 'save',
  ajan: 'agent',
  onaylar: 'approvals',
  onayla: 'approve',
  'düşün': 'think',
  konsolide: 'consolidate',
});

function commandLabel(command) {
  const raw = String(command || '').trim();
  if (!raw) return 'command';
  return ENGLISH_COMMAND_NAMES[raw] || raw;
}

const NEXT_STEPS = Object.freeze({
  review: 'This command mutates state, so it needs a review decision and the CLI '
    + 'does not create one. Run `huqan quickstart` to see the full '
    + 'propose -> review -> approve -> verify loop, or drive the approval from '
    + 'the MCP server (`huqan-mcp`) or the HTTP approval routes, where an '
    + 'operator can decide it.',
  dry_run_only: 'This command is available in preview only. Nothing was started, '
    + 'and no state changed.',
  block: 'The command was refused and nothing ran.',
});

/**
 * @param {string} command The command as the user typed it.
 * @param {{decision?: string, reason?: string}} gate
 * @returns {string}
 */
function formatCliGateMessage(command, gate) {
  const decision = gate?.decision || 'block';
  const reason = gate?.reason || 'gate_blocked';
  const label = commandLabel(command);

  const headline = decision === 'dry_run_only'
    ? `Gate: "${label}" is dry-run-only. Nothing was started.`
    : decision === 'review'
      ? `Gate: "${label}" requires review. Nothing was mutated and nothing ran.`
      : `Gate: "${label}" was blocked. Nothing ran.`;

  const nextStep = NEXT_STEPS[decision] || NEXT_STEPS.block;
  return `${headline}\n  decision: ${decision}\n  reason: ${reason}\n  ${nextStep}`;
}

module.exports = { ENGLISH_COMMAND_NAMES, NEXT_STEPS, commandLabel, formatCliGateMessage };
