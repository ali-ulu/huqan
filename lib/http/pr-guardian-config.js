'use strict';

const { readCompatibleEnvironmentVariable } = require('../environment-compat');

function createPrGuardianOptions({ getApprovalStore, getParseJsonRequest, getWriteJson, githubClient } = {}) {
  return {
    getApprovalStore,
    getParseJsonRequest,
    getWriteJson,
    githubClient,
    operatorToken: readCompatibleEnvironmentVariable('MCP_OPERATOR_TOKEN') || '',
    webhookSecret: readCompatibleEnvironmentVariable('GITHUB_APP_WEBHOOK_SECRET') || '',
  };
}

module.exports = Object.freeze({ createPrGuardianOptions });
