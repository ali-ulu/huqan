'use strict';

function createRepoMemoryTool({ kernel, buildEnvelope, normalizeToolInput, resolveCapabilityRunner, resultFromKernel }) {
  return {
    name: 'repoMemory',
    description: 'Ingest GitHub repos or markdown sources into company memory through the repo-memory capability.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        sourceType: { type: 'string' },
        repoUrl: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        targetPath: { type: 'string' },
        branch: { type: 'string' },
        token: { type: 'string' },
        sessionId: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'repoMemory',
          status: 'error',
          data: {
            sourceType: String(input.sourceType || context.sourceType || '').toLowerCase() || 'github',
          },
          error: { code: 'MISSING_METHOD', message: 'kernel.runCapability is unavailable.' },
          confidence: 0,
        });
      }

      const payload = normalizeToolInput(input);
      const action = String(payload.action || context.action || 'ingest').toLowerCase();
      const sourceType = String(payload.sourceType || context.sourceType || (payload.repoUrl || payload.url ? 'github' : payload.path || payload.targetPath ? 'markdown' : 'github')).toLowerCase();
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {};
      const request = {
        action,
        sourceType,
        repoUrl: payload.repoUrl || payload.url || context.repoUrl || context.url || '',
        url: payload.url || context.url || '',
        path: payload.path || payload.targetPath || context.path || context.targetPath || '',
        targetPath: payload.targetPath || context.targetPath || '',
        branch: payload.branch || context.branch || 'main',
        token: payload.token || context.token || '',
        sessionId: payload.sessionId || context.sessionId || '',
        author: payload.author || context.author || '',
        date: payload.date || context.date || '',
        text: payload.text || context.text || '',
      };

      try {
        const result = await runner.run('repoMemory', request, opts);
        return resultFromKernel('repoMemory', result, {
          sourceType,
          action,
        }, {
          source: runner.source,
          capability: 'repoMemory',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'repoMemory',
          status: 'error',
          data: {
            sourceType,
            action,
          },
          error,
          confidence: 0,
          meta: {
            source: runner.source,
            capability: 'repoMemory',
          },
        });
      }
    },
  };
}

module.exports = {
  createRepoMemoryTool,
};
