'use strict';

// The CLI `memory-lifecycle` operator command (#3461). The tombstone and
// supersede primitives shipped with a store-internal caller each, but nothing
// bound a *user* mutation to a receipt: `MemoryLifecycle` composed the six
// memory modules and had no production caller at all. This command is that
// caller. It drives the lifecycle's `tombstone`/`supersede` through the
// kernel's own memory store, so the reversible write is the same one the store
// already performs, and every accepted mutation produces a chained receipt the
// operator can verify.
//
//   memory-lifecycle tombstone <memoryId> --reason <text> [--workspace <id>]
//       soft-delete the memory; the record and its events survive
//   memory-lifecycle supersede <memoryId> --content <json> --reason <text> [--workspace <id>]
//       create a successor record and mark the old one 'superseded'
//
// The reason is required and is the operator's accountability for the removal;
// it rides on the CLI mutation audit the gate already writes. Fail-closed: a
// missing store, an unknown action or a store refusal returns a message and
// mutates nothing, so a refused removal can never be receipted as if it ran.

const { MemoryLifecycle } = require('./memory-lifecycle');
const { GENESIS_PREVIOUS_HASH, appendReceiptToChain, validateReceiptChain } = require('./receipt/receipt-chain');
const { verifyCryptographicEvidence } = require('./receipt/cryptographic-verification-adapter');

const ACTOR = 'operator:cli';
const ACTIONS = Object.freeze(['tombstone', 'supersede']);

// The receipt collaborators MemoryLifecycle cannot require itself: this module
// is the UI-ring caller the layer policy asks to supply them (lib/memory-* is
// the persistence family, lib/receipt/* is Application).
const chain = { GENESIS_PREVIOUS_HASH, appendReceiptToChain, validateReceiptChain };
const crypto = { verifyCryptographicEvidence };

function lifecycleFor(kernel) {
  const store = kernel && kernel.memory;
  if (!store || typeof store.tombstone !== 'function' || typeof store.supersede !== 'function') return null;
  return new MemoryLifecycle(kernel, { memoryStore: store, chain, crypto });
}

function missingReason(action) {
  return `--reason <text> is required: say why the ${action === 'tombstone' ? 'memory is being removed' : 'memory is being replaced'}`;
}

function runTombstone(lifecycle, args) {
  const result = lifecycle.tombstone(args.memoryId, {
    workspaceId: args.workspaceId,
    actor: ACTOR,
    reason: args.reason,
  });
  if (!result.ok) return { ok: false, output: `memory-lifecycle: ${result.error?.code || 'ERROR'} for ${args.memoryId}` };
  return { ok: true, output: `memory-lifecycle: ${args.memoryId} tombstoned (reversible; status deleted). receipt ${result.receipt.receiptId}` };
}

function runSupersede(lifecycle, args) {
  let content;
  try {
    content = JSON.parse(args.content);
  } catch {
    return { ok: false, output: 'memory-lifecycle: --content must be valid JSON' };
  }
  const result = lifecycle.supersede(args.memoryId, content, {
    workspaceId: args.workspaceId,
    actor: ACTOR,
    reason: args.reason,
  });
  if (!result.ok) return { ok: false, output: `memory-lifecycle: ${result.error?.code || 'ERROR'} for ${args.memoryId}` };
  return { ok: true, output: `memory-lifecycle: ${args.memoryId} superseded by ${result.newMemory.memoryId}. receipt ${result.receipt.receiptId}` };
}

function runMemoryLifecycleCommand(cli, args) {
  const parsed = args || {};
  const lifecycle = lifecycleFor(cli && cli.kernel);
  if (!lifecycle) return 'memory-lifecycle: unavailable (no memory store)';
  if (!ACTIONS.includes(parsed.action)) return `memory-lifecycle: unknown action ${parsed.action || '(none)'}; expected tombstone or supersede`;
  if (!parsed.memoryId) return 'memory-lifecycle: memoryId is required';
  if (!parsed.reason) return `memory-lifecycle: ${missingReason(parsed.action)}`;
  if (parsed.action === 'supersede' && !parsed.content) return 'memory-lifecycle: --content <json> is required for supersede';

  const result = parsed.action === 'tombstone' ? runTombstone(lifecycle, parsed) : runSupersede(lifecycle, parsed);
  // Only a completed mutation gets the matching `committed` audit; the gate
  // already wrote `attempted` before the handler ran (#760).
  if (result.ok && typeof cli.commitCliMutation === 'function') cli.commitCliMutation('memory-lifecycle');
  return result.output;
}

module.exports = { runMemoryLifecycleCommand, ACTIONS };
