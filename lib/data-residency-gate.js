'use strict';

/**
 * AB12 — data residency.
 *
 * AB9 already knows when an outbound payload carries citizen data: it
 * validates TCKN check digits, IBANs and card numbers, and reports the types
 * it found. What nothing asked was *where the payload was going*. A TCKN sent
 * to a foreign object store and a TCKN written to a local file produced the
 * same verdict, and both produced the same verdict as an unclassified command
 * carrying nothing at all -- `review`.
 *
 * That gap matters because "review" is not enforcement. Under KVKK Art. 9 (and
 * GDPR Ch. V) a cross-border transfer of personal data is not a decision an
 * operator should be able to nod through in a queue at 3am; it is the one that
 * has to be impossible without a written, deliberate policy change. This gate
 * is what turns the existing detection into a boundary.
 *
 * ## The rule
 *
 *   citizen PII in the payload  ×  destination outside the declared residency
 *   -> block
 *
 * Both halves are required. PII with no destination outside residency is
 * AB9's business and stays a review. A foreign destination carrying no
 * personal data is an ordinary egress and this gate says nothing about it.
 *
 * ## Inert unless a deployment declares residency
 *
 * With no `dataResidency` in the policy file this gate returns `allow` and
 * changes nothing, so an existing installation behaves exactly as before. A
 * residency rule is a legal commitment about a jurisdiction; inventing a
 * default for one would be inventing a legal position on the operator's
 * behalf.
 *
 * ## Fail closed on an unreadable destination
 *
 * If the payload carries citizen PII and residency is declared but the
 * destination cannot be determined, the answer is `block`. "I could not tell
 * where this was going" is not evidence that it was going somewhere allowed,
 * and the alternative -- allowing on ignorance -- is the failure this gate
 * exists to prevent.
 *
 * ## Only ever tightens
 *
 * This gate returns `allow` or `block`. It never returns a verdict that could
 * relax another gate's decision: `mergeDecision` takes the strictest, so an
 * action already blocked by AB1 or the workspace boundary stays blocked
 * whatever this says.
 */

const AB12_GATE_VERSION = 'huqan.data-residency-gate.v1';

const DATA_RESIDENCY_DECISIONS = Object.freeze({
  ALLOW: 'allow',
  BLOCK: 'block',
});

const DATA_RESIDENCY_REASONS = Object.freeze({
  NOT_CONFIGURED: 'data_residency_not_configured',
  NO_PROTECTED_DATA: 'data_residency_no_protected_data',
  WITHIN_RESIDENCY: 'data_residency_within_boundary',
  VIOLATION: 'data_residency_violation',
  DESTINATION_UNKNOWN: 'data_residency_destination_unknown',
});

/**
 * Destinations that never leave the machine.
 *
 * Loopback and the unspecified address are local by definition, so a
 * deployment does not have to enumerate them to keep its own services working.
 */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '[::1]']);

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Every host this action could send data to.
 *
 * Deliberately over-collects: a destination this cannot parse is reported as
 * unknown rather than skipped, because a missed destination is an allowed
 * transfer.
 */
function collectDestinations(payload) {
  const hosts = new Set();
  let unparseable = false;

  const fromUrl = (value) => {
    const raw = text(value);
    if (!raw) return;
    try {
      hosts.add(new URL(raw).hostname.toLowerCase());
    } catch (_) {
      unparseable = true;
    }
  };

  const scan = (value) => {
    const raw = text(value);
    if (!raw) return;

    // Bare URLs anywhere in a command string.
    for (const match of raw.matchAll(/\bhttps?:\/\/[^\s'"`;|&)]+/gi)) fromUrl(match[0]);

    // scp/rsync/ssh, in the two shapes that actually name a remote: `user@host`
    // and `host:path`. A bare dotted token is deliberately NOT a destination --
    // `scp -i k.pem veri.csv user@host:/d/` would otherwise report `k.pem` and
    // `veri.csv` as hosts, and since an unrecognised host is a violation, a
    // filename would block a transfer to a perfectly compliant destination.
    // False blocks are how a guard gets switched off; URLs are covered above.
    for (const match of raw.matchAll(/(?:^|\s)[\w.+-]+@([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
      hosts.add(match[1].toLowerCase());
    }
    for (const match of raw.matchAll(/(?:^|\s)([a-z0-9.-]+\.[a-z]{2,}):(?!\/\/)[^\s]*/gi)) {
      hosts.add(match[1].toLowerCase());
    }

    // Cloud object-store schemes name a bucket, not a host. The bucket is the
    // destination as far as residency is concerned, so it is reported under
    // its scheme rather than silently dropped.
    for (const match of raw.matchAll(/\b(s3|gs|azblob|abfss?):\/\/([^\s/'"`]+)/gi)) {
      hosts.add(`${match[1].toLowerCase()}://${match[2].toLowerCase()}`);
    }
  };

  scan(payload && payload.url);
  scan(payload && payload.uri);
  scan(payload && payload.endpoint);
  scan(payload && payload.targetUrl);
  scan(payload && payload.command);
  scan(payload && payload.cmd);
  scan(payload && payload.script);

  return { hosts: [...hosts].sort(), unparseable };
}

/**
 * Is this destination inside the declared residency?
 *
 * A policy entry matches a host exactly or as a dot-anchored suffix, so
 * `example.com.tr` covers `s3.example.com.tr` but never `notexample.com.tr`.
 */
function withinResidency(host, allowed) {
  if (LOCAL_HOSTS.has(host)) return true;
  return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`) || host === `${entry}`);
}

function normalizeAllowed(residency) {
  const list = residency && Array.isArray(residency.allowedDestinations)
    ? residency.allowedDestinations
    : [];
  return list.map((entry) => text(entry).toLowerCase()).filter(Boolean);
}

/**
 * @param {object} input
 * @param {object} input.payload the action's arguments
 * @param {boolean} input.piiDetected AB9's finding; this gate does not re-detect
 * @param {string[]} [input.piiTypes] AB9's classification, carried into the receipt
 * @param {object|null} [input.residency] `{ allowedDestinations: string[] }`
 * @returns {{decision: string, reason: string, destinations: string[], piiTypes: string[], gateVersion: string}}
 */
function evaluateDataResidency({ payload, piiDetected, piiTypes = [], residency = null } = {}) {
  const base = { destinations: [], piiTypes: [...piiTypes], gateVersion: AB12_GATE_VERSION };
  const allowed = normalizeAllowed(residency);

  // No declared residency: the operator has not made a jurisdictional
  // commitment, and this gate will not invent one for them.
  if (allowed.length === 0) {
    return { ...base, decision: DATA_RESIDENCY_DECISIONS.ALLOW, reason: DATA_RESIDENCY_REASONS.NOT_CONFIGURED };
  }

  // No protected data: an ordinary egress, and not this gate's business.
  if (!piiDetected) {
    return { ...base, decision: DATA_RESIDENCY_DECISIONS.ALLOW, reason: DATA_RESIDENCY_REASONS.NO_PROTECTED_DATA };
  }

  const { hosts, unparseable } = collectDestinations(payload);
  const outside = hosts.filter((host) => !withinResidency(host, allowed));

  if (outside.length > 0) {
    return {
      ...base,
      decision: DATA_RESIDENCY_DECISIONS.BLOCK,
      reason: DATA_RESIDENCY_REASONS.VIOLATION,
      destinations: outside,
    };
  }

  // Citizen data, residency declared, and no destination anyone could read.
  // Allowing here would mean allowing on ignorance.
  if (unparseable) {
    return { ...base, decision: DATA_RESIDENCY_DECISIONS.BLOCK, reason: DATA_RESIDENCY_REASONS.DESTINATION_UNKNOWN };
  }

  return {
    ...base,
    decision: DATA_RESIDENCY_DECISIONS.ALLOW,
    reason: DATA_RESIDENCY_REASONS.WITHIN_RESIDENCY,
    destinations: hosts,
  };
}

module.exports = {
  AB12_GATE_VERSION,
  DATA_RESIDENCY_DECISIONS,
  DATA_RESIDENCY_REASONS,
  LOCAL_HOSTS,
  collectDestinations,
  withinResidency,
  evaluateDataResidency,
};
