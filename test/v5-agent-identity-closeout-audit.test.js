const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const auditPath = path.join(
  __dirname,
  '..',
  'docs',
  'v5',
  'v5-agent-identity-closeout-audit.md'
);

function readAudit() {
  return fs.readFileSync(auditPath, 'utf8');
}

test('V5 agent identity closeout audit document exists', () => {
  assert.equal(fs.existsSync(auditPath), true);
});

test('V5 agent identity closeout audit lists completed chain layers', () => {
  const audit = readAudit();

  assert.match(audit, /V5-IMPL-1A - fixtures/);
  assert.match(audit, /V5-IMPL-1B - JSON schema/);
  assert.match(audit, /V5-IMPL-1C - validator/);
  assert.match(audit, /V5-IMPL-1D - conformance linkage/);
  assert.match(audit, /V5-IMPL-1E - coverage \/ non-enforcement manifest/);
  assert.match(audit, /V5-IMPL-1F - readiness index \/ boundary matrix/);
});

test('V5 agent identity closeout audit preserves explicit non-claims', () => {
  const audit = readAudit();

  assert.match(audit, /Runtime identity enforcement does not exist\./);
  assert.match(audit, /Connector identity enforcement does not exist\./);
  assert.match(audit, /A2A identity exchange does not exist\./);
  assert.match(audit, /Marketplace identity layer does not exist\./);
  assert.match(audit, /Trust Package writer\/reader does not exist\./);
  assert.match(audit, /AgentAction policy engine does not exist\./);
  assert.match(audit, /V5 is not complete\./);
});

test('V5 agent identity closeout audit gates V5-IMPL-2A after review merge and smoke', () => {
  const audit = readAudit();

  assert.match(
    audit,
    /V5-IMPL-2A may start only after this closeout audit is reviewed, merged, and\s+smoked\./
  );
  assert.match(
    audit,
    /V5-IMPL-2A must start as Shared Trust Package fixture\/schema work, not runtime\s+enforcement\./
  );
});

test('V5 agent identity closeout audit does not claim forbidden capabilities are implemented', () => {
  const audit = readAudit();
  const allowedClaims = audit.split('## Allowed Claims')[1] || '';
  const forbiddenImplementedClaims = [
    /runtime identity enforcement is implemented/i,
    /connector identity enforcement is implemented/i,
    /A2A identity exchange is implemented/i,
    /marketplace identity layer is implemented/i,
    /Trust Package writer\/reader is implemented/i,
    /AgentAction policy engine is implemented/i,
    /V5 is complete/i
  ];

  for (const claim of forbiddenImplementedClaims) {
    assert.equal(claim.test(allowedClaims), false);
  }
});
