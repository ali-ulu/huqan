'use strict';

// Shared pagination + clone-mode normalizer for the library-level graph read
// primitives (#3012).
//
// The read surface (`lib/graph-node-read.js`, `lib/graph-edge-read.js`,
// `lib/graph-query-read.js`) historically returned unbounded result sets and
// deep-cloned every record on every read. This module gives those primitives
// an optional bounded form without breaking the existing positional call
// shapes:
//
//   getNodes(nodes, 'team')                              // unchanged: all
//   getNodes(nodes, 'team', { limit: 100, offset: 200 }) // bounded
//   getNodes(nodes, { workspaceId: 'team', limit: 100 }) // object form
//   getNodes(nodes, 'team', { clone: false })            // frozen views
//
// Conventions:
// - `limit` defaults to Infinity (unbounded, legacy behavior). Non-integer
//   values are floored; NaN/negative handling clamps to a safe value
//   (negative limit -> 0 results, NaN -> unbounded).
// - `offset` defaults to 0. Negative/NaN offsets clamp to 0.
// - `clone` defaults to true (legacy deep-clone isolation). `clone: false`
// - returns a shallow frozen view: one object spread plus copied top-level
//   list fields, no JSON round-trip of provenance/vector/meta. Nested objects
//   are shared by design, so callers must treat the view as read-only.
// - Pagination follows the underlying collection's iteration order (insertion
//   order for the in-memory JSON backend). Callers needing ranked pages
//   should sort before/after paging.

const { normalizeWorkspaceId } = require('./workspace-id');

function toOptionalInteger(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const num = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.floor(num);
}

function normalizeReadBounds(workspaceArg, optionsArg) {
  let scopeInput = 'default';
  let limit;
  let offset;
  let clone;

  if (workspaceArg && typeof workspaceArg === 'object' && !Array.isArray(workspaceArg)) {
    if (workspaceArg.workspaceId !== undefined) scopeInput = workspaceArg.workspaceId;
    if (workspaceArg.limit !== undefined) limit = workspaceArg.limit;
    if (workspaceArg.offset !== undefined) offset = workspaceArg.offset;
    if (workspaceArg.clone !== undefined) clone = workspaceArg.clone;
  } else if (workspaceArg !== undefined) {
    scopeInput = workspaceArg;
  }

  if (typeof optionsArg === 'number' || typeof optionsArg === 'string') {
    limit = optionsArg;
  } else if (optionsArg && typeof optionsArg === 'object' && !Array.isArray(optionsArg)) {
    // Explicit options win over the object-form workspace argument.
    if (optionsArg.limit !== undefined) limit = optionsArg.limit;
    if (optionsArg.offset !== undefined) offset = optionsArg.offset;
    if (optionsArg.clone !== undefined) clone = optionsArg.clone;
    // `first` is accepted as an alias for `limit` where unambiguous.
    if (limit === undefined && optionsArg.first !== undefined) limit = optionsArg.first;
  }

  const scope = normalizeWorkspaceId(scopeInput);

  let normalizedLimit = toOptionalInteger(limit, Infinity);
  if (normalizedLimit < 0) normalizedLimit = 0;

  let normalizedOffset = toOptionalInteger(offset, 0);
  if (normalizedOffset < 0) normalizedOffset = 0;
  if (!Number.isFinite(normalizedOffset)) normalizedOffset = 0;

  return {
    scope,
    limit: normalizedLimit,
    offset: normalizedOffset,
    clone: clone !== false,
  };
}

function applyReadBounds(list, bounds) {
  const { limit = Infinity, offset = 0 } = bounds || {};
  if (!Array.isArray(list)) return [];
  if (offset <= 0 && limit === Infinity) return list.slice();
  if (limit <= 0) return [];
  return list.slice(offset, offset + limit);
}

module.exports = {
  normalizeReadBounds,
  applyReadBounds,
};
