'use strict';

const fs = require('node:fs');
const { PARITY_CLAIM, PARITY_WORKSPACE, SMOKE_API_KEY, SMOKE_OPERATOR_TOKEN, fail, ok, run, installedServerPath, installedMcpPath, parseJsonLines, makeSurfaceEnv } = require('./launch-installed-package-smoke-context');
const { validateApprovedReceipt } = require('./launch-smoke-receipts');
const { buildRestProbe } = require('./launch-installed-package-smoke-rest-probe');

function verifyServerApprovedReceiptAndViewer(consumer, baseEnv) {
  const serverPath = installedServerPath(consumer);
  const mcpPath = installedMcpPath(consumer);
  if (!fs.existsSync(serverPath) || !fs.existsSync(mcpPath)) {
    fail('installed package does not contain server.js and mcpServer.js');
    return null;
  }

  const probe = buildRestProbe({ serverPath, mcpPath, PARITY_CLAIM, PARITY_WORKSPACE, SMOKE_API_KEY, SMOKE_OPERATOR_TOKEN });

  const env = {
    ...makeSurfaceEnv(baseEnv, consumer, 'rest-parity'),
    HUQAN_API_KEY: SMOKE_API_KEY,
    HUQAN_MCP_OPERATOR_TOKEN: SMOKE_OPERATOR_TOKEN,
    HUQAN_VIEWER_INSECURE_LOOPBACK: '1',
  };
  const result = run(process.execPath, ['-e', probe], {
    cwd: consumer,
    env,
    timeoutMs: 90 * 1000,
  });

  if (result.status !== 0) {
    fail(`installed server approved-receipt/viewer smoke failed\n${result.output.slice(-3500)}`);
    return null;
  }
  const payload = parseJsonLines(result.stdout).find(value => value?.surface === 'rest');
  if (!payload) {
    fail(`installed server smoke emitted no REST parity payload\n${result.output.slice(-2500)}`);
    return null;
  }
  const semantics = validateApprovedReceipt('REST', payload.receipt, payload.approvalId, payload.refs, { fail, workspaceId: PARITY_WORKSPACE });
  if (!semantics) return null;
  if (payload.viewerReceipt?.receiptId !== payload.receipt.receiptId
      || payload.viewerReceipt?.approvalId !== payload.approvalId) {
    fail('authenticated /viewer returned a receipt that contradicts the approved REST receipt');
    return null;
  }

  ok('REST performs review -> scoped operator approval -> canonical write -> verify -> authenticated owned /viewer receipt');
  return { approvalId: payload.approvalId, receipt: payload.receipt, semantics };
}

module.exports = { verifyServerApprovedReceiptAndViewer };
