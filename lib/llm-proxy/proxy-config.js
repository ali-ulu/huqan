'use strict';

/**
 * LLM proxy configuration (#1908).
 *
 * The proxy speaks the OpenAI wire format so that a company switches only
 * its base URL (`OPENAI_BASE_URL`) and keeps every line of code unchanged.
 * All values come from the environment through environment-compat, never
 * from request content.
 */

const { readCompatibleEnvironmentVariable } = require('../environment-compat');

const DEFAULT_UPSTREAM = 'https://api.openai.com';
const DEFAULT_TIMEOUT_MS = 60000;
const MIN_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 300000;

function resolveProxyConfig(env = process.env) {
  const read = (name) => {
    try {
      return readCompatibleEnvironmentVariable(name, env);
    } catch (_) {
      return undefined;
    }
  };
  const upstreamRaw = read('LLM_PROXY_UPSTREAM') || DEFAULT_UPSTREAM;
  const upstream = String(upstreamRaw).replace(/\/+$/, '');
  const timeoutRaw = Number(read('LLM_PROXY_TIMEOUT_MS'));
  const timeoutMs = Number.isFinite(timeoutRaw)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, timeoutRaw))
    : DEFAULT_TIMEOUT_MS;
  const apiKey = read('LLM_PROXY_API_KEY') || read('OPENAI_API_KEY') || '';
  return Object.freeze({
    upstream,
    timeoutMs,
    apiKey: String(apiKey),
  });
}

module.exports = {
  DEFAULT_UPSTREAM,
  DEFAULT_TIMEOUT_MS,
  resolveProxyConfig,
};
