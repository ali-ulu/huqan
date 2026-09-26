const { buildConnectorProvenance } = require('../repo-file-pin');
const { fetchGithubRepoWithFirewall } = require('./repo-memory-firewall');
const {
  nowIso,
  trackIngestSuccess,
  addCompanyEdge,
  buildGraphAdmissionRecord,
  summarizeGraphAdmissions,
  buildSectionNodeId,
  pushEdgeAdmissions,
} = require('./repo-memory-records');

/**
 * The github ingest path of plugins/repo-memory.js. The adapter functions are
 * handed in by the plugin, which is the only runtime module allowed to require
 * a connector adapter.
 */
async function ingestGithubRepo(kernel, input, adapter) {
  const { fetchRepoFiles, parseRepoUrl, isMarkdownPath, parseMarkdown, pinnedRepoFile } = adapter;
  const rawRepoUrl = input.repoUrl || input.url || '';
  const sessionId = input.sessionId || '';
  const fetchRepoFilesImpl = typeof input.fetchRepoFiles === 'function' ? input.fetchRepoFiles : fetchRepoFiles;
  const parseRepoUrlImpl = typeof input.parseRepoUrl === 'function' ? input.parseRepoUrl : parseRepoUrl;
  const fetchOptions = {
    token: input.token || process.env.GITHUB_TOKEN || '',
    branch: input.branch || 'main',
    paths: input.paths,
    fetchImpl: input.fetchImpl,
  };
  const fetched = await fetchGithubRepoWithFirewall({
    rawRepoUrl,
    input,
    fetchRepoFilesImpl,
    fetchOptions,
  });
  if (!fetched.ok) return fetched;
  const { value: files, repoUrl, connectorFirewall = null } = fetched;

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
    pushEdgeAdmissions(admissions, fileProposal, {
      fromId: repoNode,
      toId: fileRef,
      relation: 'içerir',
      fromProvenance: repoProvenance,
      toProvenance: fileProvenance,
      workspaceId,
      childDetails: { filePath: file.path },
    });

    // Only markdown gets section parsing: running it over source or config
    // files turns leading `# ` comments into graph "section" nodes (#1508).
    const sections = isMarkdownPath(file.path)
      ? parseMarkdown(file.content, `${owner}/${repo}/${file.path}`)
      : [];
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
      pushEdgeAdmissions(admissions, sectionProposal, {
        fromId: fileRef,
        toId: sectionNode,
        relation: 'özellik',
        fromProvenance: fileProvenance,
        toProvenance: sectionProvenance,
        workspaceId,
        childDetails: { sectionTitle: section.sectionTitle },
      });
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
    ...(connectorFirewall ? { connectorFirewall } : {}),
  };
}

module.exports = { ingestGithubRepo };
