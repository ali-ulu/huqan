const { fetchRepoFiles, parseRepoUrl, isMarkdownPath } = require('../adapters/github-adapter');
const { parseMarkdown, ingestMarkdown } = require('../adapters/markdown-adapter');
const { ingestJson } = require('../adapters/json-adapter');
const { ingestYaml } = require('../adapters/yaml-adapter');
const { ingestGitLog } = require('../adapters/git-log-adapter');
const { ingestPdf } = require('../adapters/pdf-adapter');
const { ingestUrls } = require('../adapters/http-adapter');
const { pinnedRepoFile } = require('../lib/repo-file-pin');
const {
  nowIso,
  ensureCompanyState,
  trackIngestSuccess,
  trackIngestError,
  addCompanyEdge,
} = require('../lib/connectors/repo-memory-records');
const { ingestGuardedSource, plainEntry } = require('../lib/connectors/repo-memory-path-ingest');
const { ingestGithubRepo: ingestGithubRepoWith } = require('../lib/connectors/repo-memory-github');

// The adapters are required here and nowhere else in runtime source; the
// lib/connectors modules receive them as values (connector-firewall ledger).
function ingestGithubRepo(kernel, input = {}) {
  return ingestGithubRepoWith(kernel, input, {
    fetchRepoFiles, parseRepoUrl, isMarkdownPath, parseMarkdown, pinnedRepoFile,
  });
}

const FILE_FLOW = Object.freeze({ provenanceSourceType: 'import', confidence: 0.68 });
const fileCount = (ingested) => ({ files: ingested.files.length });
const plainEntries = (ingested, input) => ingested.entries.map((entry) => plainEntry(entry, input));

// Each executor call below runs inside executeGuardedConnectorIngest, via
// ingestGuardedSource's `execute` callback.
const MARKDOWN = {
  connector: 'markdown',
  rootCode: 'MARKDOWN_ROOT_REQUIRED',
  ingest: (decision) => ingestMarkdown(decision.target, { rootPath: decision.rootPath }),
  flow: {
    provenanceSourceType: 'document', fileSubType: 'markdown_file',
    entrySubType: 'markdown_section', confidence: 0.68,
  },
  entries: (ingested, input) => ingested.sections.map((section) => ({
    filePath: section.filePath,
    sourceRef: `file:${section.filePath}:${section.sectionTitle}`,
    key: section.sectionTitle,
    label: section.sectionTitle,
    actor: input.actor || 'repo-memory',
    timestamp: input.timestamp || nowIso(),
    details: { sectionTitle: section.sectionTitle },
  })),
  counts: fileCount,
};

const JSON_SOURCE = {
  connector: 'json',
  rootCode: 'JSON_ROOT_REQUIRED',
  ingest: (decision) => ingestJson(decision.target, { rootPath: decision.rootPath }),
  flow: { ...FILE_FLOW, fileSubType: 'json_file', entrySubType: 'json_entry' },
  entries: plainEntries,
  counts: fileCount,
};

const YAML_SOURCE = {
  connector: 'yaml',
  rootCode: 'YAML_ROOT_REQUIRED',
  ingest: (decision) => ingestYaml(decision.target, { rootPath: decision.rootPath }),
  flow: { ...FILE_FLOW, fileSubType: 'yaml_file', entrySubType: 'yaml_entry' },
  entries: plainEntries,
  counts: fileCount,
};

const GIT_LOG = {
  connector: 'git-log',
  rootCode: 'GIT_LOG_ROOT_REQUIRED',
  ingest: (decision, input) => ingestGitLog(decision.target, {
    rootPath: decision.rootPath,
    maxCommits: input.maxCommits,
    since: input.since,
    branch: input.branch,
    pathFilter: input.pathFilter,
  }),
  flow: { ...FILE_FLOW, fileSubType: 'git_log_repo', entrySubType: 'git_log_commit' },
  // A commit carries its own author and date, so unlike the other connectors
  // the entry provenance is the commit's, not the ingesting caller's.
  entries: (ingested, input) => ingested.entries.map((entry) => ({
    filePath: entry.filePath,
    sourceRef: entry.sourceRef,
    key: entry.entryKey,
    label: entry.commit.subject || entry.entryKey,
    actor: entry.commit.authorName || input.actor || 'repo-memory',
    timestamp: entry.commit.date || input.timestamp || nowIso(),
    details: { entryKey: entry.entryKey, commitHash: entry.commit.hash },
  })),
  counts: (ingested) => ({ files: 1, commits: ingested.commits.length }),
};

const PDF = {
  connector: 'pdf',
  rootCode: 'PDF_ROOT_REQUIRED',
  ingest: (decision) => ingestPdf(decision.target, { rootPath: decision.rootPath }),
  flow: { ...FILE_FLOW, fileSubType: 'pdf_file', entrySubType: 'pdf_page' },
  entries: plainEntries,
  counts: fileCount,
};

const HTTP = {
  connector: 'http',
  target: (input) => {
    const urls = input.urls || (input.url ? [input.url] : []);
    if (!Array.isArray(urls) || urls.length === 0) {
      const err = new Error('http url(s) required');
      err.code = 'HTTP_URL_REQUIRED';
      throw err;
    }
    return urls;
  },
  // Deliberately not a spread of `input` -- allowPrivateAddresses is a
  // test-only SSRF bypass in lib/ssrf-guard and must never be reachable
  // from a plugin/CLI caller, so only known-safe fields are forwarded here.
  ingest: (decision, input) => ingestUrls(HTTP.target(input), {
    respectRobots: input.respectRobots,
    timeoutMs: input.timeoutMs,
    maxBytes: input.maxBytes,
    maxRedirects: input.maxRedirects,
    userAgent: input.userAgent,
  }),
  flow: {
    provenanceSourceType: 'import', fileSubType: 'http_page', entrySubType: 'http_section',
    confidence: 0.6, fileRefPrefix: 'url:',
  },
  entries: plainEntries,
  counts: (ingested) => ({ urls: ingested.urls.length }),
  extra: (ingested) => ({ fetchErrors: ingested.errors }),
};

const PATH_SOURCES = Object.freeze({
  markdown: MARKDOWN, json: JSON_SOURCE, yaml: YAML_SOURCE, yml: YAML_SOURCE,
  'git-log': GIT_LOG, gitlog: GIT_LOG, pdf: PDF, http: HTTP, url: HTTP,
});

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
        if (Object.hasOwn(PATH_SOURCES, sourceType)) {
          return await ingestGuardedSource(kernel, input, PATH_SOURCES[sourceType]);
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
