const { fetchRepoFiles, parseRepoUrl } = require('../adapters/github-adapter');
const { parseMarkdown, ingestMarkdown } = require('../adapters/markdown-adapter');
const { admitConnectorEdge } = require('../lib/connector-admission');

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

function addCompanyEdge(kernel, fromId, toId, relation, opts = {}) {
  return admitConnectorEdge(kernel, {
    from: fromId,
    to: toId,
    relation,
    provenance: opts.provenance,
    provenanceId: opts.provenanceId,
    source: opts.source || 'repo',
    sourceRef: opts.sourceRef || '',
    sourceTitle: opts.sourceTitle || '',
    sourceType: opts.sourceType || '',
    sourceSubType: opts.sourceSubType || '',
    actor: opts.actor || '',
    timestamp: opts.timestamp || opts.createdAt || '',
    workspaceId: opts.workspaceId || 'default',
    sessionId: opts.sessionId || '',
    evidenceType: opts.evidenceType || 'docs',
    companyMode: true,
    createdAt: opts.createdAt || '',
    evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.75,
  });
}

function buildSectionNodeId(prefix, sectionTitle) {
  return `section:${prefix}:${sectionTitle}`;
}

async function ingestGithubRepo(kernel, input = {}) {
  const repoUrl = input.repoUrl || input.url || '';
  const sessionId = input.sessionId || '';
  const files = await fetchRepoFiles(repoUrl, {
    token: input.token || process.env.GITHUB_TOKEN || '',
    branch: input.branch || 'main',
    paths: input.paths,
    fetchImpl: input.fetchImpl,
  });

  const { owner, repo } = parseRepoUrl(repoUrl);
  const repoNode = `repo:${owner}/${repo}`;
  const workspaceId = String(input.workspaceId || 'default').trim() || 'default';

  let added = 0;
  let pending = 0;
  let rejected = 0;
  for (const file of files) {
    const fileRef = `repo:${owner}/${repo}:${file.path}`;
    const useTemporalCreatedAt = kernel.hasCapability && kernel.hasCapability('temporal');
    const createdAt = useTemporalCreatedAt ? String(file.lastModified || nowIso()) : nowIso();
    const fileAdmission = addCompanyEdge(kernel, repoNode, fileRef, 'içerir', {
      source: 'repo',
      sourceRef: fileRef,
      sourceTitle: file.path,
      sourceType: 'github',
      sourceSubType: 'repository_document',
      actor: 'connector:repo-memory',
      sessionId,
      workspaceId,
      evidence: [file.path],
      confidence: 0.8,
      createdAt,
    });
    if (!fileAdmission.ok) {
      throw Object.assign(new Error(fileAdmission.error.message), { code: fileAdmission.error.code });
    }
    if (fileAdmission.admitted) added += 1;
    else if (fileAdmission.candidate.status === 'rejected') rejected += 1;
    else pending += 1;

    const sections = parseMarkdown(file.content, `${owner}/${repo}/${file.path}`);
    if (sections.length === 0) continue;

    for (const section of sections) {
      const sectionNode = buildSectionNodeId(`${owner}/${repo}/${file.path}`, section.sectionTitle);
      const sectionAdmission = addCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
        source: 'repo',
        sourceRef: fileRef,
        sourceTitle: `${file.path}#${section.sectionTitle}`,
        sourceType: 'github',
        sourceSubType: 'repository_section',
        actor: 'connector:repo-memory',
        sessionId,
        workspaceId,
        evidence: [section.sectionTitle],
        confidence: 0.72,
        createdAt,
      });
      if (!sectionAdmission.ok) {
        throw Object.assign(new Error(sectionAdmission.error.message), { code: sectionAdmission.error.code });
      }
      if (sectionAdmission.admitted) added += 1;
      else if (sectionAdmission.candidate.status === 'rejected') rejected += 1;
      else pending += 1;
    }
  }

  trackIngestSuccess(kernel, 'repo', added + pending + rejected);
  return {
    ok: true,
    sourceType: 'repo',
    repoUrl,
    files: files.length,
    added,
    pending,
    rejected,
  };
}

async function ingestMarkdownPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('markdown path is required');
  }

  const sessionId = input.sessionId || '';
  const workspaceId = String(input.workspaceId || 'default').trim() || 'default';
  const ingested = ingestMarkdown(targetPath);
  let added = 0;
  let pending = 0;
  let rejected = 0;

  for (const section of ingested.sections) {
    const fileRef = `file:${section.filePath}`;
    const sourceRef = `file:${section.filePath}:${section.sectionTitle}`;
    const sectionNode = buildSectionNodeId(section.filePath, section.sectionTitle);
    const admission = addCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
      source: 'markdown',
      sourceRef,
      sourceTitle: section.sectionTitle,
      sourceType: 'document',
      sourceSubType: 'markdown_section',
      actor: 'connector:repo-memory',
      sessionId,
      timestamp: nowIso(),
      workspaceId,
      evidence: [section.sectionTitle],
      confidence: 0.68,
    });
    if (!admission.ok) {
      throw Object.assign(new Error(admission.error.message), { code: admission.error.code });
    }
    if (admission.admitted) added += 1;
    else if (admission.candidate.status === 'rejected') rejected += 1;
    else pending += 1;
  }

  trackIngestSuccess(kernel, 'markdown', added + pending + rejected);
  return {
    ok: true,
    sourceType: 'markdown',
    files: ingested.files.length,
    added,
    pending,
    rejected,
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
  addCompanyEdge,
  trackIngestError,
  trackIngestSuccess,
};
