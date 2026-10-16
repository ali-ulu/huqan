'use strict';

// The CLI `company-ingest` command: ingests company knowledge from one of the
// supported sources (manual note, decision, repository, markdown, json, yaml,
// git log, pdf, http) through the companyBrain and repoMemory capabilities.
// Moved out of cli.js's command table (#2136) unchanged. It receives the
// command context CLI#execute builds and uses only its kernel and
// ensureCompanyCapabilities.
const { commandFailure } = require('./cli-helpers');

function runCompanyIngest(cli, args, opts) {
  const payload = args && typeof args === 'object' ? args : {};
  const source = String(payload.source || '').toLowerCase();
  cli.ensureCompanyCapabilities();

  if (source === 'manuel' || source === 'manual') {
    const run = cli.kernel.runCapability('companyBrain', {
      action: 'manual',
      sourceType: 'manual',
      text: payload.text,
      author: payload.author,
      date: payload.date,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`Manual ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Manual ingest: ok (${result.added || 0})`;
    });
  }

  if (source === 'karar' || source === 'decision') {
    const run = cli.kernel.runCapability('companyBrain', {
      action: 'decision',
      sourceType: 'decision',
      title: payload.title,
      rationale: payload.rationale,
      decidedBy: payload.author,
      date: payload.date,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`Decision ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Decision ingest: ok (${result.decisionId || '-'})`;
    });
  }

  if (source === 'github' || source === 'repo') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'github',
      repoUrl: payload.repoUrl,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`Repo ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Repo ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
    });
  }

  if (source === 'markdown' || source === 'md') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'markdown',
      path: payload.targetPath,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`Markdown ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Markdown ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
    });
  }

  if (source === 'json') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'json',
      path: payload.targetPath,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`JSON ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Json ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
    });
  }

  if (source === 'yaml' || source === 'yml') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'yaml',
      path: payload.targetPath,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`YAML ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Yaml ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
    });
  }

  if (source === 'git-log' || source === 'gitlog') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'git-log',
      path: payload.targetPath,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`Git-log ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Git-log ingest: ok (commits=${result.commits || 0}, added=${result.added || 0})`;
    });
  }

  if (source === 'pdf') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'pdf',
      path: payload.targetPath,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`PDF ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Pdf ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
    });
  }

  if (source === 'http' || source === 'url') {
    const run = cli.kernel.runCapability('repoMemory', {
      action: 'ingest',
      sourceType: 'http',
      url: payload.repoUrl,
      enforceConnectorFirewall: true,
    });
    return Promise.resolve(run).then(result => {
      if (!result || result.ok === false) {
        return commandFailure(`HTTP ingest error: ${result?.error || 'unknown error'}`, opts);
      }
      return `Http ingest: ok (urls=${result.urls || 0}, added=${result.added || 0})`;
    });
  }

  return commandFailure(
    'Desteklenmeyen kaynak. Kullanim: ogren --kaynak manuel|karar|github|markdown|json|yaml|git-log|pdf|http ...',
    opts,
    2
  );
}

module.exports = { runCompanyIngest };
