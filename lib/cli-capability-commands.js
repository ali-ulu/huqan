const { commandFailure } = require('./cli-helpers');

// CLI command handlers (cli.js registry) that run a plugin capability.

function ideaMriCommand(cli, args, opts, command) {
  cli.ensureProductCapabilities();
  const run = cli.kernel.runCapability('ideaMri', { text: String(args || '').trim() });
  return Promise.resolve(run).then(result => {
    if (!result || result.ok === false) {
      return commandFailure(`MRI error: ${result?.error || 'unknown error'}`, opts);
    }
    const data = result.data || {};
    const claim = data.mainClaim || String(args || '').trim();
    const risks = Array.isArray(data.risks)
      ? data.risks.slice(0, 2).map(item => item?.text).filter(Boolean).join(' | ')
      : '';
    const gaps = Array.isArray(data.missingEvidence)
      ? data.missingEvidence.slice(0, 2).map(item => item?.text).filter(Boolean).join(' | ')
      : '';
    return `MRI: ${claim}\nRiskler: ${risks || 'yok'}\nEksik kanit: ${gaps || 'yok'}`;
  });
}

function debateCommand(cli, args, opts, command) {
  cli.ensureProductCapabilities();
  const run = cli.kernel.runCapability('devilAdvocate', { text: String(args || '').trim() });
  return Promise.resolve(run).then(result => {
    if (!result || result.ok === false) {
      return commandFailure(`Debate error: ${result?.error || 'unknown error'}`, opts);
    }
    const data = result.data || {};
    return `Devil's advocate (${data.mode || 'unknown'}): ${data.counterArgument || 'no output'}`;
  });
}

function contradictionCommand(cli, args, opts, command) {
  cli.ensureProductCapabilities();
  const run = cli.kernel.runCapability('contradictionAlert', { text: String(args || '').trim() });
  return Promise.resolve(run).then(result => {
    if (!result || result.ok === false) {
      return commandFailure(`Contradiction error: ${result?.error || 'unknown error'}`, opts);
    }
    const data = result.data || {};
    const count = Array.isArray(data.conflictingThoughts) ? data.conflictingThoughts.length : 0;
    return `Contradiction analysis: ${count} finding(s)${data.conflictType ? ` (${data.conflictType})` : ''}`;
  });
}

function companyQueryCommand(cli, args, opts, command) {
  cli.ensureCompanyCapabilities();
  const run = cli.kernel.runCapability('companyBrain', {
    action: 'query',
    question: String(args || '').trim(),
  });
  return Promise.resolve(run).then(result => {
    if (!result || result.ok === false) {
      return commandFailure(`Query error: ${result?.error || 'unknown error'}`, opts);
    }
    return `Company Brain: ${result.answer}\nKaynak: ${result.source}\nRefs: ${(result.sourceRefs || []).join(', ') || 'yok'}`;
  });
}

function ingestStatusCommand(cli, args, opts, command) {
  cli.ensureCompanyCapabilities();
  const run = cli.kernel.runCapability('ingestStatus', {});
  return Promise.resolve(run).then(result => {
    if (!result || result.ok === false) {
      return commandFailure(`Ingest status error: ${result?.error || 'unknown error'}`, opts);
    }
    const dist = result.distribution || {};
    return `Ingest status -> node:${result.totalNodes} repo:${dist.repo || 0} markdown:${dist.markdown || 0} json:${dist.json || 0} yaml:${dist.yaml || 0} gitlog:${dist['git-log'] || 0} pdf:${dist.pdf || 0} http:${dist.http || 0} manual:${dist.manual || 0}`;
  });
}

module.exports = {
  ideaMriCommand,
  debateCommand,
  contradictionCommand,
  companyQueryCommand,
  ingestStatusCommand,
};
