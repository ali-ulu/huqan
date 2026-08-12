'use strict';

/**
 * The `yardım` command's text.
 *
 * Lifted out of cli.js so that file stops growing against the ratchet in
 * scripts/check-file-size.js. Keeping the user-facing command reference in one
 * addressable module is also what makes it reviewable on its own -- it is the
 * first thing a new user reads.
 */

const CLI_HELP_LINES = Object.freeze([
  'HUQAN commands:',
  '  "quickstart"              -> your first Trust Receipt (one command, no API key needed)',
  '  "kedi balik yer"          -> I learn a fact',
  '  "kedi nedir"              -> I answer the question',
  '  "neden tavuk"             -> cause analysis',
  '  "tavuk mu yumurta mi"     -> comparison',
  '  "durum"                   -> system status',
  '  "ruya"                    -> I generate hypotheses',
  '  "plan: hedef"             -> I produce an agent plan',
  '  "ajan: hedef"             -> I run the agent',
  '  "backup"                  -> I back up the current state',
  '  "restore[: yol]"          -> I restore the latest or a chosen backup',
  '  "kaydet"                  -> I save memory',
  '  "onaylar"                 -> I list pending learn approvals',
  '  "onayla <id> [karar]"     -> I resolve a pending learn as approved/rejected',
  '  "llm-sor: soru"           -> I prepare an LLM recommendation',
  '  "yükle: dosya.txt"        -> I learn from a file',
  '  English-first aliases:',
  '  "learn: cats are animals" -> teach alias',
  '  "ask: cat nedir"          -> ask alias',
  '  "why: tavuk"              -> why alias',
  '  "compare: tavuk | yumurta"-> compare alias',
  '  "verify: kedi bitkidir"   -> guarded verify alias',
  '  "upload: notes.txt"       -> upload alias',
  // Escaped rather than literal, exactly as it was in cli.js: this line is
  // covered by the mojibake regression tests and must not change bytes here.
  '  Turkish compatibility aliases: \u00f6\u011fret, sor, neden, kar\u015f\u0131la\u015ft\u0131r, do\u011frula, y\u00fckle',
  '  "çıkış"                   -> exit',
]);

function cliHelpText() {
  return CLI_HELP_LINES.join('\n');
}

module.exports = { CLI_HELP_LINES, cliHelpText };
