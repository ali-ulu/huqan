const LLMAdapter = require('../llmAdapter');
// #2120: state, query and ingest live in plugins/company-brain-*.js; this
// file keeps the plugin capability wiring and the public surface
// (module.exports shape) unchanged.
const { ensureCompanyState, trackError, getIngestStatus } = require('./company-brain-state');
const { queryCompanyBrain } = require('./company-brain-query');
const { ingestManual, ingestDecision, ingestApi } = require('./company-brain-ingest');

function createCompanyBrainPlugin() {
  return {
    name: 'company-brain',
    version: '0.1.0',
    requires: ['graph', 'companyMode'],
    optional: ['llm', 'temporal', 'evidenceRanking', 'contradictionDetection'],
    capabilities: [
      {
        name: 'companyBrain',
        command: 'company-brain',
        description: 'Handles company memory manual ingest, decision logs, and graph-backed company queries.',
      },
      {
        name: 'ingestStatus',
        command: 'ingest-status',
        description: 'Returns ingest distribution and failure logs.',
      },
    ],
    init() {
      if (!this.adapter) this.adapter = new LLMAdapter();
    },
    async run(kernel, input = {}, opts = {}) {
      const capabilityName = String(opts.capability?.name || '');
      const action = String(input.action || '').toLowerCase();

      if (capabilityName === 'ingestStatus' || action === 'status') {
        return getIngestStatus(kernel);
      }

      try {
        if (action === 'ingestmanual' || action === 'manual' || input.sourceType === 'manual') {
          return ingestManual(kernel, input);
        }
        if (action === 'decision' || action === 'logdecision' || input.sourceType === 'decision') {
          return ingestDecision(kernel, input);
        }
        if (action === 'ingestapi' || action === 'api' || input.sourceType === 'api') {
          return ingestApi(kernel, input);
        }
        return await queryCompanyBrain(kernel, this, input);
      } catch (err) {
        trackError(kernel, input.sourceType || action || 'manual', err.message || String(err));
        return {
          ok: false,
          error: err.message || String(err),
          code: err.code || 'COMPANY_BRAIN_FAILED',
        };
      }
    },
  };
}

module.exports = createCompanyBrainPlugin();
module.exports.create = createCompanyBrainPlugin;
module.exports._test = {
  ensureCompanyState,
  ingestManual,
  ingestDecision,
  ingestApi,
  getIngestStatus,
};
