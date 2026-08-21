'use strict';

const policy = require('./policy');
const snapshot = require('./snapshot');
const { createReviewService, TOOL } = require('./review-service');
const { createGitHubRestClient } = require('./github-client');

module.exports = Object.freeze({
  ...policy,
  ...snapshot,
  TOOL,
  createReviewService,
  createGitHubRestClient,
});
