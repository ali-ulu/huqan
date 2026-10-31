'use strict';

// #4068 [COG-M5] Lab arm preload for the dual-process router measurement.
//
// Loaded with `--require` into every episode process by test/helpers/
// cog-m5-harness.js. It is a no-op unless HUQAN_M5_ARM is set, so production
// never loads it and the default wiring is unchanged. The decision logic lives
// in cog-m5-arm.js; this file only wires it into the real Coder path by wrapping
// the selector that lib/coder/synthesis-memory.js consults.
//
// Env:
//   HUQAN_M5_ARM=candidate  consult the router; take the shortcut only on SYSTEM1
//   HUQAN_M5_ARM=baseline   never take the shortcut (always SYSTEM2 by arm)
//   HUQAN_M5_INPUTS=<path>  append one JSON line per decision (evidence)

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const ARM = process.env.HUQAN_M5_ARM;
const INPUTS = process.env.HUQAN_M5_INPUTS || '';

if (ARM) {
  const arm = require('./cog-m5-arm');
  const onDecision = entry => {
    if (!INPUTS) return;
    try { fs.appendFileSync(INPUTS, `${JSON.stringify(entry)}\n`); } catch (_) { /* evidence is best-effort */ }
  };

  const load = Module._load;
  Module._load = function (request, parent, isMain) {
    const exported = load.call(this, request, parent, isMain);
    // Two production callers reach the selector on the Coder path: the
    // memory-first synthesis (synthesis-memory.js) and the CLI's `--adapt-memory`
    // collaborator (cli-composition.js). Gating both reaches every shortcut
    // attempt without touching production code.
    const parentFile = parent && parent.filename;
    const isSelectorConsumer = parentFile
      && (parentFile.endsWith(path.join('lib', 'coder', 'synthesis-memory.js'))
        || parentFile.endsWith(path.join('lib', 'coder', 'cli-composition.js')))
      && request === './learned-candidate' && typeof exported.selectCandidate === 'function';
    if (isSelectorConsumer) {
      return { ...exported, selectCandidate(options = {}) {
        const selected = exported.selectCandidate(options);
        if (!selected.ok) return selected;
        const candidate = selected.task?.experience?.candidates?.[0];
        const requestId = options.runId || 'lab';
        const shortcut = ARM === 'baseline'
          ? arm.baselineTakesShortcut({ requestId, candidate, onDecision })
          : arm.candidateTakesShortcut({ journal: options.journal,
            workspaceId: options.workspaceId || 'default', requestId, candidate, onDecision });
        return shortcut ? selected : { ok: false, reason: 'no_applicable_candidate' };
      } };
    }
    return exported;
  };
}
