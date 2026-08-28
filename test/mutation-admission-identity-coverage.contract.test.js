'use strict';

/**
 * Identity-enforcement coverage for the admission seam — P1-A (#1009).
 *
 * ## What the runtime alone could not prove
 *
 * `lib/agent-identity-runtime.js` evaluates identity and `lib/mutation-admission.js`
 * fails closed when an evaluator is wired. Neither fact says anything about
 * *coverage*: a production surface that constructed the seam without an
 * evaluator got an unenforced one, and it read exactly like an enforced one at
 * the call site. The presence of the runtime therefore proved nothing about
 * whether any given mutation was identity-gated.
 *
 * Two things close that, and they are deliberately different in kind:
 *
 * 1. `createMutationAdmission` now *requires* the `identityEvaluator` option.
 *    Omitting it is a TypeError, so an unenforced seam cannot be built by
 *    accident — only by writing `absent(reason)` and saying why.
 * 2. This file pins every construction site in runtime source, so switching a
 *    site from enforced to absent, or adding a new unenforced one, has to move
 *    a number in a reviewable diff.
 *
 * (1) makes the choice explicit; (2) makes it visible. (1) without (2) would
 * let a new `absent('')`-shaped construction land unremarked, since it is
 * well-formed code.
 *
 * ## What this does not claim
 *
 * Not that production mutations are identity-enforced today. Most are not: no
 * kernel, HTTP or MCP caller carries a receiver-owned identity claim yet, and
 * inventing one from a caller-supplied `actor` label is precisely what P1-A's
 * threat model rules out. What it claims is narrower and checkable: **every
 * seam in runtime source has stated which of the two it is, with a reason.**
 * The ENFORCED list reaching parity with the construction sites is the P1-A
 * finish line; this ledger is how that progress stays measurable.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { listSourceFiles } = require('../scripts/check-file-size.js');
const {
  ADMISSION_ERRORS,
  absent,
  createMutationAdmission,
} = require('../lib/mutation-admission.js');

const repoRoot = path.join(__dirname, '..');

/**
 * Seams built with a real receiver-owned evaluator.
 *
 * Growing this list, and shrinking the one below it, is what finishing P1-A
 * looks like.
 */
const ENFORCED_CONSTRUCTIONS = Object.freeze({
  'lib/external-client-mutation-receipt-owner.js': {
    why: 'external client ingress; the only surface whose identity is receiver-verified before the seam is reached',
    count: 1,
  },
  'lib/http/identity-mutation-admission.js': {
    why: 'HTTP ingest-approval audit writer; receiver-owned service identity is evaluated before the audit mutation',
    count: 1,
  },
});

/**
 * Seams built with a declared absence, and why each one has no evaluator yet.
 *
 * A debt ledger, like UNROUTED_SINK_CALLS in the boundary contract. Every
 * entry is a production surface whose callers carry no receiver-owned identity
 * claim, so there is nothing for an evaluator to judge. Each is expected to
 * move to ENFORCED_CONSTRUCTIONS when its callers gain one.
 */
const DECLARED_ABSENT_CONSTRUCTIONS = Object.freeze({
  'lib/mcp-ingest-execute-tool.js': {
    why: 'MCP ingest execute; gates on its own approval flow, not on an identity decision',
    count: 1,
  },
  'lib/kernel-mutation-admission.js': {
    why: 'kernel fallback seam, named once as unenforcedFallbackSeam and shared by all three kernel entry points',
    count: 1,
  },
  'lib/external-client-mutation-receipt-owner.js': {
    why: 'fallback for a client configured without an agentIdentityRuntime; the enforced seam above is built only when one is',
    count: 1,
  },
});

/** Construction sites, counted per runtime source file. */
function constructionSites() {
  const sites = new Map();
  for (const rel of listSourceFiles()) {
    if (!rel.endsWith('.js')) continue;
    if (rel === 'lib/mutation-admission.js') continue; // the definition itself
    const src = fs.readFileSync(path.join(repoRoot, rel), 'utf8');
    const calls = src.match(/createMutationAdmission\s*\(/g);
    if (calls) sites.set(rel, calls.length);
  }
  return sites;
}

// ─── the ledger ──────────────────────────────────────────────────────────────

test('every admission seam in runtime source has declared its identity enforcement', () => {
  const sites = constructionSites();
  const declared = new Map();
  for (const [file, entry] of Object.entries(ENFORCED_CONSTRUCTIONS)) {
    declared.set(file, (declared.get(file) || 0) + entry.count);
  }
  for (const [file, entry] of Object.entries(DECLARED_ABSENT_CONSTRUCTIONS)) {
    declared.set(file, (declared.get(file) || 0) + entry.count);
  }

  const undeclared = [...sites.keys()].filter((f) => !declared.has(f));
  assert.deepEqual(undeclared, [],
    'these files construct the admission seam but are in neither ledger. Add an '
    + 'entry saying whether the construction enforces identity and why:\n'
    + undeclared.map((f) => `  ${f}`).join('\n'));

  const stale = [...declared.keys()].filter((f) => !sites.has(f));
  assert.deepEqual(stale, [],
    `these ledger entries name files that no longer construct the seam: ${stale.join(', ')}`);

  for (const [file, count] of sites) {
    assert.equal(count, declared.get(file),
      `${file} constructs the seam ${count} time(s) but the ledgers account for `
      + `${declared.get(file)}. A construction was added or removed without moving a number.`);
  }
});

test('the enforced list is the one that has to grow', () => {
  // Stated as a test so the direction of travel is executable rather than
  // aspirational: if this count ever drops, a production surface stopped
  // enforcing identity and the diff has to say so.
  const enforced = Object.values(ENFORCED_CONSTRUCTIONS)
    .reduce((sum, entry) => sum + entry.count, 0);
  assert.ok(enforced >= 1, 'no production seam enforces identity any more');
});

// ─── the property the ledger rests on ────────────────────────────────────────

test('a seam cannot be constructed without declaring its identity enforcement', () => {
  // The omission this closes: before #1009 each of these produced a silently
  // unenforced seam.
  assert.throws(() => createMutationAdmission(),
    (err) => err instanceof TypeError
      && err.message === ADMISSION_ERRORS.IDENTITY_ENFORCEMENT_UNDECLARED);
  assert.throws(() => createMutationAdmission({ clock: () => new Date() }),
    (err) => err.message === ADMISSION_ERRORS.IDENTITY_ENFORCEMENT_UNDECLARED);

  // An omission spelled out in full is still an omission.
  for (const written of [undefined, null, false, 0, '', 'none']) {
    assert.throws(() => createMutationAdmission({ identityEvaluator: written }),
      (err) => err instanceof TypeError, `identityEvaluator: ${JSON.stringify(written)}`);
  }

  // And a marker that claims absence without a reason cannot stand in for one.
  assert.throws(() => createMutationAdmission({ identityEvaluator: { kind: 'absent' } }),
    (err) => err.message === ADMISSION_ERRORS.IDENTITY_EVALUATOR_INVALID);
});

test('the seam reports which of the two it is', () => {
  const enforced = createMutationAdmission({ identityEvaluator: () => ({ allowed: true, decision: 'allow' }) });
  assert.equal(enforced.identityEnforced, true);

  const unenforced = createMutationAdmission({ identityEvaluator: absent('no claim reaches this surface yet') });
  assert.equal(unenforced.identityEnforced, false);
});
