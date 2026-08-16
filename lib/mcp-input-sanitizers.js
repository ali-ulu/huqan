'use strict';

const crypto = require('crypto');
const { canonicalMcpToolName } = require('./mcp-tool-names');
const { scrubSecrets } = require('./secret-scrub-gate');

const MCP_MAX_TEXT = 2_000;
const MCP_MAX_GOAL = 500;
const MCP_MAX_SHORT = 256;

function sanitizeMcpString(val, maxLen = MCP_MAX_SHORT) {
  if (typeof val !== 'string') return '';
  return val.slice(0, maxLen).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim();
}

function boundedMcpInteger(value, fallback, minimum, maximum) {
  const integer = Number.isInteger(value) ? value : fallback;
  return Math.min(Math.max(minimum, integer), maximum);
}

// #615: this used to collapse ANY unrecognized value -- including a
// raw/malicious client's explicit `decision: "banana"` -- to 'approved',
// the most privileged branch. It now returns null for anything that isn't
// approve/approved/reject/rejected (after trim+lowercase), so an invalid
// but present value fails closed instead of silently approving. The caller
// is responsible for supplying the 'approved' default when the field is
// genuinely absent, not when it was provided and empty/invalid.
function sanitizeMcpApprovalDecision(value) {
  const decision = sanitizeMcpString(value, 16).toLowerCase();
  if (decision === 'approve') return 'approved';
  if (decision === 'reject') return 'rejected';
  if (decision === 'approved' || decision === 'rejected') return decision;
  return null;
}

function sanitizeToolArgsForStorage(name, args = {}) {
  // Resolved through RFC-001's alias table: a legacy `axiom.learn` call must
  // get exactly the same argument handling as the canonical `huqan.learn`,
  // and a stored approval written before the rename still carries the legacy
  // spelling in `tool`.
  if (canonicalMcpToolName(name) === 'huqan.learn') {
    // huqan.learn's `text` is user-authored knowledge content, not a
    // credential transport — AB7 scrubbing does not apply here, matching
    // the huqan.learn use case.
    const clean = {
      text: sanitizeMcpString(args.text, MCP_MAX_TEXT),
      skipConflicts: args.skipConflicts !== false,
    };
    if (args.maxSentences !== undefined) clean.maxSentences = args.maxSentences;
    if (typeof args.workspaceId === 'string' && args.workspaceId.trim()) {
      clean.workspaceId = sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT);
    }
    if (args.provenance && typeof args.provenance === 'object' && !Array.isArray(args.provenance)) {
      const provenance = {};
      for (const key of ['provenanceId', 'sourceRef', 'sourceTitle', 'sourceType', 'sourceSubType', 'actor', 'timestamp']) {
        if (typeof args.provenance[key] === 'string' && args.provenance[key].trim()) {
          provenance[key] = sanitizeMcpString(args.provenance[key], MCP_MAX_SHORT);
        }
      }
      if (typeof args.provenance.confidence === 'number' && Number.isFinite(args.provenance.confidence)) {
        provenance.confidence = args.provenance.confidence;
      }
      if (Object.keys(provenance).length > 0) clean.provenance = provenance;
    }
    return clean;
  }
  const clean = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (typeof value === 'string') clean[key] = sanitizeMcpString(value, MCP_MAX_TEXT);
    else if (value === null || ['boolean', 'number'].includes(typeof value)) clean[key] = value;
  }
  // AB7: redact secret-looking values (by key name or value shape) before
  // this ever reaches a persisted approval record or dry-run response.
  return scrubSecrets(clean).scrubbed;
}

function nowMs() {
  return Date.now();
}

function newApprovalId() {
  if (typeof crypto.randomUUID === 'function') return `approval-${crypto.randomUUID()}`;
  return `approval-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

module.exports = {
  MCP_MAX_TEXT,
  MCP_MAX_GOAL,
  MCP_MAX_SHORT,
  sanitizeMcpString,
  boundedMcpInteger,
  sanitizeMcpApprovalDecision,
  sanitizeToolArgsForStorage,
  nowMs,
  newApprovalId,
};
