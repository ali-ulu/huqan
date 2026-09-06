'use strict';

/**
 * #1891 — durable audit trail for inter-agent delegation and task handoff.
 *
 * The A2A boundary already decides these exchanges, and after #1891 was
 * measured the decisions were the only thing that survived them:
 *
 * - An **admitted** exchange writes `<taskId>.completed` via
 *   `lib/a2a/task-store.js`. That record exists to answer "did my effect run",
 *   and it carries the exchange id and the firewall receipt metadata — but not
 *   who handed what to whom. The delegator, the delegate, the delegation chain
 *   and the requested capability are all verified by
 *   `lib/a2a/bounded-exchange.js` and then dropped. It is also lookup-by-id
 *   only: an operator holding a task id can read one row, and an operator
 *   asking "what was delegated here today" has nothing to open.
 * - A **refused** exchange writes nothing at all. `firewallRefusal` and
 *   `evaluatorRefusal` build an HTTP body and return it. A rejected attempt to
 *   delegate authority — the event an auditor most wants — left no trace on
 *   disk anywhere.
 *
 * So this is the missing write, and it is deliberately only the write. It
 * records both outcomes, because a trail that holds admissions and discards
 * refusals answers "what did we allow" and silently mis-answers "what was
 * attempted".
 *
 * ## Same directory, same lifetime
 *
 * Written alongside the replay reservations and task records for the reason
 * `lib/a2a/exchange-route.js` already gives for the task store: this is the
 * audit half of the same exchange, not a separate subsystem with its own
 * lifetime and its own way of being misconfigured.
 *
 * ## Identifiers, not payloads
 *
 * Every recorded field is an identifier, a capability name, a risk tier or a
 * decision reason. The requested action's parameters are not written: the
 * envelope carries them as `parametersHash` and nothing here needs to widen
 * that. An audit trail that accumulated request bodies would become a second
 * copy of the data the egress gates exist to control.
 *
 * ## What this does NOT claim
 *
 * Recording never fails an exchange. `append` returns null on every error
 * path, which is the stance `lib/sandbox-escape-ledger.js` takes for the same
 * shape of write and the opposite of the one `task-store.js` takes for its
 * completion record. The difference is deliberate: an unwritten task record
 * means an effect is unaccounted for and must read as `unknown`, while an
 * unwritten audit row means the trail is incomplete — and turning an audit
 * failure into a refused delegation would make the observer a new way for the
 * boundary to go down.
 *
 * That is a real gap and it is not papered over: `read` reports `unreadable`
 * alongside the entries, so "how many rows could not be parsed" is an answer
 * an operator can get rather than a silence they have to trust.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const DELEGATION_AUDIT_VERSION = 'huqan.a2a-delegation-audit.v1';
const DELEGATION_AUDIT_SUFFIX = '.delegation';

/** Bounds every persisted string so one oversized envelope cannot inflate a row. */
const MAX_FIELD_CHARS = 256;
const MAX_CHAIN_ITEMS = 16;
const MAX_RECORD_BYTES = 16 * 1024;
/** Default read bound. An audit directory grows without limit; a reader must not. */
const DEFAULT_READ_LIMIT = 200;

const DELEGATION_OUTCOMES = Object.freeze({
  ADMITTED: 'admitted',
  REFUSED: 'refused',
});

function text(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return trimmed.length > MAX_FIELD_CHARS ? trimmed.slice(0, MAX_FIELD_CHARS) : trimmed;
}

function chainOf(value) {
  if (!Array.isArray(value)) return [];
  return value.map(text).filter(Boolean).slice(0, MAX_CHAIN_ITEMS);
}

/**
 * Project an exchange request plus its outcome into the row that gets written.
 *
 * Exported so a caller can be tested against the recorded shape without a
 * filesystem, and so the projection has exactly one definition rather than one
 * here and one in the route.
 *
 * @param {object} input
 * @param {object} input.request the exchange envelope as received
 * @param {string} input.outcome one of DELEGATION_OUTCOMES
 * @param {string} input.decision the boundary's decision token
 * @param {string} input.reason why
 * @param {string} [input.taskId] present only for an admitted exchange
 * @param {string} [input.recordedAt] ISO instant; defaults to now
 */
function delegationAuditEntry({ request, outcome, decision, reason, taskId, recordedAt } = {}) {
  const envelope = request && typeof request === 'object' && !Array.isArray(request) ? request : {};
  const source = envelope.source && typeof envelope.source === 'object' ? envelope.source : {};
  const target = envelope.target && typeof envelope.target === 'object' ? envelope.target : {};
  const delegation = envelope.delegation && typeof envelope.delegation === 'object'
    ? envelope.delegation : {};
  const action = envelope.requestedAction && typeof envelope.requestedAction === 'object'
    ? envelope.requestedAction : {};
  const chain = chainOf(delegation.chain);

  return Object.freeze({
    auditVersion: DELEGATION_AUDIT_VERSION,
    recordedAt: text(recordedAt) || new Date().toISOString(),
    outcome: outcome === DELEGATION_OUTCOMES.ADMITTED
      ? DELEGATION_OUTCOMES.ADMITTED
      : DELEGATION_OUTCOMES.REFUSED,
    // Empty rather than a placeholder: a refusal can happen before the envelope
    // is trusted, and inventing an agent id for an unverified field would put a
    // name in an audit trail that nothing verified.
    exchangeId: text(envelope.exchangeId),
    workspaceId: text(envelope.workspaceId),
    delegatorId: text(source.agentId),
    delegateId: text(target.agentId),
    delegationChain: Object.freeze(chain),
    // Counted from the signed hops, not from the chain: the chain is a claim
    // about lineage and the hops are what carried a signature.
    hopCount: Array.isArray(delegation.hops) ? delegation.hops.length : 0,
    capability: text(action.capability),
    riskTier: text(action.riskTier),
    decision: text(decision),
    reason: text(reason),
    taskId: text(taskId) || null,
  });
}

/**
 * Open the append-only delegation audit log rooted at `directory`.
 *
 * Same directory checks as the replay and task stores: a symlinked or
 * non-canonical path is refused at construction rather than followed.
 */
function createA2aDelegationAuditLog(directory) {
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error('A2A delegation audit directory must be a real directory');
  }

  return Object.freeze({ append, read });

  /**
   * Append one delegation event.
   *
   * One file per event, exclusive-create, matching the replay and task stores.
   * A single shared log file would need append atomicity this codebase does not
   * assume on every platform, and a partially interleaved audit row is worse
   * than a missing one because it still looks like evidence.
   *
   * The name is `<ms since epoch>-<uuid>` so a directory listing sorts into
   * write order without opening anything, and carries no colons — an ISO
   * instant is not a legal Windows filename.
   *
   * @returns {object|null} the written entry, or null when nothing was written
   */
  function append(input) {
    let entry;
    try {
      entry = delegationAuditEntry(input);
      const payload = JSON.stringify(entry);
      if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) return null;
      const name = `${String(Date.now()).padStart(15, '0')}-${crypto.randomUUID()}${DELEGATION_AUDIT_SUFFIX}`;
      const target = path.join(root, name);
      let descriptor;
      try {
        descriptor = fs.openSync(target, 'wx', 0o600);
        fs.writeFileSync(descriptor, payload, 'utf8');
        fs.fsyncSync(descriptor);
      } finally {
        if (descriptor !== undefined) fs.closeSync(descriptor);
      }
      return entry;
    } catch (_) {
      // Deliberately swallowed: see the module note. Observation must not become
      // a new way for the A2A boundary to refuse an exchange.
      return null;
    }
  }

  /**
   * Read recorded delegation events, newest last, bounded.
   *
   * @param {object} [options]
   * @param {number} [options.limit] most recent N rows (default 200)
   * @returns {{entries: object[], unreadable: number}} `unreadable` counts rows
   *   that exist on disk but could not be parsed — reported rather than
   *   dropped, so an incomplete trail is visible as incomplete.
   */
  function read({ limit = DEFAULT_READ_LIMIT } = {}) {
    const bound = Number.isInteger(limit) && limit > 0 ? limit : DEFAULT_READ_LIMIT;
    let names;
    try {
      names = fs.readdirSync(root).filter((name) => name.endsWith(DELEGATION_AUDIT_SUFFIX));
    } catch (_) {
      return Object.freeze({ entries: Object.freeze([]), unreadable: 0 });
    }
    names.sort();
    const selected = names.slice(-bound);

    const entries = [];
    let unreadable = 0;
    for (const name of selected) {
      let parsed;
      try {
        parsed = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'));
      } catch (_) {
        unreadable += 1;
        continue;
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)
          || parsed.auditVersion !== DELEGATION_AUDIT_VERSION) {
        unreadable += 1;
        continue;
      }
      entries.push(Object.freeze(parsed));
    }
    return Object.freeze({ entries: Object.freeze(entries), unreadable });
  }
}

module.exports = Object.freeze({
  DELEGATION_AUDIT_VERSION,
  DELEGATION_AUDIT_SUFFIX,
  DELEGATION_OUTCOMES,
  MAX_RECORD_BYTES,
  delegationAuditEntry,
  createA2aDelegationAuditLog,
});
