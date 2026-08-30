'use strict';

function queueCliLearnReview({ kernel, approvalRuntime, callTool }, args) {
  const approvalArguments = {
    text: String(args || '').trim(),
    workspaceId: 'default',
    provenance: {
      sourceType: 'user',
      sourceSubType: 'cli.learn',
      sourceRef: 'cli:learn',
      sourceTitle: 'CLI learn review candidate',
      actor: 'cli-user',
      workspaceId: 'default',
    },
  };
  return callTool(kernel, { name: 'huqan.learn', arguments: approvalArguments }, approvalRuntime());
}

module.exports = { queueCliLearnReview };
