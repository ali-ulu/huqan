'use strict';

// Argument parsing for the CLI `memory-query` command, split out of
// lib/command-parser.js so that file stays under its size threshold.
//
//   memory-query <text> [--workspace <id>] [--mode bm25|substring]
//                [--limit <n>] [--offset <n>] [--explain] [--json]
//
// Every word that is not a flag or a flag's operand is part of the text, so
// the query may contain spaces. A value flag with no operand is refused
// rather than read as an empty value: a dropped --workspace would silently
// search the default workspace instead.

const VALUE_FLAGS = Object.freeze({
  '--workspace': 'workspaceId',
  '--mode': 'retrievalMode',
  '--limit': 'limit',
  '--offset': 'offset',
});

function parseMemoryQueryArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const out = { text: '', workspaceId: 'default', retrievalMode: '', limit: '', offset: '', explain: false, json: false, error: '' };
  const words = [];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--explain') {
      out.explain = true;
    } else if (part === '--json') {
      out.json = true;
    } else if (Object.hasOwn(VALUE_FLAGS, part)) {
      const value = parts[index + 1];
      if (!value || value.startsWith('--')) {
        out.error = `${part} requires a value`;
        return out;
      }
      out[VALUE_FLAGS[part]] = value;
      index += 1;
    } else {
      words.push(part);
    }
  }
  out.text = words.join(' ').replace(/^["']|["']$/g, '');
  return out;
}

module.exports = { parseMemoryQueryArgs };
