'use strict';

/**
 * First-run path: one command that takes a brand-new user from a clean
 * checkout to a real Trust Receipt.
 *
 * Why this module exists
 * ----------------------
 * Before it, a first-time user had no reachable path to a result. `learn:`
 * returns `Gate: öğret review gerektiriyor` and — unlike the MCP path — the
 * CLI short-circuits *before* `huqan.learn` runs, so nothing is enqueued and
 * `onaylar` reports `Bekleyen onay yok.` The graph therefore stays empty and
 * `verify:` answers `bilinmiyor (confidence: 0.00)` forever. The product's
 * whole value proposition (a Trust Receipt) was unreachable without reading
 * source.
 *
 * What this does NOT do
 * ---------------------
 * It does not weaken any gate. `huqan.learn` still returns `review`, an
 * approval row is still persisted, and the canonical write still happens only
 * through `huqan.approve`. The approval id is printed so the audit trail the
 * write produced is inspectable rather than implicit.
 *
 * The one authority question this raises is "who approved it?". The answer is
 * the operator who typed `quickstart` — so the run is confined to a caller
 * supplied throwaway store (see `cli.js`, which hands it a temp directory) and
 * never mutates the user's canonical memory. Quickstart adds no authority over
 * user data; it only makes the already-designed learn -> approve -> verify ->
 * receipt pipeline reachable in one step.
 *
 * Dependencies are injected rather than required here so the flow can be unit
 * tested without a SQLite backend.
 */

const QUICKSTART_ACTOR = 'cli-quickstart';

/** The seeded claim uses an explicit CAUSES marker, which is the relation
 *  class HUQAN actually supports today. Picking a statement the NLP layer
 *  cannot parse would demo a failure, not the product. */
const DEFAULT_STATEMENT = 'smoking causes cancer';

/**
 * @param {object} deps
 * @param {object} deps.kernel                 KernelV2 instance (isolated store).
 * @param {Function} deps.callTool             mcpServer.callTool
 * @param {object} deps.approvalStore          approval store for the kernel
 * @param {Function} deps.buildTrustReceipt    provenance-query.buildTrustReceipt
 * @param {string} [deps.statement]            claim to seed and then verify
 * @param {string} [deps.operatorToken]        trusted CLI operator capability
 * @returns {{ok: boolean, steps: Array, approvalId: string|null,
 *            verification: object|null, receipt: object|null, error: object|null}}
 */
function runQuickstart(deps = {}) {
  const {
    kernel,
    callTool,
    approvalStore,
    buildTrustReceipt,
    operatorToken = '',
    statement = DEFAULT_STATEMENT,
  } = deps;

  const steps = [];
  const record = (name, ok, detail) => {
    steps.push({ step: name, ok, detail });
    return ok;
  };
  const fail = (code, message) => ({
    ok: false,
    steps,
    approvalId: null,
    verification: null,
    receipt: null,
    error: { code, message },
  });

  if (!kernel || typeof callTool !== 'function' || typeof buildTrustReceipt !== 'function') {
    return fail('QUICKSTART_DEPS_MISSING', 'quickstart requires kernel, callTool and buildTrustReceipt');
  }

  const runtime = { approvalStore, operatorToken };

  // 1. Propose the write. The gate is expected to answer `review`; that is the
  //    designed behaviour, so a bare `allow` here would mean the gate regressed.
  const learn = callTool(kernel, { name: 'huqan.learn', arguments: { text: statement } }, runtime);
  const approvalId = learn?.approval?.id || null;
  if (!approvalId) {
    record('propose', false, learn?.error?.message || 'huqan.learn returned no approval id');
    return fail('QUICKSTART_NO_APPROVAL', 'huqan.learn did not queue an approval; nothing was written.');
  }
  record('propose', true, `huqan.learn -> ${learn?.gate?.decision || 'review'} (${learn?.gate?.reason || 'mutating_requires_review'}), approval ${approvalId}`);

  // 2. Resolve the approval through the same path the MCP server uses. This is
  //    the only door to a canonical write and quickstart does not go around it.
  const approved = callTool(kernel, {
    name: 'huqan.approve',
    operatorToken,
    arguments: { approvalId, decision: 'approved', workspaceId: 'default' },
  }, runtime);
  if (!approved || approved.ok === false) {
    record('approve', false, approved?.error?.message || 'approval failed');
    return fail('QUICKSTART_APPROVAL_FAILED', `approval ${approvalId} could not be applied.`);
  }
  record('approve', true, `huqan.approve -> ${approved?.data?.decision || 'approved'} (actor ${QUICKSTART_ACTOR})`);

  // 3. Verify against the now-canonical graph.
  const verified = kernel.verify(statement);
  const verification = verified?.data || null;
  record('verify', Boolean(verification), verification
    ? `${verification.status} (confidence ${Number(verification.confidence || 0).toFixed(2)})`
    : 'verify returned no data');

  // 4. Materialize the Trust Receipt that the approved write produced.
  let receipt = null;
  try {
    receipt = buildTrustReceipt({ workspaceId: 'default' }, { target: kernel.graph });
  } catch (error) {
    record('receipt', false, error?.message || 'receipt build failed');
    return fail('QUICKSTART_RECEIPT_FAILED', error?.message || 'Trust Receipt could not be built.');
  }
  if (!receipt || !receipt.receiptId) {
    record('receipt', false, 'no receipt materialized');
    return fail('QUICKSTART_RECEIPT_EMPTY', 'No Trust Receipt was materialized for the approved write.');
  }
  record('receipt', true, `receiptId ${receipt.receiptId} (status ${receipt.status})`);

  return { ok: true, steps, approvalId, verification, receipt, error: null };
}

/**
 * Human-readable rendering. Kept next to the flow so the CLI case stays a
 * thin call rather than a second place that can drift from the step list.
 */
function formatQuickstartResult(result, opts = {}) {
  const lines = ['HUQAN quickstart — learn -> review -> approve -> verify -> Trust Receipt'];
  for (const [index, step] of (result?.steps || []).entries()) {
    lines.push(`  ${index + 1}. ${step.ok ? 'OK  ' : 'FAIL'} ${step.step}: ${step.detail}`);
  }
  if (!result || result.ok === false) {
    lines.push('');
    lines.push(`Quickstart failed: ${result?.error?.code || 'UNKNOWN'} — ${result?.error?.message || 'unknown error'}`);
    return lines.join('\n');
  }

  const receipt = result.receipt || {};
  lines.push('');
  lines.push('Trust Receipt');
  lines.push(`  receiptId          : ${receipt.receiptId}`);
  lines.push(`  claim              : ${receipt.claim}`);
  lines.push(`  status             : ${receipt.status}`);
  lines.push(`  workspaceId        : ${receipt.workspaceId}`);
  lines.push(`  trustPolicyVersion : ${receipt.trustPolicyVersion}`);
  lines.push(`  provenance         : ${receipt.provenance?.sourceRef || 'n/a'}`);
  lines.push(`  auditTrail entries : ${Array.isArray(receipt.auditTrail) ? receipt.auditTrail.length : 0}`);
  if (opts.storePath) {
    lines.push('');
    // The wording follows what actually happened to the directory: claiming it
    // was removed when the removal failed would be exactly the kind of
    // unverified claim this product exists to catch.
    lines.push(opts.storeRemoved
      ? `Demo store (throwaway, removed after the run; your own memory was not touched): ${opts.storePath}`
      : `Demo store (throwaway, left on disk; your own memory was not touched): ${opts.storePath}`);
  }
  lines.push('');
  lines.push('Next: run `huqan` for the interactive shell, or `huqan "verify: smoking causes cancer"`.');
  return lines.join('\n');
}

module.exports = {
  runQuickstart,
  formatQuickstartResult,
  QUICKSTART_ACTOR,
  DEFAULT_STATEMENT,
};
