'use strict';

// Break-glass: a time-boxed, narrowly-scoped, reason-carrying override (İP-2).
//
// The problem it answers is the one the emergency stop cannot. The stop is a
// brake: it takes work off the board. There is a second, opposite moment -- a
// production incident at 18:40 where the operator *must* get a change through
// and every tool call stopping for a human is itself the outage. Neither
// "approve every call by hand" nor "turn the guard off" is acceptable there, so
// the operator needs a documented, bounded, recorded third option.
//
// What makes it safe is one asymmetry, enforced in lib/break-glass-gate.js and
// restated here because everything else depends on it: a window can only ever
// turn a *review* into an *allow*. It can never turn a *block* into anything.
// A deploy, a force-push, a destructive delete and a secret write are blocks,
// so an open window does not let them run. The window shortens the queue in
// front of a human; it does not remove the human from the actions that matter.
//
// ## Four bounds, each enforced here rather than described
//
//   - time: every window carries `expiresAt`, mandatory, at most MAX_WINDOW_MS
//     from issue. There is no unbounded window to forget about.
//   - scope: a window is bound to one workspace, optionally to one agent, and
//     optionally to a set of categories. It is not a global switch.
//   - reason: `reason` and the issuing `actor` are both required and stored.
//   - uses: `maxUses` is required and capped, so one window cannot become a
//     standing policy by being left open.
//
// ## Fail-closed, and the difference from the emergency stop
//
// The ledger is a hash chain, the same mechanics as
// lib/emergency-stop-chain.js (computeEntryHash is imported by
// lib/break-glass-ledger.js, so the hash shape has one definition). A chain
// that does not verify yields **no active window**: a tampered ledger grants
// nothing, and `issue` refuses to write to a chain it cannot trust. This is
// deliberately the opposite of the emergency stop, which proceeds on an
// integrity violation because a brake must always be available. An override
// must never be available when its record cannot be trusted -- the two
// directions of "fail closed" are not the same.
//
// ## If HUQAN is down
//
// A window is data inside HUQAN's own state, read and re-verified on each use.
// If the process is not running, nothing reads it, so it grants nothing; and
// the hook itself exits fail-closed (exit 2) on any error, which every adapter
// enforces as a deny. A crashed HUQAN therefore cuts operations off, it does
// not allow them, and an open window does not survive as blanket permission.
// docs/break-glass-runbook.md states this for an operator.

const crypto = require('node:crypto');
const path = require('node:path');
const { defaultStateRoot } = require('./huqan-state-root');
const { normalizeWorkspaceId } = require('./workspace-id');
const {
  BREAK_GLASS_LEDGER_FILE,
  BREAK_GLASS_ACTIONS,
  createBreakGlassLedger,
} = require('./break-glass-ledger');

const BREAK_GLASS_SCHEMA_VERSION = 'huqan.break-glass.v1';
// One hour is the ceiling: long enough to clear an incident, short enough that
// a window left open is noticed the same day it was opened.
const MAX_WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_MS = 30 * 60 * 1000;
const MAX_USES = 50;
const DEFAULT_USES = 10;
const MAX_TEXT = 256;

function text(value, max = MAX_TEXT) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function defaultBreakGlassDirectory(environment = process.env) {
  const override = text(environment.HUQAN_BREAK_GLASS_DIR);
  return override ? path.resolve(override) : path.join(defaultStateRoot(environment), 'break-glass');
}

/**
 * A window's immutable fields, read back off its `issue` entry. `categories`
 * is always an array (empty means "any category the gate would review"), so a
 * caller never has to distinguish absent from empty.
 */
function windowFromEntry(entry) {
  return Object.freeze({
    windowId: entry.windowId,
    workspaceId: entry.workspaceId,
    agentId: entry.agentId ?? null,
    reason: entry.reason,
    actor: entry.actor,
    operatorIdentity: entry.operatorIdentity ?? null,
    issuedAt: entry.issuedAt,
    expiresAt: entry.expiresAt,
    maxUses: entry.maxUses,
    categories: Array.isArray(entry.categories) ? [...entry.categories] : [],
  });
}

/** A ledger over one directory. */
function createBreakGlass({ directory, environment = process.env, now = () => new Date().toISOString() } = {}) {
  const root = path.resolve(directory || defaultBreakGlassDirectory(environment));
  const {
    readEntries,
    verifyEntries,
    verifyIntegrity,
    withLock,
    appendEntryUnlocked,
    appendEntry,
  } = createBreakGlassLedger(root);

  /**
   * Replay the chain into the state of one window. Returns null when the chain
   * does not verify -- an untrustworthy ledger has no window, which is what
   * makes a tampered file grant nothing.
   */
  function windowState(windowId) {
    const id = text(windowId);
    if (!id) return null;
    const entries = readEntries();
    if (!verifyEntries(entries).ok) return null;
    let window = null;
    let uses = 0;
    let lifted = false;
    for (const entry of entries) {
      if (entry.windowId !== id) continue;
      if (entry.action === 'issue') { window = windowFromEntry(entry); uses = 0; lifted = false; }
      else if (entry.action === 'consume') uses += 1;
      else if (entry.action === 'lift') lifted = true;
    }
    if (!window) return null;
    return { window, uses, lifted, remainingUses: Math.max(0, window.maxUses - uses) };
  }

  function allWindows() {
    const entries = readEntries();
    if (!verifyEntries(entries).ok) return [];
    const ids = [];
    for (const entry of entries) {
      if (entry.action === 'issue' && !ids.includes(entry.windowId)) ids.push(entry.windowId);
    }
    return ids.map((id) => windowState(id)).filter(Boolean);
  }

  /** Issue a window. Requires a reason and an actor; every bound is enforced. */
  function issue({ workspaceId, agentId, reason, actor, operatorIdentity, ttlMs, maxUses, categories, windowId } = {}) {
    const workspace = normalizeWorkspaceId(workspaceId);
    const agent = text(agentId) || null;
    const why = text(reason, MAX_TEXT);
    if (!why) throw new TypeError('a break-glass window needs a reason');
    const who = text(actor);
    if (!who) throw new TypeError('a break-glass window needs the operator who issued it');
    const ttl = ttlMs === undefined ? DEFAULT_WINDOW_MS : ttlMs;
    if (!Number.isInteger(ttl) || ttl <= 0 || ttl > MAX_WINDOW_MS) {
      throw new TypeError(`break-glass ttl must be an integer between 1 and ${MAX_WINDOW_MS} ms`);
    }
    const uses = maxUses === undefined ? DEFAULT_USES : maxUses;
    if (!Number.isInteger(uses) || uses <= 0 || uses > MAX_USES) {
      throw new TypeError(`break-glass maxUses must be an integer between 1 and ${MAX_USES}`);
    }
    const scopedCategories = Array.isArray(categories)
      ? [...new Set(categories.map((entry) => text(entry)).filter(Boolean))]
      : [];
    const id = text(windowId) || crypto.randomUUID();

    const issuedAt = now();
    const expiresAt = new Date(Date.parse(issuedAt) + ttl).toISOString();
    // Existence-check and append under one lock: a second concurrent `issue` for
    // the same id would otherwise append a duplicate-issue chain, which
    // `verifyEntries` then rejects -- corrupting every window, not just the new
    // one.
    const result = withLock(() => {
      const integrity = verifyIntegrity();
      if (!integrity.ok) {
        return Object.freeze({ ok: false, created: false, reason: 'break_glass_integrity_violation', details: integrity });
      }
      const existing = windowState(id);
      if (existing) {
        return Object.freeze({ ok: false, created: false, reason: 'break_glass_window_exists', window: existing.window });
      }
      const entry = appendEntryUnlocked({
        action: 'issue', windowId: id, workspaceId: workspace, agentId: agent,
        actor: who, operatorIdentity: text(operatorIdentity) || null, reason: why,
        issuedAt, expiresAt, maxUses: uses, categories: scopedCategories,
      });
      return Object.freeze({ ok: true, created: true, window: windowFromEntry(entry), ledgerEntry: entry });
    });
    if (!result.locked) return Object.freeze({ ok: false, created: false, reason: 'break_glass_ledger_locked' });
    return result.value;
  }

  /**
   * Whether a window is currently active for this scope and category. Read-only:
   * it consumes nothing. Fail-closed: an unverifiable ledger yields inactive
   * with a named refusal rather than an exception the caller might swallow.
   */
  function check({ windowId, workspaceId, agentId, category } = {}) {
    const integrity = verifyIntegrity();
    if (!integrity.ok) return Object.freeze({ active: false, refusal: 'break_glass_integrity_violation', details: integrity });
    const state = windowState(windowId);
    if (!state) return Object.freeze({ active: false, refusal: 'break_glass_window_not_found' });
    const window = state.window;
    if (state.lifted) return Object.freeze({ active: false, refusal: 'break_glass_window_lifted', window });
    if (!(Date.parse(window.expiresAt) > Date.parse(now()))) return Object.freeze({ active: false, refusal: 'break_glass_window_expired', window });
    if (state.remainingUses <= 0) return Object.freeze({ active: false, refusal: 'break_glass_window_exhausted', window });
    if (window.workspaceId !== normalizeWorkspaceId(workspaceId)) return Object.freeze({ active: false, refusal: 'break_glass_workspace_mismatch', window });
    if (window.agentId && window.agentId !== text(agentId)) return Object.freeze({ active: false, refusal: 'break_glass_agent_mismatch', window });
    const named = text(category);
    // A category-scoped window is narrow on purpose: a call that names no
    // category cannot prove it falls inside the scope, so it is refused rather
    // than allowed by omission.
    if (window.categories.length > 0 && (!named || !window.categories.includes(named))) {
      return Object.freeze({ active: false, refusal: 'break_glass_category_not_permitted', window });
    }
    return Object.freeze({ active: true, window, remainingUses: state.remainingUses });
  }

  /** Record one use of a window. Every use is a ledger entry, by construction. */
  function consume({ windowId, workspaceId, agentId, category, actor, reason } = {}) {
    // The check and the append run under one lock, so two callers cannot both
    // read the same `remainingUses` and spend it. A lock that cannot be taken is
    // a refusal, not a throw: the hook must hold the review rather than crash.
    const result = withLock(() => {
      const integrity = verifyIntegrity();
      if (!integrity.ok) return Object.freeze({ ok: false, consumed: false, reason: 'break_glass_integrity_violation', details: integrity });
      const decision = check({ windowId, workspaceId, agentId, category });
      if (!decision.active) return Object.freeze({ ok: false, consumed: false, reason: decision.refusal });
      appendEntryUnlocked({
        action: 'consume', windowId: decision.window.windowId,
        workspaceId: decision.window.workspaceId, agentId: decision.window.agentId,
        actor: text(actor) || null, reason: text(reason, MAX_TEXT) || null,
        category: text(category) || null, consumedAt: now(),
      });
      return Object.freeze({ ok: true, consumed: true, window: decision.window, remainingUses: decision.remainingUses - 1 });
    });
    if (!result.locked) return Object.freeze({ ok: false, consumed: false, reason: 'break_glass_ledger_locked' });
    return result.value;
  }

  /** End a window before its expiry. Idempotent: a second lift records nothing. */
  function lift({ windowId, actor, reason } = {}) {
    const who = text(actor);
    if (!who) throw new TypeError('lifting a break-glass window needs the operator who lifted it');
    const integrity = verifyIntegrity();
    if (!integrity.ok) return Object.freeze({ ok: false, lifted: false, reason: 'break_glass_integrity_violation', details: integrity });
    const state = windowState(windowId);
    if (!state) return Object.freeze({ ok: false, lifted: false, reason: 'break_glass_window_not_found' });
    if (state.lifted) return Object.freeze({ ok: true, lifted: false, window: state.window });
    appendEntry({
      action: 'lift', windowId: state.window.windowId, actor: who,
      reason: text(reason, MAX_TEXT) || null, liftedAt: now(),
    });
    return Object.freeze({ ok: true, lifted: true, window: state.window });
  }

  /** Every window with its live state, for the operator surface. */
  function status() {
    const integrity = verifyIntegrity();
    if (!integrity.ok) return Object.freeze({ ok: false, reason: 'break_glass_integrity_violation', details: integrity, windows: [] });
    return Object.freeze({
      ok: true,
      windows: allWindows().map((state) => {
        // `status` reports the window's own liveness. `check` refuses a
        // category-less call against a category-scoped window, so pass a
        // category inside its scope; a category-free window is unaffected.
        const decision = check({
          windowId: state.window.windowId,
          workspaceId: state.window.workspaceId,
          agentId: state.window.agentId,
          category: state.window.categories[0],
        });
        return Object.freeze({
          ...state.window,
          uses: state.uses,
          remainingUses: state.remainingUses,
          lifted: state.lifted,
          active: decision.active,
          inactiveReason: decision.active ? null : decision.refusal,
        });
      }),
    });
  }

  return Object.freeze({
    directory: root,
    issue,
    lift,
    consume,
    check,
    status,
    windowState,
    verifyIntegrity,
  });
}

module.exports = {
  BREAK_GLASS_SCHEMA_VERSION,
  BREAK_GLASS_LEDGER_FILE,
  BREAK_GLASS_ACTIONS,
  MAX_WINDOW_MS,
  DEFAULT_WINDOW_MS,
  MAX_USES,
  DEFAULT_USES,
  defaultBreakGlassDirectory,
  createBreakGlass,
};
