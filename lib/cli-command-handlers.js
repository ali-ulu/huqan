'use strict';

// #3101: the CLI command table, moved out of cli.js unchanged with the eight
// modules only it used, so cli.js leaves the FANOUT tracker. The two MCP
// collaborators are passed in rather than required, so this module adds no
// edge to mcpServer.

const { cliHelpText } = require('./cli-help');
const { runCompanyIngest } = require('./cli-company-ingest');
const { runBackupCommand, runRestoreCommand } = require('./cli-backup-commands');
const { runStatusCommand, runDoctorCommand } = require('./cli-status-command');
const {
  teachCommand, verifyCommand, askCommand, reasonCommand, compareCommand, llmAskCommand,
  loadDocumentCommand, dreamCommand, persistCommand, thinkCommand,
} = require('./cli-knowledge-commands');
const {
  ideaMriCommand, debateCommand, contradictionCommand, companyQueryCommand, ingestStatusCommand,
} = require('./cli-capability-commands');
const {
  planCommand, agentRunCommand, hypothesesCommand, createQuickstartCommand,
} = require('./cli-agent-commands');
const { inferenceCommand } = require('./cli-inference-command');
const { conflictsCommand } = require('./cli-conflicts-command');
const {
  createApprovalCommands, auditCommand, receiptCommand, coderCommand,
} = require('./cli-approval-commands');
const { runExperienceReadCommand } = require('./cli-experience-read');
const { runExperienceLearnCommand } = require('./cli-experience-learn');
const { runExperienceReconcileCommand } = require('./cli-experience-reconcile');
const { runMemoryLifecycleCommand } = require('./cli-memory-lifecycle');
const { runPromoteCommand } = require('./cli-promote');
const { runMemoryQueryCommand } = require('./cli-memory-query');

// #2136: one handler per CLI command; a new command is a row, not a case. Handlers get the command context
// CLI#execute builds, not the instance; lazy requires keep a block body so require-scan still sees them deferred.
const canonicalMutationUnavailable = (cli, args, opts, command) => cli.formatCliGateMessage(command, { decision: 'block', reason: 'cli_canonical_mutation_unavailable' });

function createCliCommandHandlers({ callMcpTool, createApprovalStoreFromKernel }) {
  const { approvalListCommand, approvalDecisionCommand } = createApprovalCommands({ callMcpTool });
  const quickstartCommand = createQuickstartCommand({ callMcpTool, createApprovalStoreFromKernel });

  return Object.freeze(Object.assign(Object.create(null), {
    'öğret': (cli, ...rest) => teachCommand(cli, ...rest),
    'verify': (cli, ...rest) => verifyCommand(cli, ...rest),
    'sor': (cli, ...rest) => askCommand(cli, ...rest),
    'neden': (cli, ...rest) => reasonCommand(cli, ...rest),
    'karşılaştır': (cli, ...rest) => compareCommand(cli, ...rest),
    'mri': (cli, ...rest) => ideaMriCommand(cli, ...rest),
    'tartis': (cli, ...rest) => debateCommand(cli, ...rest),
    'celiski': (cli, ...rest) => contradictionCommand(cli, ...rest),
    'llm-sor': (cli, ...rest) => llmAskCommand(cli, ...rest),
    'plan': (cli, ...rest) => planCommand(cli, ...rest),
    'ajan': (cli, ...rest) => agentRunCommand(cli, ...rest),
    'yükle': (cli, ...rest) => loadDocumentCommand(cli, ...rest),
    'company-ingest': (cli, args, opts) => runCompanyIngest(cli, args, opts),
    'company-query': (cli, ...rest) => companyQueryCommand(cli, ...rest),
    'ingest-status': (cli, ...rest) => ingestStatusCommand(cli, ...rest),
    'backup': (cli) => runBackupCommand(cli),
    'kaydet': (cli, ...rest) => persistCommand(cli, ...rest),
    'onaylar': (cli, ...rest) => approvalListCommand(cli, ...rest),
    'onayla': (cli, ...rest) => approvalDecisionCommand(cli, ...rest),
    'audit': (cli, ...rest) => auditCommand(cli, ...rest),
    'receipt': (cli, ...rest) => receiptCommand(cli, ...rest),
    'coder': (cli, ...rest) => coderCommand(cli, ...rest),
    'restore': (cli, args, opts) => runRestoreCommand(cli, args, opts),
    'düşün': (cli, ...rest) => thinkCommand(cli, ...rest),
    'optimize': canonicalMutationUnavailable, 'konsolide': canonicalMutationUnavailable, 'evolve': canonicalMutationUnavailable,
    'quickstart': (cli, ...rest) => quickstartCommand(cli, ...rest),
    'durum': (cli) => runStatusCommand(cli),
    'experience-read': (cli, args) => runExperienceReadCommand({
      args,
      experienceJournal: cli.kernel?.experienceJournal || null,
    }),
    'experience-learn': (cli, args) => runExperienceLearnCommand({
      args,
      experienceJournal: cli.kernel?.experienceJournal || null,
    }),
    'experience-reconcile': (cli, args) => runExperienceReconcileCommand({ args, agent: cli.agent }),
    'memory-lifecycle': (cli, args) => runMemoryLifecycleCommand(cli, args),
    'terfi': (cli, args, opts) => runPromoteCommand(cli, args, opts),
    'memory-query': (cli, args) => runMemoryQueryCommand(cli, args, callMcpTool),
    'doctor': (cli) => runDoctorCommand({ rootDir: process.cwd(), kernel: cli.kernel }),
    'rüya': (cli, ...rest) => dreamCommand(cli, ...rest),
    'hypotheses': (cli, ...rest) => hypothesesCommand(cli, ...rest),
    'inference': (cli, ...rest) => inferenceCommand(cli, ...rest),
    'conflicts': (cli, ...rest) => conflictsCommand(cli, ...rest),
    'selam': (cli, args, opts, command) => 'Hello! You can teach me something or ask me a question.',
    'yardım': (cli, args, opts, command) => cliHelpText(),
    'anlamadım': (cli, args, opts, command) => 'I did not understand. Write a longer sentence, or type "yardım" for help.',
  }));
}

module.exports = { createCliCommandHandlers };
