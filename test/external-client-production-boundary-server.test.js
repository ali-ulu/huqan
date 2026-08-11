'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const test = require('node:test');

const root = path.join(__dirname, '..');
const fixturePath = path.join(__dirname, 'helpers', 'external-client-route-fixture.js');

test('real child server admits one signed package through the fully configured production boundary', () => {
  const script = String.raw`
    const crypto = require('node:crypto');
    const fs = require('node:fs');
    const http = require('node:http');
    const os = require('node:os');
    const path = require('node:path');
    const fixture = require(process.argv[2]);
    const { stableStringify } = require('./lib/receipt/canonical-receipt');
    const { EXTERNAL_CLIENT_TRUST_CONFIG_VERSION } = require('./lib/external-client-trust-config');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-d8-real-server-'));
    const keys = crypto.generateKeyPairSync('ed25519');
    const now = Date.now();
    const profilePath = path.join(directory, 'profile.json');
    const replayPath = path.join(directory, 'replay.sqlite');
    fs.writeFileSync(profilePath, stableStringify({
      profileVersion: EXTERNAL_CLIENT_TRUST_CONFIG_VERSION,
      expectedIdentitySubject: fixture.IDS.identitySubject,
      expectedIdentityKind: fixture.IDS.identityKind,
      expectedWorkspaceId: fixture.IDS.workspaceId,
      expectedPackageId: fixture.IDS.packageId,
      permissions: ['package:admit'],
      trustedKeys: { [fixture.IDS.keyId]: {
        publicKeySpkiDer: keys.publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
        workspaceId: fixture.IDS.workspaceId, packageIds: [fixture.IDS.packageId],
        identitySubjects: [fixture.IDS.identitySubject], identityKinds: [fixture.IDS.identityKind],
        notBefore: new Date(now - 60000).toISOString(), notAfter: new Date(now + 600000).toISOString(), revoked: false,
      } },
    }));
    Object.assign(process.env, {
      HUQAN_DISABLE_AUTO_LISTEN: '1', HUQAN_API_KEY: 'test-key',
      HUQAN_MEMORY_PATH: path.join(directory, 'memory.json'),
      HUQAN_DB_PATH: path.join(directory, 'graph.sqlite'),
      HUQAN_EXTERNAL_CLIENT_ENDPOINT_ENABLED: 'true',
      HUQAN_EXTERNAL_CLIENT_TRUST_PROFILE_PATH: profilePath,
      HUQAN_EXTERNAL_CLIENT_REPLAY_DB_PATH: replayPath,
    });
    const server = require('./server');
    const send = (body) => new Promise((resolve, reject) => {
      const raw = JSON.stringify(body);
      const request = http.request({ hostname: '127.0.0.1', port: server.address().port,
        path: '/api/external-client/packages/admit', method: 'POST', headers: {
          'content-type': 'application/json', 'content-length': Buffer.byteLength(raw), 'x-api-key': 'test-key',
        } }, (response) => { let text = ''; response.on('data', (part) => { text += part; });
          response.on('end', () => resolve({ status: response.statusCode, body: text })); });
      request.on('error', reject); request.end(raw);
    });
    (async () => {
      let result;
      try {
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      const createdAt = new Date(now).toISOString();
      const pkg = fixture.packageValue({ manifest: { createdAt } });
      pkg.objects.candidateClaims[0].createdAt = createdAt;
      pkg.objects.candidateClaims[0].provenance.timestamp = createdAt;
      const envelope = { package: pkg, signature: fixture.sign(pkg, keys.privateKey) };
      const accepted = await send(envelope);
      const replay = await send(envelope);
        result = { accepted, replay };
      } finally {
        if (server.listening) await new Promise((resolve) => server.close(() => resolve()));
        server.closeAxiom();
        fs.rmSync(directory, { recursive: true, force: true });
      }
      process.stdout.write('D8_RESULT ' + JSON.stringify({ ...result, cleaned: !fs.existsSync(directory) }) + '\n');
    })().catch((error) => { try { fs.rmSync(directory, { recursive: true, force: true }); } catch {} console.error(error.stack || error); process.exitCode = 1; });
  `;
  const output = execFileSync(process.execPath, ['-e', script, root, fixturePath], {
    cwd: root,
    encoding: 'utf8',
    timeout: 30000,
  });
  const resultLine = output.split(/\r?\n/).find((line) => line.startsWith('D8_RESULT '));
  assert.ok(resultLine, output);
  const result = JSON.parse(resultLine.slice('D8_RESULT '.length));
  assert.equal(result.accepted.status, 201);
  assert.deepEqual(Object.keys(JSON.parse(result.accepted.body)).sort(), [
    'localCandidateId', 'ok', 'operationId', 'outcome', 'receiptId', 'replayed',
  ]);
  assert.equal(result.replay.status, 409);
  assert.equal(result.cleaned, true);
});
