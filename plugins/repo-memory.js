const { fetchRepoFiles, parseRepoUrl } = require('../adapters/github-adapter');
const { parseMarkdown, ingestMarkdown } = require('../adapters/markdown-adapter');
const { ingestJson } = require('../adapters/json-adapter');
const { ingestYaml } = require('../adapters/yaml-adapter');
const { ingestGitLog } = require('../adapters/git-log-adapter');
const { ingestPdf } = require('../adapters/pdf-adapter');
const { ingestUrls } = require('../adapters/http-adapter');
const { buildProvenance } = require('../lib/provenance-ingest');
const { pinnedRepoFile, buildConnectorProvenance } = require('../lib/repo-file-pin');
const { canonicalizeGitHubRepoUrl } = require('../lib/github-url');

function nowIso() {
  return new Date().toISOString();
}

function ensureCompanyState(kernel) {
  if (!kernel._companyIngestState) {
    kernel._companyIngestState = {
      bySource: { repo: 0, markdown: 0, json: 0, yaml: 0, 'git-log': 0, pdf: 0, http: 0, manual: 0 },
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
  const fromResult = kernel.proposeNode(fromId, opts.fromLabel || fromId, fromProvenance, { workspaceId });
  const toResult = kernel.proposeNode(toId, opts.toLabel || toId, toProvenance, { workspaceId });
  const edgeResult = kernel.proposeEdge(fromId, toId, relation, {
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
  return { fromResult, toResult, edgeResult, edge: edgeResult?.edge || null };
}

function buildGraphAdmissionRecord({
  kind,
  outcome = 'admitted',
  targetType,
  targetId,
  provenance = null,
  proposal = null,
  workspaceId = 'default',
  details = {},
}) {
  const decision = proposal?.decision || '';
  const graphWrite = Boolean(proposal?.node || proposal?.edge);
  const resolvedOutcome = decision === 'allow'
    ? (graphWrite ? 'admitted' : 'skipped')
    : decision === 'reject'
      ? 'rejected'
      : decision === 'review'
        ? 'candidate'
        : outcome;
  return {
    kind,
    outcome: resolvedOutcome,
    targetType,
    targetId,
    workspaceId,
    sourceType: provenance?.sourceType || '',
    sourceRef: provenance?.sourceRef || '',
    actor: provenance?.actor || '',
    provenanceId: provenance?.provenanceId || '',
    trustPolicyVersion: provenance?.trustPolicyVersion || '',
    graphWrite,
    provenance: provenance || null,
    decision: decision || undefined,
    reason: proposal?.admission?.reason || undefined,
    receiptId: proposal?.admission?.receiptId || undefined,
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
  const rawRepoUrl = input.repoUrl || input.url || '';
  const canonicalRepo = canonicalizeGitHubRepoUrl(rawRepoUrl);
  const repoUrl = canonicalRepo.repoUrl;
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
  const repoNodeResult = kernel.proposeNode(repoNode, repoNode, repoProvenance, { workspaceId });
  admissions.push(buildGraphAdmissionRecord({
    kind: 'node',
    targetType: 'graph_node',
    targetId: repoNode,
    provenance: repoProvenance,
    proposal: repoNodeResult,
    workspaceId,
  }));

  let added = 0;
  for (const file of files) {
    // Pinned at the commit the adapter resolved, not at the branch the caller
    // asked for. Until now this dropped the commitSha it was handed, so the pin
    // existed at fetch time and was discarded before storage.
    const pin = pinnedRepoFile(owner, repo, file);
    const fileRef = pin.sourceRef;
    const fileProvenance = buildConnectorProvenance({
      ...pin,
      sourceType: 'github',
      sourceSubType: 'repo_file',
      sourceTitle: file.path,
      actor: input.actor || 'github',
      workspaceId,
      confidence: 0.8,
      timestamp: file.lastModified || nowIso(),
    });
    const useTemporalCreatedAt = kernel.hasCapability && kernel.hasCapability('temporal');
    const createdAt = useTemporalCreatedAt ? String(file.lastModified || nowIso()) : nowIso();
    const fileProposal = addCompanyEdge(kernel, repoNode, fileRef, 'içerir', {
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
      targetId: repoNode,
      provenance: repoProvenance,
      proposal: fileProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileProposal.toResult,
      workspaceId,
      details: {
        parentId: repoNode,
        filePath: file.path,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${repoNode}|içerir|${fileRef}`,
      provenance: fileProvenance,
      proposal: fileProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'içerir',
        sourceRef: fileProvenance.sourceRef,
      },
    }));

    const sections = parseMarkdown(file.content, `${owner}/${repo}/${file.path}`);
    if (sections.length === 0) {
      if (fileProposal.edge) added += 1;
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
      const sectionProposal = addCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
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
        targetId: fileRef,
        provenance: fileProvenance,
        proposal: sectionProposal.fromResult,
        workspaceId,
        details: {
          repeatedProposal: true,
          childId: sectionNode,
        },
      }));
      admissions.push(buildGraphAdmissionRecord({
        kind: 'node',
        targetType: 'graph_node',
        targetId: sectionNode,
        provenance: sectionProvenance,
        proposal: sectionProposal.toResult,
        workspaceId,
        details: {
          parentId: fileRef,
          sectionTitle: section.sectionTitle,
        },
      }));
      admissions.push(buildGraphAdmissionRecord({
        kind: 'edge',
        targetType: 'graph_edge',
        targetId: `${fileRef}|özellik|${sectionNode}`,
        provenance: sectionProvenance,
        proposal: sectionProposal.edgeResult,
        workspaceId,
        details: {
          relation: 'özellik',
          sourceRef: sectionProvenance.sourceRef,
        },
      }));
      if (sectionProposal.edge) added += 1;
    }
  }

  trackIngestSuccess(kernel, 'repo', added);
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
    const fileNodeResult = kernel.proposeNode(fileRef, section.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: section.filePath,
      },
    }));
    const sectionNodeResult = kernel.proposeNode(sectionNode, section.sectionTitle, sectionProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: sectionNode,
      provenance: sectionProvenance,
      proposal: sectionNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        sectionTitle: section.sectionTitle,
      },
    }));
    const sectionProposal = addCompanyEdge(kernel, fileRef, sectionNode, 'özellik', {
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
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: sectionProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: sectionNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: sectionNode,
      provenance: sectionProvenance,
      proposal: sectionProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${sectionNode}`,
      provenance: sectionProvenance,
      proposal: sectionProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));
    if (sectionProposal.edge) added += 1;
  }

  trackIngestSuccess(kernel, 'markdown', added);
  return {
    ok: true,
    sourceType: 'markdown',
    files: ingested.files.length,
    added,
    admission: summarizeGraphAdmissions(admissions),
    admissions,
  };
}

async function ingestJsonPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('json path is required');
  }

  const rootPath = input.rootPath || input.workspaceRoot || input.allowedRoot || '';
  if (!rootPath) {
    const err = new Error('json rootPath is required');
    err.code = 'JSON_ROOT_REQUIRED';
    throw err;
  }

  const sessionId = input.sessionId || '';
  const ingested = ingestJson(targetPath, { rootPath });
  let added = 0;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];

  for (const entry of ingested.entries) {
    const fileRef = `file:${entry.filePath}`;
    const sourceRef = entry.sourceRef;
    const entryNode = buildSectionNodeId(entry.filePath, entry.entryKey);
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'json_file',
      sourceRef: fileRef,
      sourceTitle: entry.filePath,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const entryProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'json_entry',
      sourceRef,
      sourceTitle: entry.entryKey,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const fileNodeResult = kernel.proposeNode(fileRef, entry.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: entry.filePath,
      },
    }));
    const entryNodeResult = kernel.proposeNode(entryNode, entry.entryKey, entryProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        entryKey: entry.entryKey,
      },
    }));
    const entryProposal = addCompanyEdge(kernel, fileRef, entryNode, 'özellik', {
      source: 'json',
      sourceRef,
      sessionId,
      sourceType: 'import',
      evidence: [entry.entryKey],
      confidence: 0.68,
      workspaceId,
      provenance: entryProvenance,
      fromProvenance: fileProvenance,
      toProvenance: entryProvenance,
      fromLabel: entry.filePath,
      toLabel: entry.entryKey,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: entryProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: entryNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${entryNode}`,
      provenance: entryProvenance,
      proposal: entryProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));
    if (entryProposal.edge) added += 1;
  }

  trackIngestSuccess(kernel, 'json', added);
  return {
    ok: true,
    sourceType: 'json',
    files: ingested.files.length,
    added,
    admission: summarizeGraphAdmissions(admissions),
    admissions,
  };
}

async function ingestYamlPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('yaml path is required');
  }

  const rootPath = input.rootPath || input.workspaceRoot || input.allowedRoot || '';
  if (!rootPath) {
    const err = new Error('yaml rootPath is required');
    err.code = 'YAML_ROOT_REQUIRED';
    throw err;
  }

  const sessionId = input.sessionId || '';
  const ingested = ingestYaml(targetPath, { rootPath });
  let added = 0;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];

  for (const entry of ingested.entries) {
    const fileRef = `file:${entry.filePath}`;
    const sourceRef = entry.sourceRef;
    const entryNode = buildSectionNodeId(entry.filePath, entry.entryKey);
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'yaml_file',
      sourceRef: fileRef,
      sourceTitle: entry.filePath,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const entryProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'yaml_entry',
      sourceRef,
      sourceTitle: entry.entryKey,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const fileNodeResult = kernel.proposeNode(fileRef, entry.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: entry.filePath,
      },
    }));
    const entryNodeResult = kernel.proposeNode(entryNode, entry.entryKey, entryProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        entryKey: entry.entryKey,
      },
    }));
    const entryProposal = addCompanyEdge(kernel, fileRef, entryNode, 'özellik', {
      source: 'yaml',
      sourceRef,
      sessionId,
      sourceType: 'import',
      evidence: [entry.entryKey],
      confidence: 0.68,
      workspaceId,
      provenance: entryProvenance,
      fromProvenance: fileProvenance,
      toProvenance: entryProvenance,
      fromLabel: entry.filePath,
      toLabel: entry.entryKey,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: entryProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: entryNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${entryNode}`,
      provenance: entryProvenance,
      proposal: entryProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));
    if (entryProposal.edge) added += 1;
  }

  trackIngestSuccess(kernel, 'yaml', added);
  return {
    ok: true,
    sourceType: 'yaml',
    files: ingested.files.length,
    added,
    admission: summarizeGraphAdmissions(admissions),
    admissions,
  };
}

async function ingestGitLogPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('git-log path is required');
  }

  const rootPath = input.rootPath || input.workspaceRoot || input.allowedRoot || '';
  if (!rootPath) {
    const err = new Error('git-log rootPath is required');
    err.code = 'GIT_LOG_ROOT_REQUIRED';
    throw err;
  }

  const sessionId = input.sessionId || '';
  const ingested = ingestGitLog(targetPath, {
    rootPath,
    maxCommits: input.maxCommits,
    since: input.since,
    branch: input.branch,
    pathFilter: input.pathFilter,
  });
  let added = 0;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];

  for (const entry of ingested.entries) {
    const fileRef = `file:${entry.filePath}`;
    const sourceRef = entry.sourceRef;
    const entryNode = buildSectionNodeId(entry.filePath, entry.entryKey);
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'git_log_repo',
      sourceRef: fileRef,
      sourceTitle: entry.filePath,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const entryProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'git_log_commit',
      sourceRef,
      sourceTitle: entry.commit.subject || entry.entryKey,
      actor: entry.commit.authorName || input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: entry.commit.date || input.timestamp || nowIso(),
    });
    const fileNodeResult = kernel.proposeNode(fileRef, entry.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: entry.filePath,
      },
    }));
    const entryNodeResult = kernel.proposeNode(entryNode, entry.commit.subject || entry.entryKey, entryProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        entryKey: entry.entryKey,
        commitHash: entry.commit.hash,
      },
    }));
    const entryProposal = addCompanyEdge(kernel, fileRef, entryNode, 'özellik', {
      source: 'git-log',
      sourceRef,
      sessionId,
      sourceType: 'import',
      evidence: [entry.entryKey],
      confidence: 0.68,
      workspaceId,
      provenance: entryProvenance,
      fromProvenance: fileProvenance,
      toProvenance: entryProvenance,
      fromLabel: entry.filePath,
      toLabel: entry.commit.subject || entry.entryKey,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: entryProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: entryNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${entryNode}`,
      provenance: entryProvenance,
      proposal: entryProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));
    if (entryProposal.edge) added += 1;
  }

  trackIngestSuccess(kernel, 'git-log', added);
  return {
    ok: true,
    sourceType: 'git-log',
    files: 1,
    commits: ingested.commits.length,
    added,
    admission: summarizeGraphAdmissions(admissions),
    admissions,
  };
}

async function ingestPdfPath(kernel, input = {}) {
  const targetPath = input.path || input.targetPath || '';
  if (!targetPath) {
    throw new Error('pdf path is required');
  }

  const rootPath = input.rootPath || input.workspaceRoot || input.allowedRoot || '';
  if (!rootPath) {
    const err = new Error('pdf rootPath is required');
    err.code = 'PDF_ROOT_REQUIRED';
    throw err;
  }

  const sessionId = input.sessionId || '';
  const ingested = await ingestPdf(targetPath, { rootPath });
  let added = 0;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];

  for (const entry of ingested.entries) {
    const fileRef = `file:${entry.filePath}`;
    const sourceRef = entry.sourceRef;
    const entryNode = buildSectionNodeId(entry.filePath, entry.entryKey);
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'pdf_file',
      sourceRef: fileRef,
      sourceTitle: entry.filePath,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const entryProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'pdf_page',
      sourceRef,
      sourceTitle: entry.entryKey,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.68,
      timestamp: input.timestamp || nowIso(),
    });
    const fileNodeResult = kernel.proposeNode(fileRef, entry.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: entry.filePath,
      },
    }));
    const entryNodeResult = kernel.proposeNode(entryNode, entry.entryKey, entryProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        entryKey: entry.entryKey,
      },
    }));
    const entryProposal = addCompanyEdge(kernel, fileRef, entryNode, 'özellik', {
      source: 'pdf',
      sourceRef,
      sessionId,
      sourceType: 'import',
      evidence: [entry.entryKey],
      confidence: 0.68,
      workspaceId,
      provenance: entryProvenance,
      fromProvenance: fileProvenance,
      toProvenance: entryProvenance,
      fromLabel: entry.filePath,
      toLabel: entry.entryKey,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: entryProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: entryNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${entryNode}`,
      provenance: entryProvenance,
      proposal: entryProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));
    if (entryProposal.edge) added += 1;
  }

  trackIngestSuccess(kernel, 'pdf', added);
  return {
    ok: true,
    sourceType: 'pdf',
    files: ingested.files.length,
    added,
    admission: summarizeGraphAdmissions(admissions),
    admissions,
  };
}

async function ingestHttpUrls(kernel, input = {}) {
  const urls = input.urls || (input.url ? [input.url] : []);
  if (!Array.isArray(urls) || urls.length === 0) {
    const err = new Error('http url(s) required');
    err.code = 'HTTP_URL_REQUIRED';
    throw err;
  }

  const sessionId = input.sessionId || '';
  // Deliberately not a spread of `input` -- allowPrivateAddresses is a
  // test-only SSRF bypass in lib/ssrf-guard and must never be reachable
  // from a plugin/CLI caller, so only known-safe fields are forwarded here.
  const ingested = await ingestUrls(urls, {
    respectRobots: input.respectRobots,
    timeoutMs: input.timeoutMs,
    maxBytes: input.maxBytes,
    maxRedirects: input.maxRedirects,
    userAgent: input.userAgent,
  });
  let added = 0;
  const workspaceId = input.workspaceId || 'default';
  const admissions = [];

  for (const entry of ingested.entries) {
    const fileRef = `url:${entry.filePath}`;
    const sourceRef = entry.sourceRef;
    const entryNode = buildSectionNodeId(entry.filePath, entry.entryKey);
    const fileProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'http_page',
      sourceRef: fileRef,
      sourceTitle: entry.filePath,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.6,
      timestamp: input.timestamp || nowIso(),
    });
    const entryProvenance = buildConnectorProvenance({
      sourceType: 'import',
      sourceSubType: 'http_section',
      sourceRef,
      sourceTitle: entry.entryKey,
      actor: input.actor || 'repo-memory',
      workspaceId,
      confidence: 0.6,
      timestamp: input.timestamp || nowIso(),
    });
    const fileNodeResult = kernel.proposeNode(fileRef, entry.filePath, fileProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: fileNodeResult,
      workspaceId,
      details: {
        filePath: entry.filePath,
      },
    }));
    const entryNodeResult = kernel.proposeNode(entryNode, entry.entryKey, entryProvenance, { workspaceId });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryNodeResult,
      workspaceId,
      details: {
        parentId: fileRef,
        entryKey: entry.entryKey,
      },
    }));
    const entryProposal = addCompanyEdge(kernel, fileRef, entryNode, 'özellik', {
      source: 'http',
      sourceRef,
      sessionId,
      sourceType: 'import',
      evidence: [entry.entryKey],
      confidence: 0.6,
      workspaceId,
      provenance: entryProvenance,
      fromProvenance: fileProvenance,
      toProvenance: entryProvenance,
      fromLabel: entry.filePath,
      toLabel: entry.entryKey,
    });
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: fileRef,
      provenance: fileProvenance,
      proposal: entryProposal.fromResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        childId: entryNode,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'node',
      targetType: 'graph_node',
      targetId: entryNode,
      provenance: entryProvenance,
      proposal: entryProposal.toResult,
      workspaceId,
      details: {
        repeatedProposal: true,
        parentId: fileRef,
      },
    }));
    admissions.push(buildGraphAdmissionRecord({
      kind: 'edge',
      targetType: 'graph_edge',
      targetId: `${fileRef}|özellik|${entryNode}`,
      provenance: entryProvenance,
      proposal: entryProposal.edgeResult,
      workspaceId,
      details: {
        relation: 'özellik',
        sourceRef,
      },
    }));
    if (entryProposal.edge) added += 1;
  }

  trackIngestSuccess(kernel, 'http', added);
  return {
    ok: true,
    sourceType: 'http',
    urls: ingested.urls.length,
    added,
    fetchErrors: ingested.errors,
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
        if (sourceType === 'json') {
          return await ingestJsonPath(kernel, input);
        }
        if (sourceType === 'yaml' || sourceType === 'yml') {
          return await ingestYamlPath(kernel, input);
        }
        if (sourceType === 'git-log' || sourceType === 'gitlog') {
          return await ingestGitLogPath(kernel, input);
        }
        if (sourceType === 'pdf') {
          return await ingestPdfPath(kernel, input);
        }
        if (sourceType === 'http' || sourceType === 'url') {
          return await ingestHttpUrls(kernel, input);
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
