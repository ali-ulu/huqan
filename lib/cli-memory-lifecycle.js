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
//
// This module is Core (`lib/cli-*`), and the lifecycle it drives is Adapters
// (`lib/memory-*`) whose receipt collaborators are Application
// (`lib/receipt/*`). Core may not reach either, so the built lifecycle arrives
// on the cli context -- cli.js is the UI entrypoint allowed to supply it --
// rather than being constructed here.

const ACTOR = 'operator:cli';
const ACTIONS = Object.freeze(['tombstone', 'supersede']);

function lifecycleFor(cli) {
  const factory = cli && cli.memoryLifecycle;
  return typeof factory === 'function' ? factory() : null;
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
  const hash = result.receipt.chainedReceipt?.receiptHash;
  return {
    ok: true,
    receiptId: result.receipt.receiptId,
    output: `memory-lifecycle: ${args.memoryId} tombstoned (reversible; status deleted). receipt ${result.receipt.receiptId}${hash ? ` chain ${hash}` : ''}`,
  };
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
  const hash = result.receipt.chainedReceipt?.receiptHash;
  return {
    ok: true,
    receiptId: result.receipt.receiptId,
    output: `memory-lifecycle: ${args.memoryId} superseded by ${result.newMemory.memoryId}. receipt ${result.receipt.receiptId}${hash ? ` chain ${hash}` : ''}`,
  };
}

function runMemoryLifecycleCommand(cli, args) {
  const parsed = args || {};
  // A malformed flag (a bare `--workspace`) is refused before anything else.
  if (parsed.error) return `memory-lifecycle: ${parsed.error}`;
  const lifecycle = lifecycleFor(cli);
  if (!lifecycle) return 'memory-lifecycle: unavailable (no memory store)';
  if (!ACTIONS.includes(parsed.action)) return `memory-lifecycle: unknown action ${parsed.action || '(none)'}; expected tombstone or supersede`;
  if (!parsed.memoryId) return 'memory-lifecycle: memoryId is required';
  if (!parsed.reason) return `memory-lifecycle: ${missingReason(parsed.action)}`;
  if (parsed.action === 'supersede' && !parsed.content) return 'memory-lifecycle: --content <json> is required for supersede';

  const result = parsed.action === 'tombstone' ? runTombstone(lifecycle, parsed) : runSupersede(lifecycle, parsed);
  if (!result.ok) return result.output;
  // Only a completed mutation gets the matching `committed` audit; the gate
  // already wrote `attempted` before the handler ran (#760). The operator's
  // reason and the receipt id ride on both phases, and a failed commit audit is
  // reported rather than swallowed, exactly as every other CLI mutation does.
  const warning = typeof cli.commitCliMutation === 'function'
    ? cli.commitCliMutation('memory-lifecycle', null, { workspaceId: parsed.workspaceId, operatorReason: parsed.reason, receiptReference: result.receiptId })
    : '';
  return `${result.output}${warning || ''}`;
}

module.exports = { runMemoryLifecycleCommand, ACTIONS };
