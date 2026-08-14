'use strict';

const { handleGitHubAppPullRequestWebhook } = require('./github-app-beta-handler');
const { runGitHubAppStreamingTrust } = require('./github-app-streaming-trust');

async function handleGitHubAppStreamingTrustWebhook({
  headers,
  rawBody,
  webhookSecret,
  c7Store,
  c8Store,
  appId,
  privateKey,
  fetchImpl = globalThis.fetch,
  nowMs = Date.now(),
}) {
  const observation = handleGitHubAppPullRequestWebhook({
    headers,
    rawBody,
    webhookSecret,
    store: c7Store,
    nowMs,
  });
  const trust = await runGitHubAppStreamingTrust({
    c7Result: observation,
    appId,
    privateKey,
    store: c8Store,
    fetchImpl,
    nowMs,
  });
  return Object.freeze({ observation, trust });
}

module.exports = {
  handleGitHubAppStreamingTrustWebhook,
};
