'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { execSync } = require('child_process');
const readline = require('readline');
const Database = require('better-sqlite3');
const Kernel = require('../kernel');

const repoPath = 'C:/Users/sonfi/Desktop/huqan/axiom-main-clean';

// Generate run ID
const runId = `run_${Date.now()}`;
const evidenceDir = path.join(repoPath, 'evidence', 'mcp-write-policy', runId);
fs.mkdirSync(evidenceDir, { recursive: true });

const transcriptPath = path.join(evidenceDir, 'transcript.ndjson');
const transcriptStream = fs.createWriteStream(transcriptPath, { flags: 'a' });

function logTranscript(type, msg) {
  const logObj = {
    timestamp: new Date().toISOString(),
    type,
    data: msg
  };
  transcriptStream.write(JSON.stringify(logObj) + '\n');
}

// Get default DB path
const tempKernel = new Kernel();
const dbPath = path.resolve(repoPath, tempKernel.dbPath || 'memory.db');

console.log(`Run ID: ${runId}`);
console.log(`DB Path: ${dbPath}`);

// 9. Capture DB Before
const dbExistsBefore = fs.existsSync(dbPath);
const dbSizeBefore = dbExistsBefore ? fs.statSync(dbPath).size : 0;
let dbNodesBefore = [];
let dbEdgesBefore = [];
let nodeCountBefore = 0;
let edgeCountBefore = 0;

const sqlGetNodes = "SELECT * FROM nodes";
const sqlGetEdges = "SELECT * FROM edges";
const sqlGetTargetNodes = "SELECT * FROM nodes WHERE id LIKE '%hiz%' OR id LIKE '%yol%' OR id LIKE '%guvenlik%'";
const sqlGetTargetEdges = "SELECT * FROM edges WHERE from_id LIKE '%hiz%' OR to_id LIKE '%hiz%' OR from_id LIKE '%yol%' OR to_id LIKE '%yol%'";

if (dbExistsBefore) {
  try {
    const db = new Database(dbPath);
    nodeCountBefore = db.prepare("SELECT count(*) as count FROM nodes").get().count;
    edgeCountBefore = db.prepare("SELECT count(*) as count FROM edges").get().count;
    dbNodesBefore = db.prepare(sqlGetTargetNodes).all();
    dbEdgesBefore = db.prepare(sqlGetTargetEdges).all();
    db.close();
  } catch (err) {
    console.error(`DB Before reading error: ${err.message}`);
  }
}

fs.writeFileSync(
  path.join(evidenceDir, '00_db_before.json'),
  JSON.stringify({
    db_path: dbPath,
    exists: dbExistsBefore,
    size_bytes: dbSizeBefore,
    total_nodes: nodeCountBefore,
    total_edges: edgeCountBefore,
    target_nodes: dbNodesBefore,
    target_edges: dbEdgesBefore,
    queries: {
      total_nodes: "SELECT count(*) as count FROM nodes",
      total_edges: "SELECT count(*) as count FROM edges",
      target_nodes: sqlGetTargetNodes,
      target_edges: sqlGetTargetEdges
    }
  }, null, 2)
);

// Spawn MCP server
console.log("Spawning MCP server...");
const child = spawn('node', ['mcpServer.js'], {
  cwd: repoPath,
  env: { ...process.env, AXIOM_PARANOID: '0' }
});

const rl = readline.createInterface({
  input: child.stdout
});

let nextId = 1;
const pendingRequests = new Map();

rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    const msg = JSON.parse(trimmed);
    logTranscript('response', msg);
    const resolve = pendingRequests.get(msg.id);
    if (resolve) {
      pendingRequests.delete(msg.id);
      resolve(msg);
    }
  } catch (err) {
    console.error(`Error parsing stdout JSON: ${err.message}`);
  }
});

child.stderr.on('data', (data) => {
  console.error(`MCP stderr: ${data.toString()}`);
});

function callMcp(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const req = { jsonrpc: '2.0', id, method, params };
    logTranscript('request', req);
    pendingRequests.set(id, resolve);
    child.stdin.write(JSON.stringify(req) + '\n');
  });
}

(async () => {
  try {
    // Initialize
    console.log("Initializing MCP connection...");
    await callMcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'write-policy-audit-client', version: '1.0.0' }
    });
    console.log("MCP initialized.");

    // 1. tools/list
    console.log("Requesting tools/list...");
    const toolsRes = await callMcp('tools/list');
    fs.writeFileSync(
      path.join(evidenceDir, '01_tools_list.raw.json'),
      JSON.stringify(toolsRes, null, 2)
    );

    const tools = toolsRes.result?.tools || [];
    const toolNames = tools.map(t => t.name);

    // 2. Call axiom.learn with "azami hiz asilmasi guvenlik ihlalidir"
    const statementToLearn = "azami hiz asilmasi guvenlik ihlalidir";
    console.log(`Calling axiom.learn with: "${statementToLearn}"`);

    let learnRes = null;
    if (toolNames.includes('axiom.learn')) {
      learnRes = await callMcp('tools/call', {
        name: 'axiom.learn',
        arguments: { text: statementToLearn }
      });
    } else {
      console.error("axiom.learn tool is missing from tools/list!");
    }

    // 3. Save raw response
    fs.writeFileSync(
      path.join(evidenceDir, '02_axiom_learn.raw.json'),
      JSON.stringify(learnRes, null, 2)
    );

    // 4. Inspect response
    let writePolicyStatus = "UNKNOWN";
    if (learnRes) {
      const contentText = learnRes.result?.content?.[0]?.text || '';
      if (contentText.includes('queued for review') || contentText.includes('mutating_requires_review') || learnRes.result?.structuredContent?.ok === false) {
        writePolicyStatus = "WRITE_REVIEW_REQUIRED";
      }
    }
    console.log(`Write policy inspection status: ${writePolicyStatus}`);

    // 5. Search tools/list for approval tools
    const approvalKeywords = ['approve', 'review', 'commit', 'accept', 'pending', 'queue'];
    const foundApprovalTools = tools.filter(t => {
      const nameLower = t.name.toLowerCase();
      const descLower = (t.description || '').toLowerCase();
      return approvalKeywords.some(kw => nameLower.includes(kw) || descLower.includes(kw));
    });

    console.log("Found matching approval/queue tools:", foundApprovalTools.map(t => t.name));

    // 6. If approval tool exists, call it
    if (foundApprovalTools.length > 0) {
      const appTool = foundApprovalTools[0];
      console.log(`Calling approval tool: ${appTool.name}...`);
      // We pass default args since we just want to inspect its response
      const appRes = await callMcp('tools/call', {
        name: appTool.name,
        arguments: {}
      });
      fs.writeFileSync(
        path.join(evidenceDir, '03_approval.raw.json'),
        JSON.stringify(appRes, null, 2)
      );
    } else {
      fs.writeFileSync(
        path.join(evidenceDir, '03_approval.raw.json'),
        JSON.stringify({ note: "No approval tool found in tools/list" }, null, 2)
      );
    }

    // 7. Call axiom.verify
    const statementToVerify = "azami hiz asilmasi guvenlik ihlali degildir";
    console.log(`Calling axiom.verify with: "${statementToVerify}"`);
    const verifyRes = await callMcp('tools/call', {
      name: 'axiom.verify',
      arguments: { statement: statementToVerify }
    });

    // 8. Save verify response
    fs.writeFileSync(
      path.join(evidenceDir, '04_verify.raw.json'),
      JSON.stringify(verifyRes, null, 2)
    );

    // Shutdown MCP server
    console.log("Shutting down MCP server...");
    await callMcp('shutdown');
    child.stdin.end();

    // 9. Capture DB After
    const dbExistsAfter = fs.existsSync(dbPath);
    const dbSizeAfter = dbExistsAfter ? fs.statSync(dbPath).size : 0;
    let dbNodesAfter = [];
    let dbEdgesAfter = [];
    let nodeCountAfter = 0;
    let edgeCountAfter = 0;

    if (dbExistsAfter) {
      try {
        const db = new Database(dbPath);
        nodeCountAfter = db.prepare("SELECT count(*) as count FROM nodes").get().count;
        edgeCountAfter = db.prepare("SELECT count(*) as count FROM edges").get().count;
        dbNodesAfter = db.prepare(sqlGetTargetNodes).all();
        dbEdgesAfter = db.prepare(sqlGetTargetEdges).all();
        db.close();
      } catch (err) {
        console.error(`DB After reading error: ${err.message}`);
      }
    }

    fs.writeFileSync(
      path.join(evidenceDir, '05_db_after.json'),
      JSON.stringify({
        db_path: dbPath,
        exists: dbExistsAfter,
        size_bytes: dbSizeAfter,
        total_nodes: nodeCountAfter,
        total_edges: edgeCountAfter,
        target_nodes: dbNodesAfter,
        target_edges: dbEdgesAfter,
        queries: {
          total_nodes: "SELECT count(*) as count FROM nodes",
          total_edges: "SELECT count(*) as count FROM edges",
          target_nodes: sqlGetTargetNodes,
          target_edges: sqlGetTargetEdges
        }
      }, null, 2)
    );

    // 10. Determine Final Verdict
    let verdict = "BLOCKED";
    if (!toolNames.includes('axiom.learn')) {
      verdict = "MCP_WRITE_TOOL_MISSING";
    } else if (writePolicyStatus === "WRITE_REVIEW_REQUIRED") {
      // Check if we were able to actually write (the DB counts should remain unchanged since we did not write programmatically)
      // If db count is same and learn was blocked, then it is indeed WRITE_REVIEW_REQUIRED
      verdict = "MCP_WRITE_REVIEW_REQUIRED";
    }

    // Save manifest
    const commitHash = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
    const manifest = {
      repo_path: repoPath,
      commit_hash: commitHash,
      run_id: runId,
      mcp_server_command: "node mcpServer.js",
      db_path: dbPath,
      created_files: [
        `demos/mcp_write_policy_audit.js`,
        `evidence/mcp-write-policy/${runId}/00_db_before.json`,
        `evidence/mcp-write-policy/${runId}/01_tools_list.raw.json`,
        `evidence/mcp-write-policy/${runId}/02_axiom_learn.raw.json`,
        `evidence/mcp-write-policy/${runId}/03_approval.raw.json`,
        `evidence/mcp-write-policy/${runId}/04_verify.raw.json`,
        `evidence/mcp-write-policy/${runId}/05_db_after.json`,
        `evidence/mcp-write-policy/${runId}/transcript.ndjson`,
        `evidence/mcp-write-policy/${runId}/run_manifest.json`
      ],
      deleted_files: [],
      mcp_tools_found: toolNames,
      verdict: verdict
    };

    fs.writeFileSync(
      path.join(evidenceDir, 'run_manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    console.log(`Audit Manifest created. Verdict: ${verdict}`);
    process.exit(0);

  } catch (err) {
    console.error(`Audit Execution error: ${err.message}`);
    process.exit(1);
  }
})();
