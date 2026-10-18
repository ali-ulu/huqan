'use strict';

/**
 * The `mcp` command's parsing and its dispatch rules (ADR-018 §3, #3999),
 * kept out of `command-parser.js` so that file stays under its size threshold.
 * The other `command-parser-*-args` modules exist for the same reason.
 */

const FLAGS = Object.freeze(['name', 'client', 'public-key', 'out', 'key-file', 'key-id']);

/**
 * A flag's operand: a quoted token (paths with spaces) or one bare token that
 * does not start with `-`. `present` separates a flag that was never given
 * from one given without a usable operand (`--out --key-id x`), so the
 * command can refuse the second instead of taking the next option as a value.
 */
function readFlag(text, name) {
  const quoted = text.match(new RegExp(`--${name}\\s+"([^"]+)"`, 'i'));
  if (quoted) return { present: true, value: quoted[1] };
  const plain = text.match(new RegExp(`--${name}\\s+(?!-)(\\S+)`, 'i'));
  if (plain) return { present: true, value: plain[1] };
  return { present: new RegExp(`--${name}(?:\\s|$)`, 'i').test(text), value: '' };
}

function parseMcpServiceArgs(raw) {
  const text = String(raw || '').trim();
  const sub = (text.split(/\s+/)[0] || '').toLowerCase();
  const read = Object.fromEntries(FLAGS.map((flag) => [flag, readFlag(text, flag)]));
  const missingOperands = FLAGS.filter((flag) => read[flag].present && read[flag].value === '');
  return {
    sub,
    name: read.name.value,
    client: read.client.value,
    publicKey: read['public-key'].value,
    out: read.out.value,
    keyFile: read['key-file'].value,
    keyId: read['key-id'].value,
    ...(missingOperands.length ? { missingOperands } : {}),
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

module.exports = { mcpServiceCommandRules, parseMcpServiceArgs };
