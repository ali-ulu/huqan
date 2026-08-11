'use strict';

const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function argumentsFor(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith('--') || value === undefined) throw new Error('arguments must be --name value pairs');
    values[name.slice(2)] = value;
  }
  return { command, values };
}

function readObject(filename) {
  const value = JSON.parse(fs.readFileSync(filename, 'utf8'));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('JSON input must be an object');
  return value;
}

function validSuccess(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const expected = ['localCandidateId', 'ok', 'operationId', 'outcome', 'receiptId', 'replayed'].sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index])
    && value.ok === true && value.outcome === 'pending_review' && typeof value.replayed === 'boolean'
    && ['operationId', 'localCandidateId', 'receiptId'].every((key) => typeof value[key] === 'string' && value[key].trim());
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
  }
  return value;
}
function hash(value) {
  return crypto.createHash('sha256').update(JSON.stringify(stable(value)), 'utf8').digest('hex');
}
function verifyArtifact(values) {
  const artifact = readObject(values.receipt);
  const response = readObject(values.response);
  const pkg = readObject(values.package);
  const receipt = artifact.receipt;
  const authority = artifact.authority;
  if (!receipt || !authority || !validSuccess(response)) throw new Error('receipt artifact verification failed');
  const payload = receipt.canonicalPayload;
  const expectedHash = hash({ ...payload, previousReceiptHash: receipt.previousReceiptHash });
  const packageHash = hash(pkg);
  const bindings = [
    receipt.receiptHash === expectedHash,
    receipt.previousReceiptHash === 'genesis:v4-receipt-chain',
    receipt.operationId === response.operationId,
    receipt.receiptId === response.receiptId && payload.receiptId === response.receiptId,
    payload.admissionId === response.operationId,
    payload.memoryDraftId === response.localCandidateId,
    receipt.workspaceId === values.workspace && payload.workspaceId === values.workspace,
    authority.workspaceId === values.workspace,
    authority.packageId === values['package-id'] && pkg.manifest?.packageId === values['package-id'],
    authority.packageHash === packageHash,
    authority.identitySubject === values['identity-subject'] && payload.actor === values['identity-subject']
      && payload.agentId === values['identity-subject'],
    authority.identityKind === values['identity-kind'],
    payload.metadata?.packageId === values['package-id'] && payload.metadata?.packageHash === packageHash,
    payload.metadata?.operationId === response.operationId
      && payload.metadata?.localCandidateId === response.localCandidateId,
    payload.schemaVersion === 'v4-receipt-v2' && payload.trustRoot === 'external_verified_client',
    payload.decision === 'review' && payload.verdict === 'review' && payload.status === 'pending',
    payload.receiptKind === 'external_client_candidate_claim_admission',
  ];
  if (bindings.some((binding) => !binding)) throw new Error('receipt artifact verification failed');
  return response.receiptId;
}

function request(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    if (!['http:', 'https:'].includes(target.protocol)) throw new Error('URL protocol must be http or https');
    const transport = target.protocol === 'https:' ? https : http;
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    const outgoing = transport.request(target, { method: 'POST', headers: {
      authorization: `Bearer ${apiKey}`, 'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length), accept: 'application/json',
    } }, (incoming) => {
      const chunks = [];
      incoming.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      incoming.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return reject(new Error(`HTTP ${incoming.statusCode}: non-JSON response`)); }
        if (incoming.statusCode !== 200 && incoming.statusCode !== 201) {
          return reject(new Error(`HTTP ${incoming.statusCode}: request rejected`));
        }
        resolve(parsed);
      });
    });
    outgoing.on('error', reject);
    outgoing.end(bytes);
  });
}

async function main() {
  const { command, values } = argumentsFor(process.argv.slice(2));
  if (command === 'verify') {
    const required = ['receipt', 'response', 'package', 'identity-subject', 'identity-kind', 'workspace', 'package-id'];
    if (Object.keys(values).length !== required.length || required.some((key) => !values[key])) {
      throw new Error('usage: verify --receipt <receipt.json> --response <response.json> --package <package.json> --identity-subject <subject> --identity-kind <kind> --workspace <id> --package-id <id>');
    }
    const receiptId = verifyArtifact(values);
    process.stdout.write(`verified: ${receiptId}\n`);
    return;
  }
  if (command !== 'admit' || !values.url || !values['api-key'] || !values.input || !values.output
    || Object.keys(values).length !== 4) {
    throw new Error('usage: admit --url <url> --api-key <key> --input <envelope.json> --output <response.json>');
  }
  if (fs.existsSync(values.output)) throw new Error('output file already exists');
  const result = await request(values.url, values['api-key'], readObject(values.input));
  if (!validSuccess(result)) throw new Error('server returned an invalid success artifact');
  fs.writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`accepted: ${result.receiptId}\n`);
}

main().catch((error) => fail(error?.message || 'external client failed'));
