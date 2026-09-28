'use strict';

// What each MCP tool does once the gate lets it execute, and what the dry run
// shows when it may only preview (#2142).

const {
  MCP_MAX_TEXT,
  MCP_MAX_GOAL,
  MCP_MAX_SHORT,
  sanitizeMcpString,
  boundedMcpInteger,
} = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');
const { executeMcpVerify, executeMcpReadWorkflow } = require('./read-workflow-tools');
const { buildIngestWorkflowPreview } = require('../ingest-workflow-preview');
const { readIngestRunStatus } = require('../mcp-ingest-status-tool');
const { buildMcpIngestExecuteResult } = require('../mcp-ingest-execute-tool');
const {
  listPersistentApprovals,
  countPersistentApprovals,
  countUnresolvedApprovals,
} = require('../mcp-approval-views');
const { createApprovalStoreFromKernel } = require('../mcp-approval-store');
const { canonicalMcpToolName } = require('../mcp-tool-names');
const { scrubSecrets } = require('../secret-scrub-gate');

// #2142: one handler per MCP tool; a new tool is a row, not a case. Handlers that
// require a module lazily keep a block body so require-scan still sees it as deferred.
function createMcpToolHandlers({ withTransientAgent }) {
  const readWorkflowTool = ({ kernel, name, args, gate }) => executeMcpReadWorkflow({ kernel, name, args, gate });
  return Object.freeze(Object.assign(Object.create(null), {
    'huqan.learn': ({ kernel, name, args, gate }) => withMcpToolVerdictSurface(kernel.learn(sanitizeMcpString(args.text, MCP_MAX_TEXT), {
      skipConflicts: args.skipConflicts !== false,
      maxSentences: args.maxSentences,
    }), name, args, gate),
    'huqan.ask': ({ kernel, name, args, gate }) => withMcpToolVerdictSurface(kernel.ask(sanitizeMcpString(args.question)), name, args, gate),
    'huqan.verify': ({ kernel, name, args, gate }) => executeMcpVerify({ kernel, name, args, gate }),
    'huqan.plan': ({ kernel, name, args, gate }) => withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
      agent.plan(sanitizeMcpString(args.goal, MCP_MAX_GOAL), { maxSteps: boundedMcpInteger(args.maxSteps, 4, 1, 8) }),
      name, args, gate,
    )),
    'huqan.agent': ({ kernel, name, args, gate }) => withTransientAgent(kernel, async (agent) => withMcpToolVerdictSurface(
      await agent.run(sanitizeMcpString(args.goal, MCP_MAX_GOAL), { maxSteps: boundedMcpInteger(args.maxSteps, 4, 1, 8) }),
      name, args, gate,
    )),
    'huqan.policy': ({ kernel, name, args, gate }) => withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
      agent.inspectToolPolicy(sanitizeMcpString(args.tool), sanitizeMcpString(args.input || '', MCP_MAX_TEXT), { goal: sanitizeMcpString(args.goal, MCP_MAX_GOAL) }),
      name, args, gate,
    )),
    'huqan.approval_detail': ({ kernel, name, args, gate, runtime }) => {
      return require('./approval-detail-tool').executeMcpApprovalDetail({ store: runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime), name, args, gate });
    },
    'huqan.approvals': ({ kernel, name, args, gate, runtime }) => {
      const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
      const approvalWorkspaceId = sanitizeMcpString(args.workspaceId, MCP_MAX_SHORT) || 'default';
      const approvalLimit = boundedMcpInteger(args.limit, 50, 1, 50);
      const storedApprovals = listPersistentApprovals(approvalStore, approvalLimit, approvalWorkspaceId);
      return withMcpToolVerdictSurface({
        pendingCount: countPersistentApprovals(approvalStore, approvalWorkspaceId),
        unresolvedCount: countUnresolvedApprovals(approvalStore, approvalWorkspaceId),
        approvals: storedApprovals.slice(0, approvalLimit),
      }, name, args, gate);
    },
    'huqan.reason': ({ kernel, name, args, gate }) => withMcpToolVerdictSurface(kernel.reason(sanitizeMcpString(args.subject)), name, args, gate),
    'huqan.compare': ({ kernel, name, args, gate }) => withMcpToolVerdictSurface(kernel.compare(sanitizeMcpString(args.left), sanitizeMcpString(args.right)), name, args, gate),
    'huqan.dream': ({ kernel, name, args, gate }) => withMcpToolVerdictSurface(kernel.dream({ depth: boundedMcpInteger(args.depth, 2, 1, 5) }), name, args, gate),
    'huqan.fractal-learn': ({ kernel, name, args, gate }) => {
      return require('./fractal-learn-tool').executeMcpFractalLearn(kernel, name, args, gate);
    },
    'huqan.self-evolve': ({ kernel, name, args, gate }) => {
      return require('./self-evolve-tool').executeMcpSelfEvolve(kernel, name, args, gate);
    },
    'huqan.advocate': readWorkflowTool, 'huqan.web_research': readWorkflowTool, 'huqan.search': readWorkflowTool,
    'huqan.trust_receipt': readWorkflowTool, 'huqan.trust_receipt_detail': readWorkflowTool, 'huqan.experience_read': readWorkflowTool,
    'huqan.status': readWorkflowTool, 'huqan.audit': readWorkflowTool,
    'huqan.ingest_preview': ({ kernel, name, args, gate }) => {
      const preview = buildIngestWorkflowPreview(args);
      const result = preview.ok
        ? kernel.ok('ingest_preview', Object.fromEntries(Object.entries(preview).filter(([key]) => key !== 'ok')))
        : kernel.fail('ingest_preview', preview.code || 'INGEST_PREVIEW_FAILED', preview.error || 'ingest preview failed');
      return withMcpToolVerdictSurface(result, name, args, gate);
    },
    'huqan.ingest_status': ({ kernel, name, args, gate, runtime }) => withMcpToolVerdictSurface(readIngestRunStatus(kernel, args, runtime), name, args, gate),
    'huqan.ingest_execute': ({ kernel, name, args, gate }) => withMcpToolVerdictSurface(buildMcpIngestExecuteResult(kernel, args, gate), name, args, gate),
  }));
}

function createReadOnlyDryRun({ withTransientAgent }) {
  return function executeReadOnlyDryRun(kernel, requestedName, args) {
    // Exported and called directly by tests/tooling, so it resolves the alias
    // itself rather than relying on callTool having canonicalized it.
    const name = canonicalMcpToolName(requestedName);
    switch (name) {
      case 'huqan.learn':
        return kernel.ask(`What would be learned from: ${(args.text || '').slice(0, 200)}`);
      case 'huqan.agent':
        return withTransientAgent(kernel, (agent) => (
          agent.plan
            ? agent.plan(sanitizeMcpString(args.goal, MCP_MAX_GOAL), {
              maxSteps: boundedMcpInteger(args.maxSteps, 1, 1, 8),
            })
            : { dryRun: true, goal: args.goal }
        ));
      default:
        return { dryRun: true, tool: name, args: scrubSecrets(args).scrubbed };
    }
  };
}

module.exports = {
  createMcpToolHandlers,
  createReadOnlyDryRun,
};
