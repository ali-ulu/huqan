'use strict';

/**
 * The `huqan mcp` operator surface (ADR-018 §3, #3999): parsing, the config
 * emitter, the fail-closed status readback, and the elevation rule on the
 * registry-writing subcommands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runMcpServiceCommand, MCP_USAGE } = require('../lib/cli-mcp-service-commands');
const { mcpServiceCommandRules, parseMcpServiceArgs } = require('../lib/command-parser-mcp-args');
const { writeEndpointPin } = require('../lib/mcp/endpoint-pin');
const { deriveWorkspaceId } = require('../lib/protected-store-path');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-mcp-cli-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A fake Get-Acl probe spelling the spec-exact DACL for each probed path. */
function goodProbe() {
  return (file, args) => {
    const joined = args.join(' ');
    // The probe command embeds its paths as one quoted @(...) list; take the
    // non-empty list (the first is the empty $out=@() initializer).
    const lists = [...joined.matchAll(/@\(([^)]*)\)/g)].map((m) => m[1]);
    const list = lists.sort((a, b) => b.length - a.length)[0] || '';
    const paths = [...list.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const accessFor = (probePath) => {
      if (/huqan\\state$/.test(probePath)) {
        return [
          { sid: 'S-1-5-18', name: 'SYSTEM', rights: 'FullControl', type: 'Allow' },
          { sid: 'S-1-5-32-544', name: 'Administrators', rights: 'FullControl', type: 'Allow' },
          { sid: '', name: 'NT SERVICE\\huqan-runtime', rights: 'Modify', type: 'Allow' },
        ];
      }
      if (/\\state$/.test(probePath)) {
        return [
          { sid: 'S-1-5-18', name: 'SYSTEM', rights: 'FullControl', type: 'Allow' },
          { sid: 'S-1-5-32-544', name: 'Administrators', rights: 'FullControl', type: 'Allow' },
          { sid: '', name: 'DESKTOP\\operator', rights: 'FullControl', type: 'Allow' },
          { sid: '', name: 'NT SERVICE\\huqan-mcp-levh', rights: 'Modify', type: 'Allow' },
        ];
      }
      return [
        { sid: 'S-1-5-18', name: 'SYSTEM', rights: 'FullControl', type: 'Allow' },
        { sid: 'S-1-5-32-544', name: 'Administrators', rights: 'FullControl', type: 'Allow' },
        { sid: 'S-1-5-32-545', name: 'Users', rights: 'ReadAndExecute', type: 'Allow' },
      ];
    };
    return {
      status: 0,
      stdout: JSON.stringify(paths.map((probePath) => ({ path: probePath, owner: 'S-1-5-18', access: accessFor(probePath) }))),
    };
  };
}

function installedDirs(t, { name = 'levh', operator = 'DESKTOP\\operator' } = {}) {
  const dir = tempDir(t);
  const dataDir = path.join(dir, 'data', name);
  const stateDir = path.join(dataDir, 'state');
  const publicDir = path.join(dataDir, 'public');
  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  const workspaceRoot = path.join(dir, 'workspace');
  fs.mkdirSync(workspaceRoot);
  const pin = writeEndpointPin(publicDir, { name, port: 47921, operator, workspaceId: deriveWorkspaceId(workspaceRoot) });
  assert.equal(pin.ok, true);
  return { dir, dataDir, stateDir, publicDir };
}

const matchRule = (pattern, source, build) => (ctx) => {
  const match = ctx[source].match(pattern);
  return match ? build(match, ctx) : null;
};

test('the parser routes mcp subcommands and keeps paths verbatim', () => {
  const rules = mcpServiceCommandRules(matchRule);
  const run = (text) => {
    for (const rule of rules) {
      const parsed = rule({ raw: text, trimmed: text.toLowerCase() });
      if (parsed) return parsed;
    }
    return null;
  };
  assert.deepEqual(run('mcp status --name levh'), { command: 'mcp', args: { ...parseMcpServiceArgs('status --name levh') } });
  assert.equal(run('mcp status --name levh').args.name, 'levh');
  const enroll = run('mcp enroll --name levh --client agent-x --out "C:\\keys with space\\seed.txt"');
  assert.equal(enroll.args.out, 'C:\\keys with space\\seed.txt');
  assert.equal(run('mcp revoke --name levh --client agent-x --key-id 0123456789abcdef').args.keyId, '0123456789abcdef');
  assert.deepEqual(run('mcp').args.sub, 'help');
  assert.equal(run('store migrate'), null, 'the store rules are untouched');
});

test('config points the client at the loopback endpoint through the proxy', async (t) => {
  const dirs = installedDirs(t);
  const text = await runMcpServiceCommand({ sub: 'config', name: 'levh', client: 'agent-x', keyFile: 'C:\\k\\seed.txt' }, {}, {
    resolveDirs: () => dirs,
  });
  const config = JSON.parse(text);
  assert.deepEqual(config.mcpServers.levh, {
    command: 'huqan-mcp',
    args: ['proxy', '--url', 'http://127.0.0.1:47921', '--client', 'agent-x', '--workspace', config.mcpServers.levh.args[6], '--key-file', 'C:\\k\\seed.txt'],
  });
  assert.match(config.mcpServers.levh.args[6], /^[0-9a-f]{16}$/);
  const json = await runMcpServiceCommand({ sub: 'config', name: 'levh' }, { json: true }, { resolveDirs: () => dirs });
  assert.equal(json.ok, true);
  assert.equal(json.pin.url, 'http://127.0.0.1:47921');
  const missing = await runMcpServiceCommand({ sub: 'config', name: 'absent' }, {}, {});
  assert.match(String(missing), /No usable endpoint pin/);
});

test('status verifies the ACL, the store, the listener and the registry, and refuses when any leg fails', async (t) => {
  const dirs = installedDirs(t);
  // The ACL probe is injected and only accepts Windows paths, so the ACL and
  // registry legs read the Windows data root; the endpoint pin is a real file.
  const winData = 'C:\\ProgramData\\huqan\\mcp\\levh';
  const statusDirs = { ...dirs, dataDir: winData, stateDir: `${winData}\\state` };
  const deps = { resolveDirs: () => statusDirs, spawn: goodProbe(), platform: 'win32', probe: () => Promise.resolve({ listening: true, failClosed: true, refusalCode: 'malformed' }) };
  const text = await runMcpServiceCommand({ sub: 'status', name: 'levh' }, {}, deps);
  assert.match(String(text), /State ACL: verified/);
  assert.match(String(text), /Memory store ACE: none/);
  assert.match(String(text), /fail-closed \(malformed\)/);
  assert.match(String(text), /Verdict: PROTECTED/);

  const json = await runMcpServiceCommand({ sub: 'status', name: 'levh' }, { json: true }, deps);
  assert.equal(json.ok, true);

  const badAcl = await runMcpServiceCommand({ sub: 'status', name: 'levh' }, {}, {
    ...deps,
    spawn: (file, args) => {
      const isState = /mcp\\levh\\state/.test(args.join(' '));
      const access = isState
        ? [{ sid: 'S-1-5-18', name: 'SYSTEM', rights: 'FullControl', type: 'Allow' }]
        : [];
      return { status: 0, stdout: JSON.stringify([{ path: 'x', owner: 'S-1-5-18', access }, { path: 'y', owner: 'S-1-5-18', access }]) };
    },
  });
  assert.match(String(badAcl), /State ACL: REFUSED \(acl_missing_grant\)/);
  assert.match(String(badAcl), /Verdict: NOT PROTECTED/);

  const openListener = await runMcpServiceCommand({ sub: 'status', name: 'levh' }, {}, {
    ...deps,
    probe: () => Promise.resolve({ listening: true, failClosed: false, refusalCode: null }),
  });
  assert.match(String(openListener), /ANSWERS WITHOUT AN ENVELOPE/);
  assert.match(String(openListener), /Verdict: NOT PROTECTED/);

  const storeAce = await runMcpServiceCommand({ sub: 'status', name: 'levh' }, {}, {
    ...deps,
    spawn: (file, args) => {
      if (!/huqan\\state/.test(args.join(' '))) return goodProbe()(file, args);
      return { status: 0, stdout: JSON.stringify([{ path: 'x', owner: 'S-1-5-18', access: [{ sid: '', name: 'NT SERVICE\\huqan-mcp-levh', rights: 'Read', type: 'Allow' }] }]) };
    },
  });
  assert.match(String(storeAce), /Memory store ACE: PRESENT/);
});

test('enroll and revoke write the registry only when elevated, with rotation bounds', async (t) => {
  const dirs = installedDirs(t);
  const deps = { resolveDirs: () => dirs, isElevated: false };
  const refused = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out: path.join(dirs.dir, 'seed.txt') }, {}, deps);
  assert.match(String(refused), /Enrollment refused/);
  assert.equal(fs.existsSync(path.join(dirs.stateDir, 'clients.json')), false);

  const elevated = { resolveDirs: () => dirs, isElevated: true };
  const keyFile = path.join(dirs.dir, 'seed.txt');
  const first = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out: keyFile }, {}, elevated);
  assert.match(String(first), /Enrolled agent-x with key [0-9a-f]{16}/);
  assert.match(String(first), /signing seed was written/);
  assert.equal(fs.existsSync(keyFile), true);

  const second = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out: path.join(dirs.dir, 'seed2.txt') }, {}, elevated);
  assert.match(String(second), /Enrolled/);
  const third = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out: path.join(dirs.dir, 'seed3.txt') }, {}, elevated);
  assert.match(String(third), /rotation_overlap_full/);

  const keyId = fs.readdirSync(dirs.stateDir).includes('clients.json')
    ? JSON.parse(fs.readFileSync(path.join(dirs.stateDir, 'clients.json'), 'utf8')).clients[0].key_id : '';
  const revoke = await runMcpServiceCommand({ sub: 'revoke', name: 'levh', client: 'agent-x', keyId }, {}, elevated);
  assert.match(String(revoke), /Revoked/);
  const again = await runMcpServiceCommand({ sub: 'revoke', name: 'levh', client: 'agent-x', keyId }, {}, elevated);
  assert.match(String(again), /record_absent/);
});

test('enroll accepts an operator-supplied public key file and derives its key id', async (t) => {
  const dirs = installedDirs(t);
  const { createClientKey } = require('../lib/mcp/client-envelope');
  const key = createClientKey();
  const pubFile = path.join(dirs.dir, 'agent.pub');
  fs.writeFileSync(pubFile, `${key.publicKeyBase64url}\n`);
  const enrolled = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', publicKey: pubFile }, {}, {
    resolveDirs: () => dirs, isElevated: true,
  });
  assert.match(String(enrolled), /Enrolled agent-x with key [0-9a-f]{16}/);
  assert.ok(String(enrolled).includes(key.keyId), String(enrolled));
  assert.equal(fs.existsSync(path.join(dirs.dir, 'seed.txt')), false, 'no key file is written when the operator brings the key');
});

test('usage is the answer to help and to a missing name', async () => {
  assert.equal(await runMcpServiceCommand({ sub: 'help' }, {}, {}), MCP_USAGE);
  assert.equal(await runMcpServiceCommand({}, {}, {}), MCP_USAGE);
});
