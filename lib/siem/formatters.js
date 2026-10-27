// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * SIEM format renderers for the canonical `huqan.siem-event.v1` (#4093, PR-B2).
 *
 * PR-B1 fixed the event; this module renders it into the three shapes a
 * collector actually ingests -- ECS, Splunk HEC and CEF -- plus `jsonl`, which
 * is the event itself. Every renderer is pure: it reads the canonical event,
 * copies what it may carry, and returns a new value. Nothing here touches the
 * network, the clock or the filesystem; the sink and cursor that move the
 * rendered line are PR-B3.
 *
 * The scope note's boundary holds here too. A formatter renames and nests; it
 * never invents a field the canonical allowlist does not carry (INV-B2), so a
 * consumer that reads `user.name` and one that reads `huqan.agent.name` are
 * looking at the same already-redacted value. The event arrived scrubbed by
 * AB9, and none of these renderers can re-introduce what was removed.
 *
 * Severity is the one place a formatter derives rather than copies. The scope
 * note leaves it open ("from the risk score or the decision?"); this module
 * derives it from `huqan.risk_score`, because that is the guard's own measured
 * number and the decision is already carried verbatim next to it. The mapping
 * is fixed and documented at `cefSeverity`.
 */

const { SIEM_EVENT_SCHEMA_VERSION, SIEM_EVENT_FIELDS } = require('./siem-event');

const PRODUCT_VERSION = require('../../package.json').version || '0.0.0';

const SIEM_EVENT_FIELD_SET = new Set(SIEM_EVENT_FIELDS);

const SIEM_FORMATS = Object.freeze(['jsonl', 'ecs', 'hec', 'cef']);

const SIEM_FORMATTER_ERRORS = Object.freeze({
  UNSUPPORTED_FORMAT: 'SIEM_UNSUPPORTED_FORMAT',
  INVALID_EVENT: 'SIEM_INVALID_EVENT',
});

const HEC_SOURCE = 'huqan';
const HEC_SOURCETYPE = 'huqan:receipt';
const DEFAULT_HEC_HOST = 'huqan';

// ECS-native keys a renderer adds on top of the canonical event. Anything else
// it emits has to be a canonical key: a rename is allowed, an invention is not.
const ECS_DERIVED_KEYS = Object.freeze(['rule.id', 'user.id', 'user.name', 'huqan.status']);

function formatterError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * A renderer only accepts the shape PR-B1 produces. The schema version is the
 * marker: a bare `{}` or a receipt that skipped the mapper is refused instead
 * of being rendered into a half-empty line a collector would store as truth.
 */
function assertCanonicalEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    throw formatterError(SIEM_FORMATTER_ERRORS.INVALID_EVENT, 'a SIEM formatter needs a canonical event object');
  }
  if (event['huqan.schema_version'] !== SIEM_EVENT_SCHEMA_VERSION) {
    throw formatterError(
      SIEM_FORMATTER_ERRORS.INVALID_EVENT,
      `expected ${SIEM_EVENT_SCHEMA_VERSION}, got ${String(event['huqan.schema_version'])}`,
    );
  }
  const unexpected = Object.keys(event).find((key) => !SIEM_EVENT_FIELD_SET.has(key));
  if (unexpected) {
    throw formatterError(
      SIEM_FORMATTER_ERRORS.INVALID_EVENT,
      `unexpected canonical event field: ${unexpected}`,
    );
  }
  return event;
}

/**
 * ECS (Elastic Common Schema): the fields ECS names are moved to their ECS
 * home, and the rest keep the `huqan.*` namespace the canonical event uses.
 *
 * - the decision becomes `event.outcome` (the scope note's rule), and the
 *   guard's own status -- which is not an ECS outcome -- is kept as
 *   `huqan.status` rather than dropped by the rename;
 * - `huqan.rule.id` is mirrored at `rule.id`;
 * - `huqan.agent.id` / `huqan.agent.name` are mirrored at `user.id` /
 *   `user.name`.
 *
 * The canonical keys stay in place next to their ECS aliases: a consumer may
 * read either, and neither is a new claim.
 */
function toEcs(event) {
  assertCanonicalEvent(event);
  const ecs = { ...event };
  ecs['event.outcome'] = event['huqan.decision'];
  ecs['huqan.status'] = event['event.outcome'];
  ecs['rule.id'] = event['huqan.rule.id'];
  ecs['user.id'] = event['huqan.agent.id'];
  ecs['user.name'] = event['huqan.agent.name'];
  return ecs;
}

/**
 * Splunk HEC envelope. `event` is the canonical event untouched, so the HEC
 * consumer and the JSON Lines consumer read byte-identical payloads. `time` is
 * epoch seconds, which is what HEC expects; an unparseable timestamp is left
 * out rather than sent as `NaN`.
 */
function toHec(event, options = {}) {
  assertCanonicalEvent(event);
  const host = typeof options.host === 'string' && options.host.trim() ? options.host.trim() : DEFAULT_HEC_HOST;
  const envelope = {
    host,
    source: HEC_SOURCE,
    sourcetype: HEC_SOURCETYPE,
    event,
  };
  const millis = Date.parse(event['@timestamp']);
  if (Number.isFinite(millis)) envelope.time = millis / 1000;
  return envelope;
}

/**
 * CEF extension escaping (ArcSight spec): backslash, pipe and equals are
 * escaped with a backslash, and a newline becomes the two characters `\n`.
 * Only those four -- escaping more would corrupt values the spec leaves alone.
 */
function escapeCefValue(value) {
  return String(value)
    .split('\\').join('\\\\')
    .split('|').join('\\|')
    .split('=').join('\\=')
    .split('\n').join('\\n')
    .split('\r').join('\\n');
}

/**
 * CEF severity on the 0-10 scale the format fixes, derived from the 0-100
 * `huqan.risk_score` by `round(risk / 10)` clamped to [0, 10]. A missing or
 * non-finite score reads as 0, not as a guess at the decision.
 */
function cefSeverity(event) {
  const score = Number(event['huqan.risk_score']);
  if (!Number.isFinite(score)) return 0;
  return Math.min(10, Math.max(0, Math.round(score / 10)));
}

/**
 * CEF:0 line. The header is `CEF:0|HUQAN|huqan|<version>|<receiptKind>|<decision>|<severity>|`
 * and the extension carries the same allowlisted facts as key=value pairs. The
 * header fields are escaped with the same rule as the extension, because a
 * receipt kind or a decision that carried a pipe would otherwise split the
 * header into the wrong columns.
 */
function toCef(event) {
  assertCanonicalEvent(event);
  const header = [
    'CEF:0',
    'HUQAN',
    'huqan',
    escapeCefValue(PRODUCT_VERSION),
    escapeCefValue(event['huqan.receipt.kind']),
    escapeCefValue(event['huqan.decision']),
    String(cefSeverity(event)),
  ].join('|');

  const extension = [
    `rt=${Date.parse(event['@timestamp']) || 0}`,
    `msg=${escapeCefValue(event['huqan.reason'])}`,
    `huqanEventId=${escapeCefValue(event['event.id'])}`,
    `huqanEventKind=${escapeCefValue(event['event.kind'])}`,
    `huqanEventAction=${escapeCefValue(event['event.action'])}`,
    `huqanStatus=${escapeCefValue(event['event.outcome'])}`,
    `huqanReceiptHash=${escapeCefValue(event['huqan.receipt.hash'])}`,
    `huqanRiskScore=${escapeCefValue(event['huqan.risk_score'])}`,
    `huqanRuleId=${escapeCefValue(event['huqan.rule.id'])}`,
    `huqanPolicyVersion=${escapeCefValue(event['huqan.policy_version'])}`,
    `huqanAgentId=${escapeCefValue(event['huqan.agent.id'])}`,
    `huqanAgentName=${escapeCefValue(event['huqan.agent.name'])}`,
    `huqanWorkspaceId=${escapeCefValue(event['huqan.workspace_id'])}`,
    `huqanToolName=${escapeCefValue(event['huqan.tool.name'])}`,
    `huqanToolKind=${escapeCefValue(event['huqan.tool.kind'])}`,
    `huqanInputDigest=${escapeCefValue(event['huqan.input_digest'])}`,
    `huqanRedacted=${event['huqan.redacted'] === true}`,
    `huqanSchemaVersion=${escapeCefValue(event['huqan.schema_version'])}`,
  ];
  // Host only, and only when the event named one -- the same rule the mapper
  // uses, so a CEF consumer cannot read a destination the event does not carry.
  if (typeof event['huqan.destination.host'] === 'string' && event['huqan.destination.host']) {
    extension.push(`huqanDestinationHost=${escapeCefValue(event['huqan.destination.host'])}`);
  }

  return `${header}|${extension.join(' ')}`;
}

/**
 * The single entry point the sink (PR-B3) calls: render one canonical event
 * into the line the chosen format writes. `jsonl`, `ecs` and `hec` return a
 * JSON string; `cef` returns the CEF line. An unknown format is refused rather
 * than silently defaulted, so a misconfigured sink fails loudly at the first
 * event instead of writing a format nobody asked for.
 */
function formatSiemEvent(event, format) {
  switch (format) {
    case 'jsonl': return JSON.stringify(assertCanonicalEvent(event));
    case 'ecs': return JSON.stringify(toEcs(event));
    case 'hec': return JSON.stringify(toHec(event));
    case 'cef': return toCef(event);
    default:
      throw formatterError(SIEM_FORMATTER_ERRORS.UNSUPPORTED_FORMAT, `unsupported SIEM format: ${String(format)}`);
  }
}

module.exports = {
  SIEM_FORMATS,
  SIEM_FORMATTER_ERRORS,
  ECS_DERIVED_KEYS,
  toEcs,
  toHec,
  toCef,
  formatSiemEvent,
};
