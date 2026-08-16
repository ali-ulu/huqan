'use strict';

/**
 * Capability negotiation (P0-D).
 *
 * P0-C added an Agent Card, which *advertises*. This adds the step after it: a
 * caller states what it supports, and the receiver answers with what the two of
 * them actually have in common. Advertising and agreeing are different things,
 * which is why the P0 scope freeze kept them as separate units.
 *
 * The offer is not assembled here. `CAPABILITIES` and `PROTOCOL_VERSION` are
 * imported from `./agent-card`, so the set this module can agree to is
 * character-for-character the set the card advertises. A second table would let
 * negotiation promise something the card never mentioned, or -- worse -- agree
 * to a capability whose route does not exist.
 *
 * Three properties are load-bearing, and each one is a way a negotiator could
 * otherwise be turned into an escalation primitive:
 *
 *   1. **The receiver's offer is receiver-owned.** Descriptors in the agreement
 *      are the frozen table's objects. Nothing is echoed back from the request,
 *      so a caller cannot negotiate itself a `path` or a `method`.
 *   2. **Agreement is intersection, never union.** The result is always a subset
 *      of what the receiver offers. Asking for more cannot widen it.
 *   3. **Fail-closed.** No common protocol version, or no common capability, is
 *      a refusal. There is no "agree on nothing and continue" outcome, because a
 *      caller that treated an empty agreement as success would proceed believing
 *      it had negotiated something.
 *
 * Negotiation is deliberately stateless: it returns an agreement, it does not
 * open a session. Anything that remembers a negotiation across requests is a
 * task lifecycle, which is P0-E.
 */

const { CAPABILITIES, SUPPORTED_PROTOCOL_VERSIONS } = require('./agent-card');

const MAX_LIST_ITEMS = 32;
const MAX_STRING_LENGTH = 128;

const NEGOTIATION_ERRORS = Object.freeze({
  SHAPE: 'negotiation_request_invalid',
  PROTOCOL: 'negotiation_no_common_protocol_version',
  CAPABILITY: 'negotiation_no_common_capability',
});

function boundedStringList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_LIST_ITEMS) return null;
  const out = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length < 1 || entry.length > MAX_STRING_LENGTH) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}

function refusal(reason) {
  return Object.freeze({ decision: 'block', reason });
}

/**
 * Negotiate an agreement, or refuse.
 *
 * An empty `capabilities` list is a refusal rather than a shorthand for "send
 * everything you have". Requiring the caller to name what it wants keeps this
 * from becoming a capability dump, and the caller already has the names: it read
 * them off the Agent Card.
 *
 * @returns {{ decision: 'allow'|'block', reason: string, agreement?: object }}
 */
function negotiateCapabilities(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    return refusal(NEGOTIATION_ERRORS.SHAPE);
  }

  const requestedVersions = boundedStringList(request.protocolVersions);
  const requestedCapabilities = boundedStringList(request.capabilities);
  if (!requestedVersions || !requestedCapabilities) return refusal(NEGOTIATION_ERRORS.SHAPE);

  // Receiver preference decides, not caller order: a caller cannot steer the
  // agreement onto a version this receiver would rather not speak by listing it
  // first.
  const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.find((version) => requestedVersions.includes(version));
  if (!protocolVersion) return refusal(NEGOTIATION_ERRORS.PROTOCOL);

  // Filtering the frozen table -- rather than mapping over the request -- is
  // what keeps the agreement a subset of the offer and keeps every descriptor
  // receiver-owned.
  const agreed = CAPABILITIES.filter((capability) => requestedCapabilities.includes(capability.id));
  if (agreed.length < 1) return refusal(NEGOTIATION_ERRORS.CAPABILITY);

  const offeredIds = CAPABILITIES.map((capability) => capability.id);
  const declined = requestedCapabilities.filter((id) => !offeredIds.includes(id));

  return Object.freeze({
    decision: 'allow',
    reason: 'ok',
    agreement: Object.freeze({
      protocolVersion,
      capabilities: Object.freeze(agreed),
      // Named, not silently dropped. A caller that asked for six capabilities
      // and got two should be able to see which four it did not get without
      // diffing the lists itself.
      declined: Object.freeze(declined),
    }),
  });
}

module.exports = Object.freeze({
  MAX_LIST_ITEMS,
  MAX_STRING_LENGTH,
  NEGOTIATION_ERRORS,
  SUPPORTED_PROTOCOL_VERSIONS,
  negotiateCapabilities,
});
