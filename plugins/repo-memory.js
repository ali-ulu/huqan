const { fetchRepoFiles, parseRepoUrl } = require('../adapters/github-adapter');
const { parseMarkdown, ingestMarkdown } = require('../adapters/markdown-adapter');
const { buildProvenance } = require('../lib/provenance-ingest');

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
  const provenance = opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null;
  const workspaceId = opts.workspaceId || provenance?.workspaceId || 'default';
  const fromProvenance = opts.fromProvenance && typeof opts.fromProvenance === 'object' ? opts.fromProvenance : provenance;
  const toProvenance = opts.toProvenance && typeof opts.toProvenance === 'object' ? opts.toProvenance : provenance;
  kernel.proposeNode(fromId, opts.fromLabel || fromId, fromProvenance, { workspaceId });
  kernel.proposeNode(toId, opts.toLabel || toId, toProvenance, { workspaceId });
  const result = kernel.proposeEdge(fromId, toId, relation, {
    source: opts.source || 'repo',
    sourceRef: opts.sourceRef || provenance?.sourceRef || '',
    sessionId: opts.sessionId || '',
    sourceType: opts.sourceType || provenance?.sourceType || 'repo',
    companyMode: true,
    evidenceType: opts.evidenceType || 'docs',
    evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.75,
    createdAt: opts.createdAt || '',
    provenance,
    workspaceId,
  });
  return result && result.edge ? result.edge : null;
}

function buildConnectorProvenance({
  sourceType,
  sourceSubType,
  sourceRef,
  sourceTitle,
  actor,
  workspaceId,
  confidence,
  timestamp,
}) {
  return buildProvenance({
    sourceType,
    sourceSubType,
    sourceRef,
    sourceTitle,
    actor,
    workspaceId,
    confidence,
    timestamp,
  }).provenance;
}

function buildGraphAdmissionRecord({
  kind,
  outcome = 'admitted',
  targetType,
  targetId,
  provenance = null,
  workspaceId = 'default',
  details = {},
}) {
  return {
    kind,
    outcome,
    targetType,
    targetId,
    workspaceId,
    sourceType: provenance?.sourceType || '',
    sourceRef: provenance?.sourceRef || '',
    actor: provenance?.actor || '',
    provenanceId: provenance?.provenanceId || '',
    trustPolicyVersion: provenance?.trustPolicyVersion || '',
    graphWrite: outcome === 'admitted',
    provenance: provenance || null,
    ...details,
  };
}

function summarizeGraphAdmissions(entries = []) {
  const list = Array.isArray(entries) ? entries.filter(Boolean) : [];
  const counts = list.reduce((acc, entry) => {
    const key = entry.outcome || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  const outcome = list.length === 0
    ? 'skipped'
    : (counts.rejected > 0 ? 'rejected'
      : counts.candidate > 0 ? 'candidate'
        : counts.admitted > 0 ? 'admitted'
          : counts.skipped > 0 ? 'skipped'
            : 'unknown');
  return {
    outcome,
    counts,
    total: list.length,
    entries: list,
  };
}

function buildSectionNodeId(prefix, sectionTitle) {
  return `section:${prefix}:${sectionTitle}`;
}

async function ingestGithubRepo(kernel, input = {}) {
  const repoUrl = input.repoUrl || input.url || '';
  const sessionId = input.sessionId || '';
  const fetchRepoFilesImpl = typeof input.fetchRepoFiles === 'function' ? input.fetchRepoFiles : fetchRepoFiles;
  const parseRepoUrlImpl = typeof input.parseRepoUrl === 'function' ? input.parseRepoUrl : parseRepoUrl;
  const files = await fetchRepoFilesImpl(repoUrl, {
    token: input.token || process.env.GITHUB_TOKEN || '',
    branch: input.branch || 'main',
    paths: input.paths,
    fetchImpl: input.fetchImpl,
  });

  const { owner, repo } = parseRepoUrlImpl(repoUrl);
  const repoNode = `repo:${owner}/${repo}`;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];
  const repoProvenance = buildConnectorProvenance({
    sourceType: 'github',
    sourceSubType: 'repo',
    sourceRef: repoUrl,
    sourceTitle: `${owner}/${repo}`,
    actor: input.actor || 'github',
    workspaceId,
    confidence: 0.8,
    timestamp: input.timestamp || nowIso(),
  });
  kernel.proposeNode(repoNode, repoNode, repoProvenance, { workspaceId });
  admissions.push(buildGraphAdmissionRecord({
    kind: 'node',
    targetType: 'graph_node',
    targetId: repoNode,
    provenance: repoProvenance,
    workspaceId,
  }));

  let added = 0;
  for (const file of files) {
    const fileRef = `repo:${owner}/${repo}:${file.path}`;
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'github',
      sourceSubType: 'repo_file',
      sourceRef: fileRef,
      sourceTitle: file.path,
      actor: input.actor || 'github',
      workspaceId,
      confidence: 0.8,
      timestamp: file.lastModified || nowIso(),
    });
    const useTemporalCreatedAt = kernel.hasCapability && kernel.hasCapability('temporal');
    const createdAt = useTemporalCreatedAt ? String(file.lastModified || nowIso()) : nowIso();
    const fileEdge = addCompanyEdge(kernel, repoNode, fileRef, 'içerir', {
      source: 'repo',
      sourceRef: fileRef,
      sessionId,
      sourceType: 'github',
      evidence: [file.path],
      confidence: 0.8,
      createdAt,
      workspaceId,
      provenance: fileProvenance,
      fromProvenance: repoProvenance,
      toProvenance: fileProvenance,
      fromLabel: repoNode,
      toLabel: file.path,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      workspaceId,
      details: {
        parentId: repoNode,
        filePath: file.path,
      },
    }));
    if (fileEdge) {
      admissions.push(buildGraphAdmissionRecord({
        kind: 'edge',
        targetType: 'graph_edge',
        targetId: `${fileEdge.from}|${fileEdge.relation}|${fileEdge.to}`,
        provenance: fileProvenance,
        workspaceId,
        details: {
          relation: fileEdge.relation,
          sourceRef: fileProvenance.sourceRef,
        },
      }));
    }

    const sections = parseMarkdown(file.content, `${owner}/${repo}/${file.path}`);
    if (sections.length === 0) {
      added += 1;
      continue;
    }

    for (const section of sections) {
      const sectionNode = buildSectionNodeId(`${owner}/${repo}/${file.path}`, section.sectionTitle);
      const sectionProvenance = buildConnectorProvenance({
        sourceType: 'github',
        sourceSubType: 'repo_section',
        sourceRef: `${fileRef}#${section.sectionTitle}`,
        sourceTitle: section.sectionTitle,
        actor: input.actor || 'github',
        workspaceId,
        confidence: 0.72,
        timestamp: file.lastModified || nowIso(),
      });
      const sectionEdge = addCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
        source: 'repo',
        sourceRef: sectionProvenance.sourceRef,
        sessionId,
        sourceType: 'github',
        evidence: [section.sectionTitle],
        confidence: 0.72,
        createdAt,
        workspaceId,
        provenance: sectionProvenance,
        fromProvenance: fileProvenance,
        toProvenance: sectionProvenance,
        fromLabel: file.path,
        toLabel: section.sectionTitle,
      });
      admissions.push(buildGraphAdmissionRecord({
        kind: 'node',
        targetType: 'graph_node',
        targetId: sectionNode,
        provenance: sectionProvenance,
        workspaceId,
        details: {
          parentId: fileRef,
          sectionTitle: section.sectionTitle,
        },
      }));
      if (sectionEdge) {
        admissions.push(buildGraphAdmissionRecord({
          kind: 'edge',
          targetType: 'graph_edge',
          targetId: `${sectionEdge.from}|${sectionEdge.relation}|${sectionEdge.to}`,
          provenance: sectionProvenance,
          workspaceId,
          details: {
            relation: sectionEdge.relation,
            sourceRef: sectionProvenance.sourceRef,
          },
        }));
      }
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
    admission: summarizeGraphAdmissions(admissions),
    admissions,
  };
}

async function ingestMarkdownPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('markdown path is required');
  }

  const rootPath = input.rootPath || input.workspaceRoot || input.allowedRoot || '';
  if (!rootPath) {
    const err = new Error('markdown rootPath is required');
    err.code = 'MARKDOWN_ROOT_REQUIRED';
    throw err;
  }

  const sessionId = input.sessionId || '';
  const ingested = ingestMarkdown(targetPath, { rootPath });
  let added = 0;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];

  for (const section of ingested.sections) {
    const fileRef = `file:${section.filePath}`;
    const sourceRef = `file:${section.filePath}:${section.sectionTitle}`;
    const sectionNode = buildSectionNodeId(section.filePath, section.sectionTitle);
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'document',
      sourceSubType: 'markdown_file',
      sourceRef: fileRef,
      sourceTitle: section.filePath,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const sectionProvenance = buildConnectorProvenance({
      sourceType: 'document',
      sourceSubType: 'markdown_section',
      sourceRef,
      sourceTitle: section.sectionTitle,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    kernel.proposeNode(fileRef, section.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      workspaceId,
      details: {
        filePath: section.filePath,
      },
    }));
    kernel.proposeNode(sectionNode, section.sectionTitle, sectionProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: sectionNode,
      provenance: sectionProvenance,
      workspaceId,
      details: {
        parentId: fileRef,
        sectionTitle: section.sectionTitle,
      },
    }));
    const sectionEdge = addCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
      source: 'markdown',
      sourceRef,
      sessionId,
      sourceType: 'document',
      evidence: [section.sectionTitle],
      confidence: 0.68,
      workspaceId,
      provenance: sectionProvenance,
      fromProvenance: fileProvenance,
      toProvenance: sectionProvenance,
      fromLabel: section.filePath,
      toLabel: section.sectionTitle,
    });
    if (sectionEdge) {
      admissions.push(buildGraphAdmissionRecord({
        kind: 'edge',
        targetType: 'graph_edge',
        targetId: `${sectionEdge.from}|${sectionEdge.relation}|${sectionEdge.to}`,
        provenance: sectionProvenance,
        workspaceId,
        details: {
          relation: sectionEdge.relation,
          sourceRef,
        },
      }));
    }
    added += 1;
  }

  trackIngestSuccess(kernel, 'markdown', added || ingested.files.length);
  return {
    ok: true,
    sourceType: 'markdown',
    files: ingested.files.length,
    added,
    admission: summarizeGraphAdmissions(admissions),
    admissions,
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
