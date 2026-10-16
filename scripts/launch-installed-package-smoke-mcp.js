'use strict';

const { PARITY_CLAIM, PARITY_WORKSPACE, SMOKE_OPERATOR_TOKEN, fail, ok, run, packageBin, installedMcpPath, parseJsonLines, makeSurfaceEnv } = require('./launch-installed-package-smoke-context');
const { validateApprovedReceipt, mcpVerifyIsVerified } = require('./launch-smoke-receipts');

function verifyMcpApprovedReceipt(binDir, consumer, baseEnv) {
  const mcpPath = packageBin(binDir, 'huqan-mcp');
  const env = makeSurfaceEnv(baseEnv, consumer, 'mcp-parity');
  const proposalRequests = [
    {
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-receipt-parity-smoke', version: '1' } },
    },
    {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: {
        name: 'huqan.learn',
        arguments: {
          text: PARITY_CLAIM,
          workspaceId: PARITY_WORKSPACE,
          provenance: { sourceType: 'manual', sourceRef: 'launch-smoke://mcp-parity' },
        },
      },
    },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'huqan.verify', arguments: { statement: PARITY_CLAIM, workspaceId: PARITY_WORKSPACE } },
    },
    { jsonrpc: '2.0', id: 4, method: 'shutdown', params: {} },
  ].map(value => JSON.stringify(value)).join('\n');

  const proposalRun = run(mcpPath, [], {
    cwd: consumer,
    env,
    input: `${proposalRequests}\n`,
    timeoutMs: 60 * 1000,
  });
  if (proposalRun.status !== 0) {
    fail(`MCP proposal process exited ${proposalRun.status}\n${proposalRun.output.slice(-2500)}`);
    return null;
  }
  const proposalMessages = parseJsonLines(proposalRun.stdout);
  const queued = proposalMessages.find(message => message?.id === 2)?.result?.structuredContent;
  const before = proposalMessages.find(message => message?.id === 3)?.result?.structuredContent;
  const approvalId = queued?.approval?.id;
  if (queued?.status !== 'review_required' || queued?.canonicalWrite !== false
      || queued?.approval?.persisted !== true || typeof approvalId !== 'string' || !approvalId) {
    fail(`MCP learn did not persist a non-executing review approval\n${JSON.stringify(queued || null).slice(-2500)}`);
    return null;
  }
  if (mcpVerifyIsVerified(before)) {
    fail(`MCP observed the claim as verified before approval\n${JSON.stringify(before).slice(-2000)}`);
    return null;
  }

  let mcpModule;
  try {
    mcpModule = require(installedMcpPath(consumer));
  } catch (error) {
    fail(`installed MCP module could not be loaded to mint a scoped operator capability: ${error.message}`);
    return null;
  }
  const approvalArgs = {
    approvalId,
    workspaceId: PARITY_WORKSPACE,
    decision: 'approved',
    reason: 'launch-smoke-parity',
  };
  let operatorCapability;
  try {
    operatorCapability = mcpModule.createMcpOperatorCapability({
      secret: SMOKE_OPERATOR_TOKEN,
      ...mcpModule.operatorCapabilityBinding('huqan.approve', approvalArgs),
    });
  } catch (error) {
    fail(`MCP operator capability could not be created: ${error.message}`);
    return null;
  }

  const approvalRequests = [
    {
      jsonrpc: '2.0', id: 10, method: 'initialize',
      params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'launch-receipt-parity-operator', version: '1' } },
    },
    {
      jsonrpc: '2.0', id: 11, method: 'tools/call',
      params: { name: 'huqan.approve', operatorCapability, arguments: approvalArgs },
    },
    {
      jsonrpc: '2.0', id: 12, method: 'tools/call',
      params: { name: 'huqan.verify', arguments: { statement: PARITY_CLAIM, workspaceId: PARITY_WORKSPACE } },
    },
    { jsonrpc: '2.0', id: 13, method: 'shutdown', params: {} },
  ].map(value => JSON.stringify(value)).join('\n');

  const approvalRun = run(mcpPath, [], {
    cwd: consumer,
    env,
    input: `${approvalRequests}\n`,
    timeoutMs: 60 * 1000,
  });
  if (approvalRun.status !== 0) {
    fail(`MCP approval process exited ${approvalRun.status}\n${approvalRun.output.slice(-3000)}`);
    return null;
  }
  const approvalMessages = parseJsonLines(approvalRun.stdout);
  const decision = approvalMessages.find(message => message?.id === 11)?.result?.structuredContent;
  const after = approvalMessages.find(message => message?.id === 12)?.result?.structuredContent;
  if (!decision || decision.ok !== true || decision?.data?.executed !== true) {
    fail(`MCP scoped operator approval did not execute\n${JSON.stringify(decision || null).slice(-2500)}`);
    return null;
  }
  const receipt = decision?.data?.receipt;
  const semantics = validateApprovedReceipt('MCP', receipt, approvalId, decision?.data?.refs, { fail, workspaceId: PARITY_WORKSPACE });
  if (!semantics) return null;
  if (!mcpVerifyIsVerified(after)) {
    fail(`MCP approval did not make the claim verifiable\n${JSON.stringify(after || null).slice(-2000)}`);
    return null;
  }

  ok('MCP performs review -> scoped operator approval -> canonical write -> verify -> receipt');
  return { approvalId, receipt, semantics };
}

module.exports = { verifyMcpApprovedReceipt };
