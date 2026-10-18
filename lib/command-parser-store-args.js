'use strict';

/**
 * The `store` command's parsing and its dispatch rules (ADR-018 §2, #3998),
 * kept out of `command-parser.js` so that file stays under its size threshold.
 * The other `command-parser-*-args` modules exist for the same reason.
 */

/** `store migrate [--rollback] [--workspace <dir>]`. The workspace path may
 * contain spaces, so `--workspace` takes the rest of the line; `--rollback` is
 * a bare flag. */
function parseStoreMigrateArgs(raw) {
  const text = String(raw || '').trim();
  const out = { rollback: false, workspace: '' };
  const rest = text.replace(/--rollback\b/i, () => { out.rollback = true; return ''; }).trim();
  const workspaceMatch = rest.match(/--workspace\s+(.+)$/i);
  if (workspaceMatch) out.workspace = workspaceMatch[1].trim().replace(/^["']|["']$/g, '');
  return out;
}

/**
 * The rules that route `store ...` to the `store` command. `matchRule` is the
 * host's matcher, passed in so this module does not import the parser back.
 *
 * Matched against `raw`, not the case-folded `trimmed`: a workspace path is
 * filesystem input and folding its case could name a different directory.
 */
function storeCommandRules(matchRule) {
  return [
    matchRule(/^store\s+migrate(?:\s+(.*))?$/i, 'raw', (match) => ({
      command: 'store',
      args: parseStoreMigrateArgs(match[1] || ''),
    })),
    matchRule(/^store\s*$/i, 'raw', () => ({ command: 'store', args: { help: true } })),
  ];
}

module.exports = { parseStoreMigrateArgs, storeCommandRules };
