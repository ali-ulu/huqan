#!/usr/bin/env node
// HUQAN MCP Self-Test
//
// Bu script HUQAN MCP server'inin dogru calistigini dogrular.
// JSON-RPC 2.0 over stdio ile gercek MCP client gibi konusur.
//
// Kullanim:
//   1. Repo'yu klonlayin: git clone https://github.com/agiulucom42-del/axiom.git
//   2. cd axiom && npm ci --include=optional
//   3. node egitim.js   (5 saniye, graph'i olusturur)
//   4. node examples/mcp-self-test.js
//
// Cikti: initialize handshake + tools/list + 7 tool cagrisi (ask/verify/reason/compare/dream)
//
// Not: Bu script sadece OKUMA yapar (read-only). Graph'a yeni bilgi eklemez.
// axiom.learn default olarak "review" durumundadir (V2.6 MCP gate).

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MCP_SERVER = path.join(REPO_ROOT, 'mcpServer.js');

// --- Config ---
const MEMORY_PATH = process.env.AXIOM_MEMORY_PATH || path.join(REPO_ROOT, 'memory.json');
const DB_PATH = process.env.AXIOM_DB_PATH || MEMORY_PATH.replace(/\.json$/, '.db');

console.log('=== HUQAN MCP Self-Test ===');
console.log('Repo root  :', REPO_ROOT);
console.log('MCP server :', MCP_SERVER);
console.log('Memory path:', MEMORY_PATH);
console.log('DB path    :', DB_PATH);
console.log('');

// Memory dosyalari var mi kontrol et
if (!fs.existsSync(MEMORY_PATH)) {
  console.error('ERROR: memory.json bulunamadi.');
  console.error('Once "node egitim.js" calistirin (5 saniye surer).');
  process.exit(1);
}

// --- MCP server'i baslat ---
const proc = spawn('node', [MCP_SERVER], {
  cwd: REPO_ROOT,
  env: {
    ...process.env,
    AXIOM_MEMORY_PATH: MEMORY_PATH,
    AXIOM_DB_PATH: DB_PATH,
    AXIOM_USE_SQLITE: 'true',
  },
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buffer = '';
const pending = new Map();
let nextId = 1;
let passCount = 0;
let failCount = 0;

proc.stdout.on('data', (chunk) => {
  buffer += chunk.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const { resolve } = pending.get(msg.id);
        pending.delete(msg.id);
        resolve(msg);
      }
    } catch (e) {
      console.error('[parse-error]', line.slice(0, 200));
    }
  }
});

proc.stderr.on('data', (d) => {
  const s = d.toString();
  if (s.trim()) process.stderr.write('[mcp-stderr] ' + s);
});

function send(method, params = {}) {
  return new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, { resolve });
    proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        resolve({ error: { code: -32000, message: 'timeout (15s)' } });
      }
    }, 15000);
  });
}

function notify(method, params = {}) {
  proc.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function check(name, condition, details = '') {
  if (condition) {
    console.log('  [OK] ' + name + (details ? ' - ' + details : ''));
    passCount++;
  } else {
    console.log('  [FAIL] ' + name + (details ? ' - ' + details : ''));
    failCount++;
  }
}

async function main() {
  try {
    // --- 1) Initialize handshake ---
    console.log('--- 1) MCP initialize handshake ---');
    const init = await send('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'huqan-self-test', version: '1.0.0' },
    });

    if (init.error) {
      check('initialize handshake', false, init.error.message);
      return;
    }

    check('protocol version', init.result?.protocolVersion === '2025-06-18', init.result?.protocolVersion);
    check('server name', init.result?.serverInfo?.name === 'axiom', init.result?.serverInfo?.name);
    check('server version', init.result?.serverInfo?.version === '0.9.1', init.result?.serverInfo?.version);
    check('tools capability', !!init.result?.capabilities?.tools, JSON.stringify(init.result?.capabilities));

    notify('notifications/initialized');
    await new Promise(r => setTimeout(r, 500));

    // --- 2) tools/list ---
    console.log('');
    console.log('--- 2) tools/list ---');
    const tools = await send('tools/list', {});
    const toolList = tools.result?.tools || [];
    const toolNames = toolList.map(t => t.name).sort();
    const expectedTools = ['axiom.agent','axiom.approvals','axiom.ask','axiom.compare','axiom.dream','axiom.learn','axiom.plan','axiom.policy','axiom.reason','axiom.verify'];

    check('tool count = 10', toolList.length === 10, 'got ' + toolList.length);
    check('all expected tools present', JSON.stringify(toolNames) === JSON.stringify(expectedTools), toolNames.join(', '));

    // --- 3) axiom.ask ---
    console.log('');
    console.log('--- 3) axiom.ask ---');
    const ask = await send('tools/call', { name: 'axiom.ask', arguments: { question: 'felsefe nedir' } });
    const askData = ask.result?.structuredContent;
    check('ask returns answer', !!askData?.data?.answer, askData?.data?.answer || 'no answer');
    check('ask answer non-empty', (askData?.data?.answer || '').length > 0);

    // --- 4) axiom.verify (true claim) ---
    console.log('');
    console.log('--- 4) axiom.verify (true claim) ---');
    const vt = await send('tools/call', { name: 'axiom.verify', arguments: { statement: 'felsefe bilgelik sevgisidir' } });
    const vtData = vt.result?.structuredContent;
    check('verify returns status', !!vtData?.data?.status, vtData?.data?.status || 'no status');
    check('verify confidence is number', typeof vtData?.data?.confidence === 'number', String(vtData?.data?.confidence));
    check('verify has semantic trust', !!vtData?.meta?.semanticTrust, vtData?.meta?.semanticTrust?.classification);
    check('verify has reasoning trace', !!vtData?.meta?.reasoningTrace, vtData?.meta?.reasoningTrace?.traceId);
    check('verify has trust receipt preview', !!vtData?.meta?.trustReceiptPreview, String(vtData?.meta?.trustReceiptPreview?.canonical));

    // --- 5) axiom.verify (unknown claim) ---
    console.log('');
    console.log('--- 5) axiom.verify (unknown claim) ---');
    const vf = await send('tools/call', { name: 'axiom.verify', arguments: { statement: 'mars ucagini tastir' } });
    const vfData = vf.result?.structuredContent;
    check('verify unknown returns bilinmiyor', vfData?.data?.status === 'bilinmiyor', vfData?.data?.status);
    check('verify unknown confidence = 0', vfData?.data?.confidence === 0, String(vfData?.data?.confidence));

    // --- 6) axiom.reason ---
    console.log('');
    console.log('--- 6) axiom.reason ---');
    const reason = await send('tools/call', { name: 'axiom.reason', arguments: { subject: 'felsefe' } });
    const reasonData = reason.result?.structuredContent;
    check('reason returns data', !!reasonData?.data, JSON.stringify(reasonData?.data || {}).slice(0, 100));

    // --- 7) axiom.compare ---
    console.log('');
    console.log('--- 7) axiom.compare ---');
    const cmp = await send('tools/call', { name: 'axiom.compare', arguments: { left: 'mantik', right: 'felsefe' } });
    const cmpData = cmp.result?.structuredContent;
    check('compare returns data', !!cmpData?.data, JSON.stringify(cmpData?.data || {}).slice(0, 100));

    // --- 8) axiom.dream ---
    console.log('');
    console.log('--- 8) axiom.dream ---');
    const dream = await send('tools/call', { name: 'axiom.dream', arguments: { depth: 3 } });
    const dreamData = dream.result?.structuredContent;
    const hyps = dreamData?.data?.hypotheses || dreamData?.data?.dream?.hypotheses || [];
    check('dream returns hypotheses array', Array.isArray(hyps), 'got ' + hyps.length);
    check('dream generates >= 1 hypothesis', hyps.length >= 1, 'got ' + hyps.length);

    // --- 9) axiom.policy ---
    console.log('');
    console.log('--- 9) axiom.policy ---');
    const pol = await send('tools/call', { name: 'axiom.policy', arguments: { tool: 'axiom.verify' } });
    const polData = pol.result?.structuredContent;
    check('policy returns data', !!polData?.data, JSON.stringify(polData?.data || {}).slice(0, 100));

    // --- Summary ---
    console.log('');
    console.log('=== SUMMARY ===');
    console.log('Pass: ' + passCount);
    console.log('Fail: ' + failCount);
    console.log('');
    if (failCount === 0) {
      console.log('HUQAN MCP server sorunsuz calisiyor.');
      console.log('');
      console.log('Sonraki adim:');
      console.log('  1. Claude Desktop veya Cursor config dosyaniza HUQAN ekleyin');
      console.log('     (detaylar icin: examples/mcp-claude-config.json ve docs/mcp-quickstart.md)');
      console.log('  2. Claude\'da su komutu deneyin: "verify: felsefe bilgelik sevgisidir"');
      process.exit(0);
    } else {
      console.log('Bazi testler basarisiz. Lutfen yukaridaki [FAIL] satirlarini kontrol edin.');
      console.log('Cozum onerileri: docs/mcp-quickstart.md -> Troubleshooting bolumu');
      process.exit(1);
    }
  } catch (e) {
    console.error('HATA:', e.message);
    console.error(e.stack);
    process.exit(1);
  } finally {
    proc.kill('SIGTERM');
  }
}

main();
