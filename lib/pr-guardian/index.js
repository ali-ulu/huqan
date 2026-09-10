'use strict';

const policy = require('./policy');
const snapshot = require('./snapshot');
const derivationCheck = require('./derivation-check');
const derivationFetch = require('./derivation-fetch');
const { createReviewService, TOOL } = require('./review-service');
const { createGitHubRestClient } = require('./github-client');

module.exports = Object.freeze({
  ...policy,
  ...snapshot,
  // Part of the Guardian surface even though policy.js does not import it:
  // the policy stays a pure function over a snapshot, so whoever assembles
  // that snapshot is the one who computes this signal.
  ...derivationCheck,
  ...derivationFetch,
  TOOL,
  createReviewService,
  createGitHubRestClient,
});
