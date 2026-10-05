'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createServer } = require('../mcpServer');
const {
  FILTER_AUDIT_VERSION,
  FILTER_REASONS,
  auditToolSurfaceFilter,
} = require('../lib/mcp/tool-surface-filter-audit');
const {
  MODEL_VISIBLE_TOOL_SCHEMAS,
  OPERATOR_TOOL_SCHEMAS,
} = require('../lib/mcp/tool-surface');
const { stableStringify, sha256Hex } = require('../lib/receipt/canonical-receipt');

const OPERATOR_TOOL_NAMES = [
  'huqan.approve',
  'huqan.approvals',
  'huqan.approval_detail',
  'huqan.agent_resume',
  'huqan.emergency_stop',
];

function listResult() {
  const server = createServer({ operatorToken: 'test-operator' });
  const response = server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
  assert.ok(response.result, 'tools/list must return a result');
  return response.result;
}

test('#3482 tools/list carries the filter audit record without touching the tools array', () => {
  const result = listResult();
  assert.equal(result.tools.length, 26, 'the advertised tools array must stay exactly 26');

  const audit = result._meta && result._meta.filterAudit;
  assert.ok(audit, 'tools/list must carry _meta.filterAudit');
  assert.equal(audit.version, FILTER_AUDIT_VERSION);
  assert.equal(
    audit.records.length,
    MODEL_VISIBLE_TOOL_SCHEMAS.length + OPERATOR_TOOL_SCHEMAS.length,
    'the record covers every served and every withheld tool',
  );

  // The hash is recomputable from the records: anyone holding the response
  // can prove it was not edited after the audit ran.
  assert.equal(audit.recordHash, sha256Hex(stableStringify(audit.records)));
});

test('#3482 every withheld operator tool is recorded block with its reason', () => {
  const { records } = listResult()._meta.filterAudit;
  const byTool = new Map(records.map((record) => [record.tool, record]));

  for (const name of OPERATOR_TOOL_NAMES) {
    const record = byTool.get(name);
    assert.ok(record, `${name} must have a filter audit record`);
    assert.equal(record.visible, false);
    assert.equal(record.decision, 'block');
    assert.equal(record.reason, FILTER_REASONS.OPERATOR_WITHHELD);
  }

  for (const schema of MODEL_VISIBLE_TOOL_SCHEMAS) {
    const record = byTool.get(schema.name);
    assert.ok(record, `${schema.name} must have a filter audit record`);
    assert.equal(record.visible, true);
    assert.equal(record.decision, 'allow');
    assert.equal(record.reason, FILTER_REASONS.MODEL_VISIBLE);
  }
});

test('#3482 a tool on both sides is recorded fail-closed as a surface conflict', () => {
  const audit = auditToolSurfaceFilter({
    visibleSchemas: [{ name: 'huqan.ask' }],
    operatorSchemas: [{ name: 'huqan.ask' }],
  });
  assert.equal(audit.records.length, 2);
  const withheld = audit.records.find((record) => record.visible === false);
  assert.equal(withheld.tool, 'huqan.ask');
  assert.equal(withheld.decision, 'block');
  assert.equal(withheld.reason, FILTER_REASONS.SURFACE_CONFLICT);
  assert.equal(audit.recordHash, sha256Hex(stableStringify(audit.records)));
});

test('#3482 tampering with a record breaks the hash, malformed input throws', () => {
  const audit = auditToolSurfaceFilter({
    visibleSchemas: MODEL_VISIBLE_TOOL_SCHEMAS,
    operatorSchemas: OPERATOR_TOOL_SCHEMAS,
  });
  const tampered = audit.records.map((record) =>
    record.tool === 'huqan.approve' ? { ...record, reason: FILTER_REASONS.MODEL_VISIBLE } : record,
  );
  assert.notEqual(
    sha256Hex(stableStringify(tampered)),
    audit.recordHash,
    'a reason rewritten after the audit must not verify',
  );

  assert.throws(
    () => auditToolSurfaceFilter({ visibleSchemas: [], operatorSchemas: null }),
    TypeError,
  );
  assert.throws(
    () => auditToolSurfaceFilter({ visibleSchemas: [{ title: 'no-name' }], operatorSchemas: [] }),
    TypeError,
  );
});
