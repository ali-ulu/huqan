'use strict';

// Provenance / trust-receipt query surface — thin re-export facade.
//
// The implementation lives in focused modules (#2162):
// - provenance-query-shapes.js        shared helpers + shape normalizers
// - provenance-query-query-helpers.js filter/workspace/sort helpers
// - provenance-query-records.js       node/edge/candidate record collection
// - provenance-query-audit-page.js    bounded audit page + candidate queries
// - provenance-query-trust-receipt.js trust-graph query + receipt building
//
// The original paths and export names are unchanged: every existing
// require('.../provenance-query') call site keeps working as-is.

const {
  normalizeTrustReceipt,
} = require('./provenance-query-shapes');
const {
  queryAuditTrailPage,
  queryCandidateClaims,
} = require('./provenance-query-audit-page');
const {
  queryProvenance,
} = require('./provenance-query-records');
const {
  buildTrustReceipt,
  queryAuditTrail,
  queryTrustGraph,
} = require('./provenance-query-trust-receipt');

module.exports = {
  buildTrustReceipt,
  normalizeTrustReceipt,
  queryAuditTrail,
  queryAuditTrailPage,
  queryCandidateClaims,
  queryProvenance,
  queryTrustGraph,
};
