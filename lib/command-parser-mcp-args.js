'use strict';

/**
 * The `mcp` command's parsing and its dispatch rules (ADR-018 §3, #3999),
 * kept out of `command-parser.js` so that file stays under its size threshold.
 * The other `command-parser-*-args` modules exist for the same reason.
 */

/** A flag value: a quoted token (paths with spaces) or one bare token. */
function flagValue(text, name) {
  const quoted = text.match(new RegExp(`--${name}\\s+"([^"]+)"`, 'i'));
  if (quoted) return quoted[1];
  const plain = text.match(new RegExp(`--${name}\\s+(\\S+)`, 'i'));
  return plain ? plain[1] : '';
}

function parseMcpServiceArgs(raw) {
  const text = String(raw || '').trim();
  const sub = (text.split(/\s+/)[0] || '').toLowerCase();
  return {
    sub,
    name: flagValue(text, 'name'),
    client: flagValue(text, 'client'),
    publicKey: flagValue(text, 'public-key'),
    out: flagValue(text, 'out'),
    keyFile: flagValue(text, 'key-file'),
    keyId: flagValue(text, 'key-id'),
  };
}

/**
 * The rules that route `mcp ...` to the `mcp` command. Matched against `raw`,
 * not the case-folded `trimmed`: enroll and config carry filesystem paths,
 * and folding their case could name a different file.
 */
function mcpServiceCommandRules(matchRule) {
  const route = (sub) => matchRule(new RegExp(`^mcp\\s+${sub}(?:\\s+(.*))?$`, 'i'), 'raw',
    (match) => ({ command: 'mcp', args: parseMcpServiceArgs(`${sub} ${match[1] || ''}`) }));
  return [
    route('status'),
    route('enroll'),
    route('revoke'),
    route('config'),
    matchRule(/^mcp\s*$/i, 'raw', () => ({ command: 'mcp', args: { sub: 'help' } })),
  ];
}

module.exports = { flagValue, mcpServiceCommandRules, parseMcpServiceArgs };
