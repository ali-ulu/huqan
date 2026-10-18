'use strict';

/**
 * The `huqan mcp` operator surface (ADR-018 §3, #3999): parsing, the config
 * emitter, the fail-closed status readback, and the elevation rule on the
 * registry-writing subcommands.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');

const { runMcpServiceCommand, MCP_USAGE, loopbackPortOf, probeListener } = require('../lib/cli-mcp-service-commands');
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

test('the status probe only ever targets a plain http loopback endpoint', () => {
  assert.equal(loopbackPortOf('http://127.0.0.1:47921'), 47921);
  for (const url of ['http://example.com:47921', 'https://127.0.0.1:47921', 'http://127.0.0.1', 'http://127.0.0.1:0',
    'http://127.0.0.1:99999', 'http://user:pw@127.0.0.1:47921', 'http://localhost:47921', 'not a url', '', undefined]) {
    assert.equal(loopbackPortOf(url), null, String(url));
  }
});

/** A listener answering every request with `handler`, on a free loopback port. */
async function listenWith(t, handler) {
  const server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections?.(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}

test('the probe calls a listener fail-closed only for the envelope refusal, and a dropped response is not a verdict', async (t) => {
  const refusal = (code, status = 403) => (req, res) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { code } }));
  };
  const good = await probeListener(await listenWith(t, refusal('malformed')));
  assert.deepEqual(good, { listening: true, failClosed: true, refusalCode: 'malformed' });

  // Some other local process answering 403 is not the envelope check.
  const impostor = await probeListener(await listenWith(t, refusal('nope')));
  assert.equal(impostor.listening, true);
  assert.equal(impostor.failClosed, false);
  const open = await probeListener(await listenWith(t, refusal('malformed', 200)));
  assert.equal(open.failClosed, false);

  // Headers sent, body cut short: the response errors, it never ends.
  const dropped = await probeListener(await listenWith(t, (req, res) => {
    res.writeHead(403, { 'content-length': '500' });
    res.write('{"error"');
    setTimeout(() => req.socket.destroy(), 20);
  }));
  assert.deepEqual(dropped, { listening: false });

  assert.deepEqual(await probeListener('http://evil.example:80'), { listening: false });
});

test('a flag followed by another option has no operand, and the command refuses it', async (t) => {
  const parsed = parseMcpServiceArgs('enroll --name levh --client agent-x --out --key-id abc');
  assert.equal(parsed.out, '');
  assert.equal(parsed.keyId, 'abc');
  assert.deepEqual(parsed.missingOperands, ['out']);
  assert.equal(parseMcpServiceArgs('config --name --client x').name, '');
  assert.equal(parseMcpServiceArgs('status --name levh').missingOperands, undefined);
  assert.equal(parseMcpServiceArgs('enroll --name levh --client a --out "C:\\k k\\seed.txt"').out, 'C:\\k k\\seed.txt');

  const dirs = installedDirs(t);
  const cwd = process.cwd();
  const refused = await runMcpServiceCommand(parsed, {}, { resolveDirs: () => dirs, isElevated: true });
  assert.match(String(refused), /Refused: --out needs a value/);
  assert.equal(fs.existsSync(path.join(cwd, '--key-id')), false);
  assert.equal(fs.existsSync(path.join(dirs.stateDir, 'clients.json')), false);
});

const registryRecords = (dirs) => {
  const file = path.join(dirs.stateDir, 'clients.json');
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).clients : [];
};

test('the signing seed is written last: a refused registry write leaves no key file, a refused key file leaves no record', async (t) => {
  const dirs = installedDirs(t);
  const elevated = { resolveDirs: () => dirs, isElevated: true };
  const enroll = (out) => runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out }, {}, elevated);

  // Registry full (two live keys for the client): the third enrolment is
  // refused by the registry and must not leave its seed file behind.
  assert.match(String(await enroll(path.join(dirs.dir, 'seed1.txt'))), /Enrolled/);
  assert.match(String(await enroll(path.join(dirs.dir, 'seed2.txt'))), /Enrolled/);
  const third = path.join(dirs.dir, 'seed3.txt');
  assert.match(String(await enroll(third)), /rotation_overlap_full.*no key file was written/);
  assert.equal(fs.existsSync(third), false, 'no orphaned seed after a refused registry write');
  assert.equal(registryRecords(dirs).length, 2);

  // An existing output file is never overwritten, and the record is rolled back.
  const taken = path.join(dirs.dir, 'seed1.txt');
  const clash = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-z', out: taken }, {}, elevated);
  assert.match(String(clash), /key_file_exists; the registry change was rolled back/);
  assert.equal(fs.readFileSync(taken, 'utf8').length, 44, 'the existing file is untouched');
  assert.equal(registryRecords(dirs).length, 2);

  // A seed that cannot be created rolls the new record back out.
  const fresh = installedDirs(t);
  const text = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-y', out: path.join(fresh.dir, 'absent', 'seed.txt') }, {},
    { resolveDirs: () => fresh, isElevated: true });
  assert.match(String(text), /key_file_write_failed; the registry change was rolled back/);
  assert.deepEqual(registryRecords(fresh), []);
});

test('on Windows the signing seed is created under an ACL naming only the current account, or not at all', async (t) => {
  const dirs = installedDirs(t);
  const calls = [];
  const sid = 'S-1-5-21-1-2-3-1001';
  const spawn = (file, args) => {
    calls.push([path.win32.basename(file), args]);
    if (/whoami/i.test(file)) return { status: 0, stdout: `"DESKTOP\\operator","${sid}"\r\n` };
    // The seed must not exist yet with content when the ACL is applied.
    assert.equal(fs.readFileSync(args[0], 'utf8'), '', 'ACL is applied to the still-empty file');
    return { status: 0 };
  };
  const out = path.join(dirs.dir, 'seed.txt');
  const done = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out }, {},
    { resolveDirs: () => dirs, isElevated: true, spawn, platform: 'win32' });
  assert.match(String(done), /Enrolled/);
  const icacls = calls.find(([tool]) => /icacls/i.test(tool));
  assert.deepEqual(icacls[1].slice(1), ['/inheritance:r', '/grant:r', `*${sid}:F`]);
  assert.match(fs.readFileSync(out, 'utf8'), /^[A-Za-z0-9_-]{43}\n$/);

  const failed = installedDirs(t);
  const failOut = path.join(failed.dir, 'seed.txt');
  const refused = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out: failOut }, {},
    { resolveDirs: () => failed, isElevated: true, platform: 'win32', spawn: (file) => (/whoami/i.test(file) ? { status: 0, stdout: `"a\\b","${sid}"` } : { status: 5 }) });
  assert.match(String(refused), /key_file_acl_failed; the registry change was rolled back/);
  assert.equal(fs.existsSync(failOut), false, 'a seed that cannot be made private is not left behind');
  assert.deepEqual(registryRecords(failed), []);
});

test('on POSIX the signing seed is created owner-only', { skip: process.platform === 'win32' }, async (t) => {
  const dirs = installedDirs(t);
  const out = path.join(dirs.dir, 'seed.txt');
  const done = await runMcpServiceCommand({ sub: 'enroll', name: 'levh', client: 'agent-x', out }, {}, { resolveDirs: () => dirs, isElevated: true });
  assert.match(String(done), /Enrolled/);
  assert.equal(fs.statSync(out).mode & 0o777, 0o600);
});
