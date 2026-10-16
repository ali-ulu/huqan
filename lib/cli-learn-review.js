'use strict';

const fs = require('node:fs');
const { resolveCliReadPath } = require('./cli-helpers');

/**
 * Queue the review proposal a `learn:`-family CLI command lands on when the
 * gate returns `review`.
 *
 * The proposal carries the *content* that will be learned, not the argument
 * text. For `learn:` the two are the same. For `upload:`/`yükle:` the argument
 * is a file path, so the file is read here first -- otherwise the durable
 * approval replays the path string as if it were a fact, reports success, and
 * learns nothing (#3644). Reading through `resolveCliReadPath` keeps the same
 * root confinement every other CLI file read uses.
 *
 * @param {object} deps
 * @param {string} args the parsed command argument (fact text, or a file path)
 * @param {object} [opts]
 * @param {boolean} [opts.readFile] treat `args` as a file path to load
 * @returns {object} the MCP proposal result
 */
function queueCliLearnReview({ kernel, approvalRuntime, callTool }, args, opts = {}) {
  const readFile = opts.readFile === true;
  const text = readFile
    ? fs.readFileSync(resolveCliReadPath(args), 'utf8')
    : String(args || '').trim();
  const approvalArguments = {
    text,
    workspaceId: 'default',
    provenance: {
      sourceType: 'user',
      sourceSubType: readFile ? 'cli.yukle' : 'cli.learn',
      sourceRef: readFile ? `cli:yükle:${args}` : 'cli:learn',
      sourceTitle: readFile ? 'CLI upload review candidate' : 'CLI learn review candidate',
      actor: 'cli-user',
      workspaceId: 'default',
    },
  };
  return callTool(kernel, { name: 'huqan.learn', arguments: approvalArguments }, approvalRuntime());
}

module.exports = { queueCliLearnReview };
