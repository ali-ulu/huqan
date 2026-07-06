const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const repoPath = 'C:/Users/sonfi/Desktop/huqan/axiom-main-clean';
const toggMcpDir = path.join(repoPath, 'evidence', 'togg-mcp');

test('HUQAN MCP Persistent togg-safety-persistence validations', async (t) => {
  // 1. Verify evidence folder exists
  assert.ok(fs.existsSync(toggMcpDir), "evidence/togg-mcp directory should exist");

  // 2. Find the latest run_id folder
  const runs = fs.readdirSync(toggMcpDir).filter(f => f.startsWith('run_'));
  assert.ok(runs.length > 0, "At least one run should exist");

  // Sort runs to get the latest one
  runs.sort();
  const latestRunId = runs[runs.length - 1];
  const runDir = path.join(toggMcpDir, latestRunId);
  console.log(`Running assertions against latest run: ${latestRunId}`);

  // 3. Verify files exist in the latest run directory
  const requiredFiles = [
    '00_db_before.json',
    '01_tools_list.raw.json',
    '02_store_rules.raw.json',
    '03_axiom_plan.raw.json',
    '04_axiom_verify_togg.raw.json',
    '05_db_after.json',
    'transcript.ndjson',
    'run_manifest.json'
  ];

  for (const file of requiredFiles) {
    const filePath = path.join(runDir, file);
    assert.ok(fs.existsSync(filePath), `Evidence file should exist: ${file}`);
  }

  // 4. Validate tools list
  const toolsListRaw = JSON.parse(fs.readFileSync(path.join(runDir, '01_tools_list.raw.json'), 'utf8'));
  const tools = toolsListRaw.result?.tools || [];
  const toolNames = tools.map(t => t.name);

  assert.ok(toolNames.includes('axiom.ask'), "tools/list should include axiom.ask");
  assert.ok(toolNames.includes('axiom.plan'), "tools/list should include axiom.plan");
  assert.ok(toolNames.includes('axiom.verify'), "tools/list should include axiom.verify");
  assert.ok(toolNames.includes('axiom.dream'), "tools/list should include axiom.dream");

  // 5. Validate plan call response structure
  const planRaw = JSON.parse(fs.readFileSync(path.join(runDir, '03_axiom_plan.raw.json'), 'utf8'));
  const planContentText = planRaw.result?.content?.[0]?.text || '';
  assert.ok(planContentText.includes('"type": "plan"'), "plan call should return plan type");

  // 6. Validate verify contradiction output
  const verifyRaw = JSON.parse(fs.readFileSync(path.join(runDir, '04_axiom_verify_togg.raw.json'), 'utf8'));
  const verifyContentText = verifyRaw.result?.content?.[0]?.text || '';

  assert.ok(verifyContentText.includes('"status": "celiski"'), "verify call should return celiski status");
  assert.ok(verifyContentText.includes('"confidence": 0.9') || verifyContentText.includes('"confidence": 0.95'), "verify call should return confidence >= 0.9");
  assert.ok(verifyContentText.includes('NEGATION_CONFLICT'), "verify warnings should include NEGATION_CONFLICT");
  assert.ok(verifyContentText.includes('HIGH_RISK_DOMAIN') || verifyContentText.includes('security'), "verify warnings should include HIGH_RISK_DOMAIN / security");

  // 7. Validate transcript content
  const transcriptContent = fs.readFileSync(path.join(runDir, 'transcript.ndjson'), 'utf8');
  assert.ok(transcriptContent.trim().length > 0, "transcript.ndjson should not be empty");

  const lines = transcriptContent.split('\n').filter(Boolean);
  assert.ok(lines.length >= 8, "transcript.ndjson should contain at least 8 json-rpc logs");

  // Verify JSON structure of first log
  const firstLog = JSON.parse(lines[0]);
  assert.ok(firstLog.timestamp, "logs should have a timestamp");
  assert.ok(firstLog.type === 'request' || firstLog.type === 'response', "logs should have type request or response");
  assert.ok(firstLog.data, "logs should have data");
});
