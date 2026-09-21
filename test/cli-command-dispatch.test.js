'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2136 (#2123): CLI#execute ran every command through a 34-label switch, and
// CLI#evaluateCliGate built each mapped MCP tool's gate arguments through a
// 6-case switch. Both grow with every new command or tool, and both are now
// tables. The first block drives every command through execute with recording
// collaborators and pins each command's calls and output, plus the gate
// arguments, to digests recorded on main, so any drift is caught.
//
// The imports the command bodies call are stubbed before cli.js loads, because
// it destructures them when it is required. Absolute paths are masked so the
// digests do not depend on where the repository is checked out.

// harness:start
const os = require('node:os');
const ROOT = path.join(__dirname, '..');
const calls = [];
const jsonEscaped = (text) => JSON.stringify(text).slice(1, -1);
const MASKS = [...new Set([ROOT, process.cwd(), os.tmpdir()])]
  .flatMap((dir) => [jsonEscaped(dir), jsonEscaped(dir.split(path.sep).join('/'))])
  .sort((a, b) => b.length - a.length);
function snapshot(value) {
  const text = JSON.stringify(value);
  if (text === undefined) return undefined;
  let masked = text;
  for (const mask of MASKS) masked = masked.split(mask).join('<root>');
  // A masked path keeps its separators; make them '/' so Windows and POSIX digests agree.
  masked = masked.replace(/<root>(?:\\\\[^"\\]*)+/g, (match) => match.split('\\\\').join('/'));
  return JSON.parse(masked);
}
const record = (label, value) => (...args) => {
  calls.push([label, ...snapshot(args)]);
  return typeof value === 'function' ? value(...args) : value;
};
function stubExports(modulePath, values) {
  const mod = require(modulePath);
  for (const [name, value] of Object.entries(values)) {
    if (!(name in mod)) throw new Error(`${modulePath} has no export ${name}`);
    mod[name] = record(name, value);
  }
}

const gateAdapter = require('../lib/mcp-gate-adapter');
gateAdapter.evaluateMcpGate = record('evaluateMcpGate', (input) => ({ decision: 'allow', canExecute: true, tool: input.tool }));

const FIXTURE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-dispatch-'));
const FIXTURE = path.join(FIXTURE_DIR, 'notes.txt');
fs.writeFileSync(FIXTURE, 'Water boils at 100C.\n');
process.on('exit', () => fs.rmSync(FIXTURE_DIR, { recursive: true, force: true }));

stubExports('../persistencePaths', { resolvePersistencePaths: { memoryPath: 'memory.json', dbPath: 'memory.db' } });
stubExports('../backupRestore', {
  createBackup: { backupDir: 'backups/b1', copied: ['memory.json', 'memory.db'] },
  runCliRestore: (args) => {
    if (args === 'broken') throw Object.assign(new Error('restore failed'), { code: 'RESTORE_FAILED', receipt: { id: 'r1' } });
    return { dryRun: args === 'dry', restored: ['memory.json'] };
  },
  formatCliRestore: (result, json) => (json ? { restore: result } : `Restore: ${result.dryRun ? 'dry-run' : 'done'}`),
  formatRestoreError: (error) => `Formatted: ${error.message}`,
});
stubExports('../lib/system-status-report', {
  buildSystemStatus: { status: 'ok' },
  formatSystemStatusText: (report, plugins) => `Status: ${report.status} | ${plugins}`,
});
stubExports('../lib/cli-plugin-status', { formatPluginCapabilityStatus: 'plugins: none' });
stubExports('../lib/quickstart-cli', { runQuickstartCommand: 'quickstart ran' });
stubExports('../lib/cli-hypotheses', {
  runCliHypotheses: (kernel, args, options) => `hypotheses json=${options.json} commit=${typeof options.commitMutation === 'function' ? JSON.stringify(options.commitMutation()) : 'none'}`,
});
stubExports('../lib/cli-mutation-gate', {
  commitCliMutation: (kernel) => (kernel.auditBroken ? { auditRecorded: false, errorCode: 'AUDIT_DOWN' } : { auditRecorded: true }),
});
stubExports('../mcpServer', {
  callTool: (kernel, params) => {
    const args = params.arguments;
    if (params.name === 'huqan.approvals') {
      return args.workspaceId === 'broken' ? { ok: false, error: { message: 'store down' } } : { ok: true, approvals: [{ id: 'a1' }] };
    }
    if (args.approvalId === 'async-fail') {
      return Promise.resolve({ ok: false, error: { code: 'APPROVAL_NOT_FOUND', message: 'missing' }, meta: { identity: { id: 'i1' }, oversight: { caseId: 'c1' } } });
    }
    if (args.approvalId === 'no-code') return { ok: false };
    return { ok: true, decision: args.decision };
  },
  createApprovalStoreFromKernel: { kind: 'approval-store' },
  createMcpOperatorCapability: (input) => `capability:${input.tool}`,
  operatorCapabilityBinding: (tool, args) => ({ tool, args }),
});
stubExports('../lib/mcp-approval-views', {
  formatCliApprovalList: (result, args, json) => (json ? result : `approvals: ${JSON.stringify(result)}`),
  formatCliApprovalDecision: (result, approvalId, json) => (json ? result : `decided ${approvalId}: ${JSON.stringify(result)}`),
});
stubExports('../lib/cli-helpers', {
  resolveCliReadPath: (candidate) => {
    if (candidate === 'missing.txt') throw new Error('ENOENT: missing.txt');
    return FIXTURE;
  },
  formatAgentRunResult: (agent, result) => `agent run: ${JSON.stringify(result)}`,
});
stubExports('../lib/cli-audit', {
  runCliAudit: (kernel, args, opts, deps) => `audit ${JSON.stringify(args)} store=${JSON.stringify(deps.getApprovalStore())}`,
});
stubExports('../lib/cli-trust-receipt', { runCliTrustReceipt: 'receipt ran' });
stubExports('../lib/cli-coder', { runCliCoder: 'coder ran' });
stubExports('../lib/sqlite-restore', {
  storageWasOpen: (storage) => Boolean(storage && storage.open),
  closeRestoreHandles: undefined,
  reopenRestoreHandles: undefined,
});

const CLI = require('../cli');
const { mapCliCommandToMcpTool } = require('../lib/cli-helpers');

const CAPABILITY_RESULT = Object.freeze({
  ok: true, added: 2, files: 3, urls: 1, commits: 4, decisionId: 'd1',
  answer: 'Answer', source: 'Source', sourceRefs: ['r1'], totalNodes: 9,
  distribution: { repo: 1, markdown: 2, 'git-log': 3 },
  data: {
    mainClaim: 'claim', risks: [{ text: 'r1' }, { text: 'r2' }, { text: 'r3' }], missingEvidence: [{ text: 'g1' }],
    mode: 'strict', counterArgument: 'but', conflictingThoughts: [1, 2], conflictType: 'direct',
  },
});

function makeKernel(flags = {}) {
  const kernel = {
    ...flags,
    learn: record('kernel.learn', { ok: true }),
    learnDocument: record('kernel.learnDocument', 3),
    verify: record('kernel.verify', (statement) => (statement === 'odd'
      ? { data: { status: 'contested', confidence: 'high', risk: { manipulation: true, labels: [], score: 'x' } }, evidence: [] }
      : {
        data: { status: 'supported', confidence: 0.8125, risk: { manipulation: statement !== 'bare', labels: ['framing'], score: 0.5 } },
        evidence: statement === 'bare' ? [] : [{ text: 'water boils at 100C' }],
      })),
    ask: record('kernel.ask', (question) => ({ data: { answer: String(question).includes('unknown') ? 'Bilmiyorum' : 'a liquid' } })),
    reason: record('kernel.reason', (subject) => ({ data: { answer: String(subject).includes('unknown') ? 'Bilmiyorum' : 'because heat' } })),
    compare: record('kernel.compare', (left, right) => ({ data: { answer: left === 'unknown' ? 'Bilmiyorum' : `${left} differs from ${right}` } })),
    runCapability: record('kernel.runCapability', () => (kernel.capabilityFails ? { ok: false, error: 'capability broke' } : CAPABILITY_RESULT)),
    persist: record('kernel.persist', undefined),
    stopAutoThink: record('kernel.stopAutoThink', undefined),
    reload: record('kernel.reload', undefined),
    getPersistenceDescriptor: record('kernel.getPersistenceDescriptor', { memoryPath: 'memory.json' }),
    hasCapability: record('kernel.hasCapability', (name) => name === 'temporal'),
    enableCapability: record('kernel.enableCapability', undefined),
    plugins: { load: record('kernel.plugins.load', undefined) },
  };
  return kernel;
}

function makeCli({ kernel = {}, dream = [], storage } = {}) {
  const cli = Object.create(CLI.prototype);
  const emptyGoal = (goal) => goal === 'empty';
  Object.assign(cli, {
    kernel: makeKernel(kernel),
    agent: {
      storage,
      plan: record('agent.plan', (goal) => ({
        ok: true,
        data: {
          objective: 'learn', status: 'planned', goal, confidence: 0.4567,
          selectedTools: emptyGoal(goal) ? [] : ['learn', 'verify'],
          steps: emptyGoal(goal) ? [] : [{ action: 'learn', tool: 'learn', rationale: 'new fact' }],
          nextAction: emptyGoal(goal) ? null : { action: 'run', tool: 'learn' },
          recommendations: { items: emptyGoal(goal) ? [] : ['check sources'] },
        },
      })),
      run: record('agent.run', (goal) => (goal === 'async' ? Promise.resolve({ ok: true, goal }) : { ok: true, goal })),
    },
    dream: { dream: record('dream.dream', dream) },
    llm: { model: 'llama3; rm -rf' },
    approvalStore: null,
    _mcpOperatorToken: 'operator-token',
    _mcpCapabilityNonces: new Map(),
    _approvalRuntimeOptions: Object.freeze({}),
  });
  return cli;
}

const COMMANDS = [
  'öğret', 'verify', 'sor', 'neden', 'karşılaştır', 'mri', 'tartis', 'celiski', 'llm-sor', 'plan', 'ajan', 'yükle',
  'company-ingest', 'company-query', 'ingest-status', 'backup', 'kaydet', 'onaylar', 'onayla', 'audit', 'receipt',
  'coder', 'restore', 'düşün', 'optimize', 'konsolide', 'evolve', 'quickstart', 'durum', 'rüya', 'hypotheses',
  'selam', 'yardım', 'anlamadım',
];
const FAILING = { kernel: { capabilityFails: true } };
const COMPANY_SOURCES = ['manuel', 'manual', 'karar', 'decision', 'github', 'repo', 'markdown', 'md', 'json', 'yaml', 'yml', 'git-log', 'gitlog', 'pdf', 'http', 'url'];
const COMPANY_PAYLOAD = { text: 't', author: 'a', date: 'd', title: 'T', rationale: 'R', repoUrl: 'https://example.test/repo', targetPath: 'docs' };
const CASES = [
  ['öğret', 'Kediler Hayvandır'],
  ['verify', 'water boils'], ['verify', 'bare'], ['verify', 'odd'],
  ['sor', 'what is water'], ['sor', 'unknown thing'],
  ['neden', 'why boil'], ['neden', 'unknown'],
  ['karşılaştır', 'cats | dogs'], ['karşılaştır', 'unknown|dogs'], ['karşılaştır', 'cats'], ['karşılaştır', 'cats', { throwOnError: true }],
  ['mri', ' idea '], ['mri', 'idea', {}, FAILING],
  ['tartis', 'idea'], ['tartis', 'idea', {}, FAILING],
  ['celiski', 'idea'], ['celiski', 'idea', {}, FAILING],
  ['llm-sor', 'water boils'], ['llm-sor', 'odd'], ['llm-sor', 'unknown bare'],
  ['plan', 'learn water'], ['plan', 'empty'], ['plan', 'learn water', { json: true }],
  ['ajan', 'sync'], ['ajan', 'async'], ['ajan', 'sync', { json: true }],
  ['yükle', 'notes.txt'], ['yükle', 'missing.txt'],
  ...COMPANY_SOURCES.flatMap((source) => [
    ['company-ingest', { ...COMPANY_PAYLOAD, source }],
    ['company-ingest', { ...COMPANY_PAYLOAD, source }, {}, FAILING],
  ]),
  ['company-ingest', { source: 'ftp' }], ['company-ingest', 'not-an-object'], ['company-ingest', { source: 'ftp' }, { throwOnError: true }],
  ['company-query', ' who decided '], ['company-query', 'who', {}, FAILING],
  ['ingest-status', ''], ['ingest-status', '', {}, FAILING],
  ['backup', ''], ['backup', '', {}, { kernel: { auditBroken: true } }],
  ['kaydet', ''], ['kaydet', '', {}, { kernel: { auditBroken: true } }],
  ['onaylar', ''], ['onaylar', { workspaceId: 'w1' }, { json: true }], ['onaylar', { workspaceId: 'broken' }],
  ['onayla', 'a1 approved'], ['onayla', { approvalId: 'a1', decision: 'rejected', workspaceId: 'w2' }, { json: true }],
  ['onayla', ''], ['onayla', 'a1 maybe'],
  ['onayla', { approvalId: 'async-fail', decision: 'approved' }],
  ['onayla', { approvalId: 'async-fail', decision: 'approved' }, { throwOnError: true }],
  ['onayla', { approvalId: 'no-code', decision: 'approved' }, { throwOnError: true }],
  ['audit', { limit: 5 }], ['receipt', 'show r1'], ['coder', 'spec'],
  ['restore', ''], ['restore', 'dry'], ['restore', { backupDir: 'backups/b1' }, { json: true }], ['restore', 'broken'],
  ['restore', '', {}, { storage: { open: true } }],
  ['düşün', 'dur'], ['düşün', 'başla'],
  ['optimize', ''], ['konsolide', ''], ['evolve', ''],
  ['quickstart', ''], ['durum', ''],
  ['rüya', ''], ['rüya', '', {}, { dream: [{ from: 'kedi', to: 'hayvan', type: 'is_a', confidence: 0.912 }] }],
  ['hypotheses', {}], ['hypotheses', { propose: true }, { json: true }], ['hypotheses', { review: true }],
  ['hypotheses', { tuning: true, apply: true }], ['hypotheses', 'text-args'],
  ['selam', ''], ['yardım', ''], ['anlamadım', ''],
];

async function runCase([command, args, opts = {}, setup = {}]) {
  calls.length = 0;
  const cli = makeCli(setup);
  try {
    const output = await cli.execute(command, args, { gateResult: null, ...opts });
    return { calls: snapshot(calls), output: snapshot(output) };
  } catch (error) {
    return {
      calls: snapshot(calls),
      thrown: snapshot({ message: error.message, code: error.code, exitCode: error.exitCode, meta: error.meta, receipt: error.receipt }),
    };
  }
}

const GATE_KEY = 'evaluateCliGate arguments';
const GATE_TOOLS = ['huqan.learn', 'huqan.agent', 'huqan.ask', 'huqan.verify', 'huqan.reason', 'huqan.compare'];
const GATE_COMMANDS = [...new Set([
  ...COMMANDS,
  'learn', 'teach', 'ask', 'verify', 'reason', 'why', 'compare', 'plan', 'agent', 'run',
  'ogret', 'karsilastir', 'yukle', 'ruya', 'dusun', 'onayla', 'approve', 'approvals', 'status', 'search', 'advocate',
])];
const GATE_ARGS = ['cats | dogs', 'plain text', '', null, { goal: 'object args' }];

function gateResults() {
  const results = [];
  for (const command of GATE_COMMANDS) {
    const tool = mapCliCommandToMcpTool(command);
    if (!tool) continue;
    for (const args of GATE_ARGS) {
      calls.length = 0;
      const gate = makeCli().evaluateCliGate(command, args);
      results.push({ command, tool, args: snapshot(args), gate: snapshot(gate), calls: snapshot(calls) });
    }
  }
  return results;
}

const sha256 = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function goldenDigests() {
  const byCommand = {};
  for (const testCase of CASES) {
    (byCommand[testCase[0]] ||= []).push(await runCase(testCase));
  }
  const digests = Object.fromEntries(Object.entries(byCommand).map(([command, results]) => [command, sha256(results)]));
  digests[GATE_KEY] = sha256(gateResults());
  return digests;
}
// harness:end

// Recorded on main, before the change.
const GOLDEN = {
  'öğret': '7cd3a6016714177b855c45b568de88e5f22dbdf547de62501499e4b6fc219279',
  'verify': '5ac57e2c01ac2c190755def21842481d815185698da92dbe297baa32e905c964',
  'sor': '2b29c87fe82d41238395786d6d20291850fc9c7461a2b0ac3b86c9ddbce6e595',
  'neden': '67746704a4ce28c13fb7eaff638d11b8080141a698648aaf6314627b87932edc',
  'karşılaştır': 'aa7564c28d1eb37f5ef2ee11a0bbe9d89b302f1f329bab69b964e4a8a9b622eb',
  'mri': '7383c2487fdcca44fb648ed8ed75a43e563be4946b5647d7e0e0dbc574288bd6',
  'tartis': '976bcc8b4d5c5125540d8c46406de4da92b300ad48a1144e9b8084e3740c5e2c',
  'celiski': '661e0a56e2f1d1622b12752bdc157a58d07d7d0281f3b10bd292c36231542c61',
  'llm-sor': '3c2245237e5c34acf1d506897968958bf30bd960c625b9c874aa18c64ce72cad',
  'plan': '5181582decf8fa9ca0253e2f948ab6f95492d986a8e37e53cd9ae5a6dfcc2b05',
  'ajan': 'b383b6c47bd31a476ba4afe75cdcea8039ac5f01e8bd489afe276a2df7455274',
  'yükle': '136a2accf9c9a8a07f4f0c4ba5282bbfa06d66ac723fa5967617d4f060a41a50',
  'company-ingest': '1ce3d93ddd750676531c243689740a3288f5888ec29d8ca208a2efe850061463',
  'company-query': 'adf9b4724c8698e4dbc42879c1d83e11dcace5279a217abc2d052ffa81972082',
  'ingest-status': 'c5934395e1b378d414c978fa618ef17d3dd142e1ca4188f8c3bfdfde0eecc5bb',
  'backup': 'bd5ac22975597195be8f980106daeacf0460f1431c5d1f44b72fabadbfac9867',
  'kaydet': 'dafa3520c39a13c9f48f52ff9b3bf154cb34bd5eb5724be2d4e93d4643ce7008',
  'onaylar': '2048237b14c84f833c5745a4c43fec129360537a4c81c7ce1d6834db9703a3dc',
  'onayla': '8e5a19eadc89350ef709bee318dd6488560a342c219ab3d54542d875c3614bbb',
  'audit': '3fa127914571b0e1ed3f6271f18b9b6c0e292edef413235d407dbec79420f585',
  'receipt': '840c7fa4d05cc2e70ca2294f2c22cf559085f96e04203e3941d1bd606f3644a2',
  'coder': 'fa7d13a8ff987c4dfc9294fb34812fd98f361cb8b5e43fe647f8cd827831061b',
  'restore': '14aae65724102a4aecfb635c549afbecce983e5e7802577b7adcc2a5bb42c4ab',
  'düşün': '96f56501ebff60b787156ad1351ce3930111c72da09d416e4d5538c11e12fd28',
  'optimize': '17660f2da82a832960efc54bbbff3b2b4251276a6312d8eafbde704e58c610c4',
  'konsolide': '667e5fabf504fd21e18091542bec8d6d526116fbd2b5c91efde8d7d919cbb7c0',
  'evolve': '85e55aab5745b7be3df5261d41961acd4b4161fc06a9b558d09ee02d713ab651',
  'quickstart': '097ac73961abd50b23c861e196ec87e88016692bcb4984d0b230bb889ee57049',
  'durum': '4699d07bb29fd69ac446d5339b9665308cdc30b81f9a7419855a390ea45a2db8',
  'rüya': 'a7b117822bec78d6c0a8e8604c91248c0c2a1ebf0e5f864e37cc9692a153aa59',
  'hypotheses': '2844268257d59b93991d762615e197e28b0a9731f3a15bb596fff44b89d71ddf',
  'selam': 'e0066643c5faa671ed4f704d0448575b6ba38cc0d38f06ac69054af8e1bbf311',
  // #2505 F re-recorded `yardım`: the help text is generated from the workflow
  // contract, which gained the `stop` and `lift` commands. Diffing the help
  // text against main shows exactly those two added lines and nothing else.
  // #2591 re-recorded it again for the single added `integrity` usage line.
  // #2646 re-recorded it for the single added `doctor [--json]` usage line.
  'yardım': '6f450580bd89aa762b6835a2ec751872e709bd09811245243e7e8aa7846340ec',
  'anlamadım': 'ba3d1638f5c45556f9169f5d110035b64e935d455978804e255fbd782ac1e311',
  'evaluateCliGate arguments': '34d0ab2475d24cb888f8497610535e14b5b41c0e2edc2b434782325abe79759c',
};

describe('CLI command dispatch (unchanged)', () => {
  it('covers every command and the gate arguments', () => {
    assert.deepEqual([...new Set(CASES.map(([command]) => command))].sort(), [...COMMANDS].sort());
    assert.deepEqual(Object.keys(GOLDEN).sort(), [...COMMANDS, GATE_KEY].sort());
  });

  it('every command reaches its own body and the digests are deterministic', async () => {
    for (const command of COMMANDS) {
      const result = await runCase([command, '']);
      assert.notEqual(result.output, 'Unknown command.', command);
    }
    assert.deepEqual(await goldenDigests(), await goldenDigests());
  });

  it('the gate arguments cover every mapped tool shape and the default', () => {
    const reached = new Set(gateResults().map((result) => result.tool));
    for (const tool of GATE_TOOLS) assert.ok(reached.has(tool), tool);
    assert.ok([...reached].some((tool) => !GATE_TOOLS.includes(tool)), `no tool without its own gate arguments: ${[...reached]}`);
  });

  let actual;
  for (const key of Object.keys(GOLDEN)) {
    it(`${key} is byte-identical to main`, async () => {
      actual ||= await goldenDigests();
      assert.equal(actual[key], GOLDEN[key]);
    });
  }

  it('an unknown or prototype-named command is still unknown', async () => {
    for (const command of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty', '']) {
      const result = await runCase([command, 'x']);
      assert.deepEqual(result, { calls: [], output: 'Unknown command.' }, command);
    }
  });
});

describe('the CLI dispatch is a registry (#2136)', () => {
  it('cli.js no longer switches on the command or the mapped tool', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*command\s*\)/);
    assert.doesNotMatch(source, /switch\s*\(\s*tool\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'cli.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
