'use strict';

/**
 * The `yardım` command's text.
 *
 * Lifted out of cli.js so that file stops growing against the ratchet in
 * scripts/check-file-size.js. Keeping the user-facing command reference in one
 * addressable module is also what makes it reviewable on its own -- it is the
 * first thing a new user reads.
 */

const { CLI_COMMAND_CAPABILITIES } = require('./workflow-contract');

const commandLines = CLI_COMMAND_CAPABILITIES.map(item => `  "${item.usage}" -> ${item.description}`);
const CLI_HELP_LINES = Object.freeze([
  'HUQAN commands:',
  ...commandLines,
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
