'use strict';

// Argument parsing for the CLI `memory-lifecycle` command (#3461), split out
// of lib/command-parser.js so that file stays under its size threshold.
//
//   memory-lifecycle tombstone <memoryId> --reason <text> [--workspace <id>]
//   memory-lifecycle supersede <memoryId> --content <json> --reason <text> [--workspace <id>]
//
// The reason and the content run to the next flag, so both may contain spaces:
// the reason is the operator's words, the content is JSON.

function parseMemoryLifecycleArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const out = { action: '', memoryId: '', content: '', workspaceId: '', reason: '', error: '' };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--content' || part === '--reason') {
      const words = [];
      while (index + 1 < parts.length && !parts[index + 1].startsWith('--')) {
        index += 1;
        words.push(parts[index]);
      }
      out[part === '--content' ? 'content' : 'reason'] = words.join(' ').replace(/^["']|["']$/g, '');
    } else if (part === '--workspace') {
      const value = parts[index + 1];
      // A bare `--workspace` (no operand, or another flag next) is refused
      // rather than defaulting to an empty id: a scoped removal whose scope was
      // silently dropped would act on the default workspace instead.
      if (!value || value.startsWith('--')) {
        out.error = '--workspace <id> requires a value';
        return out;
      }
      out.workspaceId = value;
      index += 1;
    } else if (!out.action) {
      out.action = part;
    } else if (!out.memoryId) {
      out.memoryId = part;
    }
  }
  return out;
}

module.exports = { parseMemoryLifecycleArgs };
