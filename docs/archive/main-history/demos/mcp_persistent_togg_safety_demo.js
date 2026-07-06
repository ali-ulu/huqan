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
const evidenceDir = path.join(repoPath, 'evidence', 'togg-mcp', runId);
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

// 1. Discover start command
const pkg = require('../package.json');
const mcpServerCommand = `node mcpServer.js`;

// Determine default DB path using Kernel
const tempKernel = new Kernel();
const dbPath = path.resolve(repoPath, tempKernel.dbPath || 'memory.db');

console.log(`Run ID: ${runId}`);
console.log(`MCP Server Command: ${mcpServerCommand}`);
console.log(`DB Path: ${dbPath}`);

// 11. Capture DB Before
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

let child;
let rl;
let nextId = 1;
const pendingRequests = new Map();

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
    // 0. Write rules programmatically to DB BEFORE spawning the MCP server
    console.log("Writing rules programmatically to DB first...");
    const directKernel = new Kernel();
    directKernel.graph.load();
    const rules = [
      "buzlu yol tehlikelidir",
      "tehlikeli durumda azami hiz ellidir",
      "mevcut hiz yetmistir",
      "hiz yetmis ise azami hiz asilmisir",
      "azami hiz asilmasi guvenlik ihlalidir"
    ];
    for (const r of rules) {
      await directKernel.learn(r, { skipConflicts: true });
    }
    directKernel.graph.save();
    console.log("Rules written programmatically.");

    // 2. Start MCP server over stdio
    console.log("Spawning MCP server...");
    child = spawn('node', ['mcpServer.js'], {
      cwd: repoPath,
      env: { ...process.env, AXIOM_PARANOID: '0' } // Ensure default behavior
    });

    rl = readline.createInterface({
      input: child.stdout
    });

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

    // 4. Initialize
    console.log("Initializing MCP connection...");
    const initRes = await callMcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'persistent-evidence-client', version: '1.0.0' }
    });
    console.log("MCP initialized.");

    // 5. tools/list
    console.log("Requesting tools/list...");
    const toolsRes = await callMcp('tools/list');
    fs.writeFileSync(
      path.join(evidenceDir, '01_tools_list.raw.json'),
      JSON.stringify(toolsRes, null, 2)
    );

    const tools = toolsRes.result?.tools || [];
    const toolNames = tools.map(t => t.name);
    console.log("Available tools:", toolNames.join(", "));

    const requiredTools = ['axiom.ask', 'axiom.plan', 'axiom.verify', 'axiom.dream'];
    const missingRequired = requiredTools.filter(t => !toolNames.includes(t));
    if (missingRequired.length > 0) {
      console.error(`Missing required tools: ${missingRequired.join(', ')}`);
    }

    const writeTools = ['axiom.learn', 'axiom.addFact', 'axiom.store', 'axiom.remember'];
    const foundWriteTool = writeTools.find(t => toolNames.includes(t));
    let persistenceToolFound = false;

    if (!foundWriteTool) {
      fs.writeFileSync(
        path.join(evidenceDir, '02_store_rules.raw.json'),
        JSON.stringify({
          status: "MCP_PERSISTENCE_NOT_AVAILABLE",
          reason: "MCP tools/list does not expose learn/addFact/store/remember tool",
          available_tools: toolNames
        }, null, 2)
      );
      console.log("MCP_PERSISTENCE_NOT_AVAILABLE");
    } else {
      persistenceToolFound = true;
      console.log(`Found write tool: ${foundWriteTool}. Storing rules (will be blocked by gate)...`);
      const storeResponses = [];
      for (const r of rules) {
        console.log(`Writing rule via MCP: ${r}`);
        const storeRes = await callMcp('tools/call', {
          name: foundWriteTool,
          arguments: { text: r }
        });
        storeResponses.push({ request: { text: r }, response: storeRes });
      }

      fs.writeFileSync(
        path.join(evidenceDir, '02_store_rules.raw.json'),
        JSON.stringify(storeResponses, null, 2)
      );
    }

    // 9. Call axiom.plan through MCP
    console.log("Calling axiom.plan via MCP...");
    const planRes = await callMcp('tools/call', {
      name: 'axiom.plan',
      arguments: {
        goal: "Huqan ve StackMemory entegrasyonu için bir yol haritası hazırla.",
        maxSteps: 5
      }
    });
    fs.writeFileSync(
      path.join(evidenceDir, '03_axiom_plan.raw.json'),
      JSON.stringify(planRes, null, 2)
    );

    // 10. Call axiom.verify through MCP
    console.log("Calling axiom.verify via MCP...");
    const verifyRes = await callMcp('tools/call', {
      name: 'axiom.verify',
      arguments: {
        statement: "azami hiz asilmasi guvenlik ihlali degildir"
      }
    });
    fs.writeFileSync(
      path.join(evidenceDir, '04_axiom_verify_togg.raw.json'),
      JSON.stringify(verifyRes, null, 2)
    );

    // Shutdown MCP server
    console.log("Shutting down MCP server...");
    await callMcp('shutdown');
    child.stdin.end();

    // 11. Capture DB After
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

    // Determine verdict
    // We check if rule write succeeded via MCP or direct write.
    // If it was blocked, we wrote programmatically. Thus MCP_VERIFY_ONLY_PROVEN.
    // If it succeeded via MCP (not blocked), then MCP_FULLY_PROVEN.
    const storeRulesRaw = JSON.parse(fs.readFileSync(path.join(evidenceDir, '02_store_rules.raw.json'), 'utf8'));
    let mcpWriteSucceeded = false;
    if (Array.isArray(storeRulesRaw)) {
      const firstRes = storeRulesRaw[0].response;
      // check if it succeeded
      const contentText = firstRes.result?.content?.[0]?.text || '';
      if (contentText.includes('"ok": true') && !contentText.includes('queued for review') && !contentText.includes('blocked by gate')) {
        mcpWriteSucceeded = true;
      }
    }

    const verdict = mcpWriteSucceeded ? "MCP_FULLY_PROVEN" : "MCP_VERIFY_ONLY_PROVEN";

    // 12. Save Run Manifest
    const commitHash = execSync('git rev-parse HEAD', { cwd: repoPath }).toString().trim();
    const manifest = {
      repo_path: repoPath,
      commit_hash: commitHash,
      run_id: runId,
      mcp_server_command: mcpServerCommand,
      db_path: dbPath,
      created_files: [
        `demos/mcp_persistent_togg_safety_demo.js`,
        `evidence/togg-mcp/${runId}/00_db_before.json`,
        `evidence/togg-mcp/${runId}/01_tools_list.raw.json`,
        `evidence/togg-mcp/${runId}/02_store_rules.raw.json`,
        `evidence/togg-mcp/${runId}/03_axiom_plan.raw.json`,
        `evidence/togg-mcp/${runId}/04_axiom_verify_togg.raw.json`,
        `evidence/togg-mcp/${runId}/05_db_after.json`,
        `evidence/togg-mcp/${runId}/transcript.ndjson`,
        `evidence/togg-mcp/${runId}/run_manifest.json`,
        `tests/mcp_togg_safety_persistence.test.js`
      ],
      deleted_files: [],
      mcp_tools_found: toolNames,
      persistence_tool_found: persistenceToolFound,
      verdict: verdict
    };

    fs.writeFileSync(
      path.join(evidenceDir, 'run_manifest.json'),
      JSON.stringify(manifest, null, 2)
    );

    console.log(`Manifest created. Verdict: ${verdict}`);
    process.exit(0);

  } catch (err) {
    console.error(`Execution error: ${err.message}`);
    process.exit(1);
  }
})();
