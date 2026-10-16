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

const API_KEY_ENV = 'HUQAN_API_KEY';
const STDIN_SOURCE = '-';
const REQUEST_TIMEOUT_MS = 15_000;
const RESPONSE_MAX_BYTES = 1 * 1024 * 1024;

/**
 * Reads the bearer credential from somewhere other than argv (#771).
 *
 * `--api-key <secret>` put the credential in the process command line, which
 * is readable by other local users through /proc, and lands in shell history,
 * CI command logs, job metadata and crash diagnostics. So the secret comes
 * from the environment, a mode-checked file, or stdin, and only a *reference*
 * to it may appear on the command line.
 *
 * Two sources at once is an error rather than a silent precedence rule: if the
 * caller is confused about which credential is in play, guessing for them is
 * how the wrong key gets used against the wrong server.
 */
function readApiKey(values) {
  const fromEnv = process.env[API_KEY_ENV];
  const hasEnv = typeof fromEnv === 'string' && fromEnv.trim() !== '';
  const source = values['api-key-file'];
  const hasSource = typeof source === 'string' && source !== '';

  if (hasEnv && hasSource) {
    throw new Error(`ambiguous credential: both ${API_KEY_ENV} and --api-key-file are set; supply exactly one`);
  }
  if (!hasEnv && !hasSource) {
    throw new Error(`no credential: set ${API_KEY_ENV}, or pass --api-key-file <path> (or - for stdin)`);
  }

  const key = hasEnv ? fromEnv : readKeyFile(source);
  const trimmed = key.trim();
  // Never echo the value, here or anywhere else: the point of moving it off
  // argv is that it stops appearing in places it was not meant to.
  if (!trimmed) throw new Error('credential is empty');
  return trimmed;
}

function readKeyFile(source) {
  if (source === STDIN_SOURCE) return fs.readFileSync(0, 'utf8');
  const stats = fs.statSync(source);
  // Windows does not expose a portable POSIX mode contract here, and this
  // boundary has no ACL verifier. Refuse the file source rather than reading a
  // credential whose local disclosure boundary cannot be established; callers
  // can use HUQAN_API_KEY or stdin when they need a Windows-safe source.
  if (process.platform === 'win32') {
    throw new Error('credential file permissions cannot be verified on Windows; use HUQAN_API_KEY or --api-key-file -');
  }
  if ((stats.mode & 0o077) !== 0) {
    throw new Error('credential file must not be group- or world-readable (chmod 600)');
  }
  return fs.readFileSync(source, 'utf8');
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

/**
 * Hostnames that never leave the machine. IPv6 literals arrive from `new URL`
 * wrapped in brackets and lower-cased, and IPv4-mapped forms (`::ffff:127.0.0.1`)
 * are loopback too.
 */
function isLoopbackHost(hostname) {
  const host = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
  if (host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1') return true;
  const mapped = host.startsWith('::ffff:') ? host.slice('::ffff:'.length) : host;
  const octets = mapped.split('.');
  if (octets.length !== 4) return false;
  if (!octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255)) return false;
  // 127.0.0.0/8 in full: 127.0.0.1 is the common case, but the whole block is
  // routed to the local host.
  return Number(octets[0]) === 127;
}

/**
 * Refuse to put a bearer credential on the wire in cleartext (#1672).
 *
 * The `authorization: Bearer <key>` header below is a long-lived credential
 * for the admission endpoint. Over plain HTTP it is readable by anything on
 * the path -- a proxy, a captive network, a host doing DNS interception -- and
 * a leaked key here admits packages under the client's identity. HTTPS is
 * therefore the default and the only option for a remote endpoint.
 *
 * Loopback is the one exception, and it is a genuine one rather than a
 * convenience: `http://127.0.0.1:<port>` never reaches a network interface, so
 * there is no path to intercept. That is how the standalone route tests and
 * local development drive this client, and requiring a certificate for it
 * would only push people toward disabling verification.
 *
 * There is deliberately no override flag. An "allow insecure" switch is the
 * thing that ends up pasted into a production runbook; a caller that needs a
 * remote plaintext endpoint has a broken deployment, not a missing flag.
 */
function assertTransportSecurity(target) {
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('URL protocol must be http or https');
  if (target.protocol === 'https:') return;
  if (isLoopbackHost(target.hostname)) return;
  throw new Error(
    `refusing to send the bearer credential over cleartext HTTP to ${target.hostname}: `
    + 'use https://, or a loopback address (127.0.0.1 / [::1] / localhost) for local development',
  );
}

function parseEndpoint(url) {
  try {
    return new URL(url);
  } catch (_) {
    throw new Error('--url is not a valid absolute URL');
  }
}

function request(url, apiKey, body) {
  return new Promise((resolve, reject) => {
    const target = parseEndpoint(url);
    assertTransportSecurity(target);
    const transport = target.protocol === 'https:' ? https : http;
    const bytes = Buffer.from(JSON.stringify(body), 'utf8');
    let settled = false;
    const failOnce = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    const outgoing = transport.request(target, { method: 'POST', timeout: REQUEST_TIMEOUT_MS, headers: {
      authorization: `Bearer ${apiKey}`, 'content-type': 'application/json; charset=utf-8',
      'content-length': String(bytes.length), accept: 'application/json',
    } }, (incoming) => {
      const chunks = [];
      let received = 0;
      incoming.on('data', (chunk) => {
        if (settled) return;
        received += chunk.length;
        if (received > RESPONSE_MAX_BYTES) {
          failOnce(new Error(`HTTP response exceeded ${RESPONSE_MAX_BYTES} byte limit`));
          incoming.destroy();
          outgoing.destroy();
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      incoming.on('end', () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch (_) { return reject(new Error(`HTTP ${incoming.statusCode}: non-JSON response`)); }
        if (incoming.statusCode !== 200 && incoming.statusCode !== 201) {
          return reject(new Error(`HTTP ${incoming.statusCode}: request rejected`));
        }
        resolve(parsed);
      });
      incoming.on('error', failOnce);
    });
    outgoing.on('timeout', () => {
      failOnce(new Error(`HTTP request timed out after ${REQUEST_TIMEOUT_MS}ms`));
      outgoing.destroy();
    });
    outgoing.on('error', failOnce);
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
  if (Object.hasOwn(values, 'api-key')) {
    // Named explicitly so the failure is legible, and without repeating the
    // value that was just exposed by being typed there.
    throw new Error(`--api-key is not supported: argv is visible to other processes; use ${API_KEY_ENV} or --api-key-file`);
  }
  const allowed = new Set(['url', 'input', 'output', 'api-key-file']);
  if (command !== 'admit' || !values.url || !values.input || !values.output
    || Object.keys(values).some((key) => !allowed.has(key))) {
    throw new Error(`usage: admit --url <url> --input <envelope.json> --output <response.json> [--api-key-file <path|->]\n  the bearer credential is read from ${API_KEY_ENV} or --api-key-file (- reads stdin); exactly one source`);
  }
  // Checked before the credential is read, so an unsafe URL fails without
  // even loading the secret into this process.
  assertTransportSecurity(parseEndpoint(values.url));
  const apiKey = readApiKey(values);
  if (fs.existsSync(values.output)) throw new Error('output file already exists');
  const result = await request(values.url, apiKey, readObject(values.input));
  if (!validSuccess(result)) throw new Error('server returned an invalid success artifact');
  fs.writeFileSync(values.output, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
  process.stdout.write(`accepted: ${result.receiptId}\n`);
}

if (require.main === module) {
  main().catch((error) => fail(error?.message || 'external client failed'));
}

module.exports = { assertTransportSecurity, isLoopbackHost, parseEndpoint };
