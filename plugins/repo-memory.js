const { fetchRepoFiles, parseRepoUrl } = require('../adapters/github-adapter');
const { parseMarkdown, ingestMarkdown } = require('../adapters/markdown-adapter');
const { routeConnectorCandidate } = require('../lib/connector-admission');

function nowIso() {
  return new Date().toISOString();
}

function ensureCompanyState(kernel) {
  if (!kernel._companyIngestState) {
    kernel._companyIngestState = {
      bySource: { repo: 0, markdown: 0, manual: 0 },
      lastIngestAt: null,
      ingestErrors: [],
    };
  }
  return kernel._companyIngestState;
}

function trackIngestSuccess(kernel, sourceType, amount) {
  const state = ensureCompanyState(kernel);
  if (!(sourceType in state.bySource)) state.bySource[sourceType] = 0;
  state.bySource[sourceType] += Math.max(0, Number(amount || 0));
  state.lastIngestAt = nowIso();
}

function trackIngestError(kernel, sourceType, message) {
  const state = ensureCompanyState(kernel);
  state.ingestErrors.push({
    sourceType,
    message: String(message || 'unknown error'),
    at: nowIso(),
  });
  state.lastIngestAt = nowIso();
}

function routeCompanyEdge(kernel, fromId, toId, relation, opts = {}) {
  return routeConnectorCandidate(kernel, {
    connector: 'repo-memory',
    sourceType: opts.sourceType || 'repo',
    sourceSubType: opts.sourceSubType || opts.source || 'repo',
    sourceRef: opts.sourceRef || '',
    sourceTitle: opts.sourceTitle || opts.sourceRef || toId,
    actor: opts.actor || 'repo-memory',
    timestamp: opts.createdAt || nowIso(),
    workspaceId: opts.workspaceId || 'default',
    accept: opts.accept === true,
    strictProvenance: opts.strictProvenance === true,
    claim: opts.claim || `${fromId} ${relation} ${toId}`,
    proposedEdge: {
      from: fromId,
      to: toId,
      relation,
      confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.75,
      source: opts.source || 'repo',
      sourceRef: opts.sourceRef || '',
      evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
      workspaceId: opts.workspaceId || 'default',
    },
  });
}

function summarizeAdmission(results) {
  const candidates = results.map(result => result && result.candidate).filter(Boolean);
  const byStatus = candidates.reduce((acc, candidate) => {
    acc[candidate.status] = (acc[candidate.status] || 0) + 1;
    return acc;
  }, {});
  return {
    status: candidates.some(candidate => candidate.status === 'accepted')
      ? 'accepted'
      : candidates.some(candidate => candidate.status === 'rejected')
        ? 'rejected'
        : 'pending',
    candidates: candidates.length,
    byStatus,
    ids: candidates.map(candidate => candidate.candidateId),
    recommendation: candidates.some(candidate => candidate.recommendation === 'flag') ? 'flag' : 'review',
  };
}

function buildSectionNodeId(prefix, sectionTitle) {
  return `section:${prefix}:${sectionTitle}`;
}

async function ingestGithubRepo(kernel, input = {}) {
  const repoUrl = input.repoUrl || input.url || '';
  const sessionId = input.sessionId || '';
  const workspaceId = input.workspaceId || 'default';
  const actor = input.actor || 'repo-memory';
  const accept = input.accept === true;
  const files = await fetchRepoFiles(repoUrl, {
    token: input.token || process.env.GITHUB_TOKEN || '',
    branch: input.branch || 'main',
    paths: input.paths,
    fetchImpl: input.fetchImpl,
  });

  const { owner, repo } = parseRepoUrl(repoUrl);
  const repoNode = `repo:${owner}/${repo}`;

  let added = 0;
  const admissions = [];
  for (const file of files) {
    const fileRef = `repo:${owner}/${repo}:${file.path}`;
    const useTemporalCreatedAt = kernel.hasCapability && kernel.hasCapability('temporal');
    const createdAt = useTemporalCreatedAt ? String(file.lastModified || nowIso()) : nowIso();
    admissions.push(routeCompanyEdge(kernel, repoNode, fileRef, 'içerir', {
      source: 'repo',
      sourceRef: `github://${owner}/${repo}/blob/${input.branch || 'main'}/${file.path}`,
      sourceTitle: file.path,
      sessionId,
      sourceType: 'github',
      sourceSubType: 'repo_file',
      evidence: [file.path],
      confidence: 0.8,
      createdAt,
      workspaceId,
      actor,
      accept,
    }));

    const sections = parseMarkdown(file.content, `${owner}/${repo}/${file.path}`);
    if (sections.length === 0) {
      added += 1;
      continue;
    }

    for (const section of sections) {
      const sectionNode = buildSectionNodeId(`${owner}/${repo}/${file.path}`, section.sectionTitle);
      admissions.push(routeCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
        source: 'repo',
        sourceRef: `github://${owner}/${repo}/blob/${input.branch || 'main'}/${file.path}#${section.sectionTitle}`,
        sourceTitle: section.sectionTitle,
        sessionId,
        sourceType: 'github',
        sourceSubType: 'repo_markdown_section',
        evidence: [section.sectionTitle],
        confidence: 0.72,
        createdAt,
        workspaceId,
        actor,
        accept,
      }));
      added += 1;
    }
  }

  trackIngestSuccess(kernel, 'repo', added || files.length);
  return {
    ok: true,
    sourceType: 'repo',
    repoUrl,
    files: files.length,
    added,
    admission: summarizeAdmission(admissions),
  };
}

async function ingestMarkdownPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('markdown path is required');
  }

  const sessionId = input.sessionId || '';
  const workspaceId = input.workspaceId || 'default';
  const actor = input.actor || 'repo-memory';
  const accept = input.accept === true;
  const ingested = ingestMarkdown(targetPath);
  let added = 0;
  const admissions = [];

  for (const section of ingested.sections) {
    const fileRef = `file:${section.filePath}`;
    const sourceRef = `file:${section.filePath}:${section.sectionTitle}`;
    const sectionNode = buildSectionNodeId(section.filePath, section.sectionTitle);
    admissions.push(routeCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
      source: 'markdown',
      sourceRef,
      sourceTitle: section.sectionTitle,
      sessionId,
      sourceType: 'markdown',
      sourceSubType: 'markdown_section',
      evidence: [section.sectionTitle],
      confidence: 0.68,
      workspaceId,
      actor,
      accept,
    }));
    added += 1;
  }

  trackIngestSuccess(kernel, 'markdown', added || ingested.files.length);
  return {
    ok: true,
    sourceType: 'markdown',
    files: ingested.files.length,
    added,
    admission: summarizeAdmission(admissions),
  };
}

function createRepoMemoryPlugin() {
  return {
    name: 'repo-memory',
    version: '0.1.0',
    requires: ['graph', 'companyMode'],
    optional: ['llm', 'temporal', 'evidenceRanking'],
    capabilities: [
      {
        name: 'repoMemory',
        command: 'repo-memory',
        description: 'Ingests GitHub repos and markdown sources into company memory graph.',
      },
    ],
    async run(kernel, input = {}) {
      const action = String(input.action || 'ingest').toLowerCase();
      const sourceType = String(input.sourceType || 'github').toLowerCase();
      if (action !== 'ingest') {
        return {
          ok: false,
          error: `Unsupported repo-memory action: ${action}`,
        };
      }

      try {
        if (sourceType === 'github' || sourceType === 'repo') {
          return await ingestGithubRepo(kernel, input);
        }
        if (sourceType === 'markdown') {
          return await ingestMarkdownPath(kernel, input);
        }
        if (sourceType === 'admission') {
          const result = routeConnectorCandidate(kernel, {
            connector: 'repo-memory',
            ...input,
            sourceType: input.connectorSourceType || input.sourceType || 'connector',
          });
          return {
            ok: true,
            sourceType,
            admission: {
              status: result.candidate.status,
              recommendation: result.candidate.recommendation,
              candidateId: result.candidate.candidateId,
            },
            candidate: result.candidate,
          };
        }
        return {
          ok: false,
          error: `Unsupported sourceType for repo-memory: ${sourceType}`,
        };
      } catch (err) {
        trackIngestError(kernel, sourceType === 'repo' ? 'repo' : sourceType, err.message || String(err));
        return {
          ok: false,
          sourceType,
          error: err.message || String(err),
          code: err.code || 'INGEST_FAILED',
        };
      }
    },
  };
}

module.exports = createRepoMemoryPlugin();
module.exports.create = createRepoMemoryPlugin;
module.exports._test = {
  ensureCompanyState,
  routeCompanyEdge,
  summarizeAdmission,
  trackIngestError,
  trackIngestSuccess,
};
