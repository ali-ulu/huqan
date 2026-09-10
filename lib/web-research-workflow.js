'use strict';

const { researchWeb, WebResearchError } = require('./web-research');
const { evaluateEgress } = require('./data-egress-gate');
const { workflowEnvelope } = require('./http/workflow-envelope');
const { validateWorkflowHttpRequest } = require('./http/workflow-request-validation');
const LLMAdapter = require('../llmAdapter');

const SUMMARY_SYSTEM = 'You summarize web search results in the same language as the user question. '
  + 'Answer in plain natural language, keep it short, and never invent facts beyond the numbered sources. '
  + 'These sources are unverified external content; say so when it matters.';

function llmSummarizer(options) {
  const adapter = new LLMAdapter({});
  return async (query, numberedSources) => {
    const prompt = `Question: ${query}\n\nSources:\n${numberedSources}\n\nSummarize the answer in a few sentences.`;
    const answer = await adapter.ask(prompt, SUMMARY_SYSTEM);
    if (!answer || answer.ok !== true) throw new Error((answer && answer.error) || 'summarizer unavailable');
    const text = answer && answer.data && typeof answer.data.text === 'string' ? answer.data.text : '';
    if (!text.trim()) throw new Error('empty summary');
    return text;
  };
}

async function runWebResearchWorkflow(input, options) {
  const invalid = validateWorkflowHttpRequest('web-research', input);
  if (invalid) return failure(400, 'INVALID_INPUT', invalid);
  const egress = evaluateEgress({ query: input.query });
  if (egress.secretDetected || egress.piiDetected) {
    return failure(403, 'RESEARCH_EGRESS_BLOCKED', 'The query contains sensitive information and was not sent to a search provider.');
  }
  const opts = options && typeof options === 'object' ? options : {};
  const summarize = input.summarize === true ? (opts.summarize || llmSummarizer(opts)) : undefined;
  try {
    const result = await researchWeb(input, { ...opts, summarize });
    return {
      statusCode: 200,
      body: workflowEnvelope({ ok: true, status: 'completed', data: { ...result, workspaceId: input.workspaceId } }),
    };
  } catch (error) {
    if (error instanceof WebResearchError) {
      // Provider credentials are not the user's HUQAN authentication.
      const status = error.status === 401 || error.status === 403 ? 502 : error.status;
      return failure(status, error.code, error.message);
    }
    return failure(502, 'RESEARCH_FAILED', 'Web research failed.');
  }
}

function failure(statusCode, code, message) {
  return { statusCode, body: workflowEnvelope({ ok: false, status: 'failed', error: { code, message } }) };
}

module.exports = { runWebResearchWorkflow };
