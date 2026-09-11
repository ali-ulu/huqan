'use strict';

/**
 * Every MCP tool response hands the caller a `receiptId`. Until this tool
 * existed, nothing over MCP could read that receipt back.
 *
 * `huqan.trust_receipt` searches by what the receipt is *about* -- targetId,
 * provenanceId, sourceRef, candidateId, eventType -- and has no receiptId
 * input at all. Reading one receipt by its own id lived only on
 * `GET /api/v2/trust-receipts/{id}`, so an operator working through an MCP
 * client was handed an identifier for a document they could not open without
 * switching to HTTP or the CLI.
 *
 * The read verdict is forwarded exactly as readReceiptById states it. That
 * matters more here than in most tools: a receipt whose chain does not validate
 * is returned with `ok:false` on purpose (#766), and a surface that flattened
 * that into "found" would be reporting a broken transcript as canonical.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { executeMcpTrustReceiptDetail } = require('../lib/mcp/trust-receipt-detail-tool');
const { workflowForMcpTool, workflowForId } = require('../lib/workflow-contract');
const { MCP_TOOL_CLASSIFICATIONS } = require('../lib/mcp-gate-adapter');
const { TOOL_SCHEMAS } = require('../mcpServer');

const TOOL = 'huqan.trust_receipt_detail';
const ALLOW = { decision: 'allow', reason: 'read_only', requiredReview: false, canExecute: true };

const fixtureDir = path.join(__dirname, 'fixtures', 'receipt-trust-root');
const baseReceipt = fs.readdirSync(fixtureDir)
  .filter((name) => name.endsWith('.json'))
  .map((name) => JSON.parse(fs.readFileSync(path.join(fixtureDir, name), 'utf8')))
  .find((fixture) => fixture.caseId === 'RTR-001-V1-CANONICAL-BYTES').input.receipt;

/** A kernel whose graph is the audit event sequence the read index walks. */
function kernelWithReceipts(receipts) {
  return { graph: receipts.map((receipt) => ({ workspaceId: receipt.workspaceId, details: { receipt } })) };
}

function validReceipt(overrides) {
  return { ...structuredClone(baseReceipt), ...overrides };
}

test('reads a receipt back by the id every tool response hands out', () => {
  const receipt = validReceipt({ receiptId: 'mcp-detail-found', admissionId: 'mcp-detail-found-a' });
  const kernel = kernelWithReceipts([receipt]);

  const result = executeMcpTrustReceiptDetail({
    kernel,
    name: TOOL,
    args: { workspaceId: receipt.workspaceId, receiptId: 'mcp-detail-found' },
    gate: ALLOW,
  });

  assert.equal(result.ok, true);
  assert.equal(result.data.receiptId, 'mcp-detail-found');
  assert.equal(result.workflowId, 'trust-receipt-detail');
});

test('an id that is not there is reported as not found, never as an empty receipt', () => {
  const kernel = kernelWithReceipts([validReceipt({ receiptId: 'other', admissionId: 'other-a' })]);

  const result = executeMcpTrustReceiptDetail({
    kernel,
    name: TOOL,
    args: { workspaceId: baseReceipt.workspaceId, receiptId: 'no-such-receipt' },
    gate: ALLOW,
  });

  assert.equal(result.ok, false);
  assert.ok(result.error?.code, 'a failed read must name its code');
  assert.equal(result.data, null);
});

// The read index deliberately refuses to call a receipt with a broken chain
// "found" (#766). Forwarding its verdict unchanged is what keeps this surface
// from doing what the viewer once did: printing "Receipt found." over a chain
// that does not validate.
test('a receipt whose chain does not validate is not reported as found', () => {
  const selected = validReceipt({ receiptId: 'mcp-detail-chain', admissionId: 'mcp-detail-chain-a' });
  const breaker = validReceipt({
    receiptId: 'mcp-detail-breaker',
    admissionId: 'mcp-detail-breaker-a',
    canonicalReceiptSchemaVersion: 'v4-receipt-v2',
  });
  delete breaker.trustRoot;
  const kernel = kernelWithReceipts([selected, breaker]);

  const result = executeMcpTrustReceiptDetail({
    kernel,
    name: TOOL,
    args: { workspaceId: selected.workspaceId, receiptId: 'mcp-detail-chain' },
    gate: ALLOW,
  });

  assert.equal(result.ok, false, 'a broken chain must not read as found');
});

test('workspaceId and receiptId are both required', () => {
  const kernel = kernelWithReceipts([validReceipt({ receiptId: 'x', admissionId: 'x-a' })]);

  for (const args of [{ receiptId: 'x' }, { workspaceId: baseReceipt.workspaceId }, {}]) {
    const result = executeMcpTrustReceiptDetail({ kernel, name: TOOL, args, gate: ALLOW });
    assert.equal(result.ok, false, JSON.stringify(args));
    assert.equal(result.error.code, 'INVALID_INPUT', JSON.stringify(args));
  }
});

// The wiring surfaces a new MCP tool has to reach. Each one that is skipped
// fails somewhere that does not name the cause: a missing contract entry throws
// a TypeError inside an unrelated contract test, a missing gate entry is a
// silent classification default.
test('the tool is declared everywhere an MCP tool has to be declared', () => {
  const workflow = workflowForId('trust-receipt-detail');

  assert.equal(workflow.mcpTool, TOOL, 'the workflow contract must name the tool');
  assert.equal(workflow.availability.mcp, true);
  assert.equal(workflowForMcpTool(TOOL)?.workflowId, 'trust-receipt-detail');

  const policy = MCP_TOOL_CLASSIFICATIONS[TOOL];
  assert.equal(policy?.mutating, false, 'reading a receipt mutates nothing');
  assert.equal(policy?.category, 'read');

  const schema = TOOL_SCHEMAS.find((entry) => entry.name === TOOL);
  assert.ok(schema, 'the tool must appear in the advertised catalog');
  assert.deepEqual(schema.inputSchema.required.slice().sort(), ['receiptId', 'workspaceId']);
  assert.equal(schema.annotations.readOnlyHint, true);
});
