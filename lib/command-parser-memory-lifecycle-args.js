'use strict';

// Argument parsing for the CLI `memory-lifecycle` command (#3461), split out
// of lib/command-parser.js so that file stays under its size threshold.
//
//   memory-lifecycle tombstone <memoryId> --reason <text> [--workspace <id>]
//   memory-lifecycle supersede <memoryId> --content <json> --reason <text> [--workspace <id>]
//   memory-lifecycle archive   <memoryId> --reason <text> [--workspace <id>]
//   memory-lifecycle restore   <memoryId> --reason <text> [--workspace <id>]
//   memory-lifecycle consolidate [--workspace <id>] [--reason <text>] [--limit <n>]
//       [--older-than-days <n>] [--include-low-confidence] [--max-confidence <n>] [--apply]
//
// The reason and the content run to the next flag, so both may contain spaces:
// the reason is the operator's words, the content is JSON. `consolidate` is
// dry-run unless `--apply` is given (#3493), so a bare call only lists.

// Flags are table-driven (FLAG_SPECS) rather than an if-chain: the dispatch is
// a growing set as actions are added, so a data table keeps it flat and makes
// each flag's arity explicit.
//
// kind: how the flag consumes its operand(s).
//   words   - every token up to the next `--` (may contain spaces)
//   value   - exactly one token; a missing operand is refused
//   number  - exactly one numeric token; a non-number is refused
//   boolean - no operand
// `hint` is the operand name shown in the refusal message.
const FLAG_SPECS = Object.freeze({
  '--content': { kind: 'words', field: 'content' },
  '--reason': { kind: 'words', field: 'reason' },
  '--workspace': { kind: 'value', field: 'workspaceId', hint: '<id>' },
  '--limit': { kind: 'number', field: 'limit', hint: '<n>' },
  '--older-than-days': { kind: 'number', field: 'olderThanDays', hint: '<n>' },
  '--max-confidence': { kind: 'number', field: 'maxConfidence', hint: '<n>' },
  '--include-low-confidence': { kind: 'boolean', field: 'includeLowConfidence' },
  '--apply': { kind: 'boolean', field: 'apply' },
});

function consumeFlag(out, parts, index) {
  const part = parts[index];
  const spec = FLAG_SPECS[part];
  if (!spec) return { index };

  if (spec.kind === 'boolean') {
    out[spec.field] = true;
    return { index };
  }

  if (spec.kind === 'words') {
    const words = [];
    let cursor = index;
    while (cursor + 1 < parts.length && !parts[cursor + 1].startsWith('--')) {
      cursor += 1;
      words.push(parts[cursor]);
    }
    out[spec.field] = words.join(' ').replace(/^["']|["']$/g, '');
    return { index: cursor };
  }

  const value = parts[index + 1];
  const label = `${part}${spec.hint ? ` ${spec.hint}` : ''}`;
  // A bare flag (no operand, or another flag next) is refused rather than
  // silently defaulting the scope/bound the operator set.
  if (!value || value.startsWith('--')) {
    return { error: `${label} requires a value` };
  }
  if (spec.kind === 'number') {
    if (!Number.isFinite(Number(value))) return { error: `${label} requires a numeric value` };
    out[spec.field] = Number(value);
  } else {
    out[spec.field] = value;
  }
  return { index: index + 1 };
}

function parseMemoryLifecycleArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const out = { action: '', memoryId: '', content: '', workspaceId: '', reason: '', error: '' };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.startsWith('--')) {
      const consumed = consumeFlag(out, parts, index);
      if (consumed.error) { out.error = consumed.error; return out; }
      index = consumed.index;
    } else if (!out.action) {
      out.action = part;
    } else if (!out.memoryId) {
      out.memoryId = part;
    }
  }
  return out;
}

module.exports = { parseMemoryLifecycleArgs };
