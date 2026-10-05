'use strict';

// Argument parsing for the CLI `memory-query` command, split out of
// lib/command-parser.js so that file stays under its size threshold.
//
//   memory-query <text> [--workspace <id>] [--mode bm25|substring]
//                [--limit <n>] [--offset <n>] [--explain] [--json]
//
// Every word that is not a flag or a flag's operand is part of the text, so
// the query may contain spaces. Quotes are resolved before flags are
// recognised: a quoted segment is always search text, so
// `memory-query "use --explain in docs"` searches for that phrase rather than
// switching explain on. A value flag with no operand is refused rather than
// read as an empty value: a dropped --workspace would silently search the
// default workspace instead.

const VALUE_FLAGS = Object.freeze({
  '--workspace': 'workspaceId',
  '--mode': 'retrievalMode',
  '--limit': 'limit',
  '--offset': 'offset',
});

/** Split on whitespace, keeping "double" and 'single' quoted runs whole. */
function tokenize(raw) {
  const tokens = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(String(raw || ''))) !== null) {
    const quoted = match[1] !== undefined ? match[1] : match[2];
    tokens.push(quoted !== undefined ? { value: quoted, quoted: true } : { value: match[3], quoted: false });
  }
  return tokens;
}

function parseMemoryQueryArgs(raw) {
  const tokens = tokenize(raw);
  const out = { text: '', workspaceId: 'default', retrievalMode: '', limit: '', offset: '', explain: false, json: false, error: '' };
  const words = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const { value, quoted } = tokens[index];
    if (quoted) {
      words.push(value);
    } else if (value === '--explain') {
      out.explain = true;
    } else if (value === '--json') {
      out.json = true;
    } else if (Object.hasOwn(VALUE_FLAGS, value)) {
      const operand = tokens[index + 1];
      if (!operand || (!operand.quoted && operand.value.startsWith('--')) || !operand.value) {
        out.error = `${value} requires a value`;
        return out;
      }
      out[VALUE_FLAGS[value]] = operand.value;
      index += 1;
    } else {
      words.push(value);
    }
  }
  out.text = words.join(' ').trim();
  return out;
}

module.exports = { parseMemoryQueryArgs };
