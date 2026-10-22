'use strict';

// The CLI `evidence pack` and `evidence verify` commands (#4092, PR-A2). Dispatched
// from lib/cli-workflow-adapter.js like `stop` and `integrity`: argv-only, no HTTP
// route. All pack logic lives in lib/evidence-pack/*; this file parses flags,
// picks the ambient stores and shapes the output.
const { CLI_EXIT_CODES, cliEnvelope, jsonError } = require('./cli-workflow-envelope');
const { collectEvidencePack, EvidencePackError } = require('./evidence-pack/collect');
const { verifyPack } = require('./evidence-pack/verify');
const { readIssuerSealKey } = require('./issuer-seal-config');
const { defaultEmergencyStopDirectory } = require('./emergency-stop');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');

const USAGE = 'evidence pack --from <ISO> --to <ISO> --out <dir> [--sign] [--collector-store <dir> --collector-pubkeys <dir>] (inclusive instants; a date-only value means 00:00:00Z)   |   evidence verify <dir> [--collector-pubkeys <dir>]';
// Refusals about the request itself, as opposed to a pack that could not be trusted.
const INVALID_INPUT_CODES = new Set(['PERIOD_INVALID', 'OUT_DIR_REQUIRED', 'OUT_DIR_EXISTS', 'WORKSPACE_NOT_ALLOWED', 'COLLECTOR_PUBKEYS_REQUIRED']);

// undefined: the flag is absent. null: it is present but its operand is missing or is another flag.
function flagValue(args, name) {
  const index = args.indexOf(`--${name}`);
  if (index < 0) return undefined;
  const operand = args[index + 1];
  return typeof operand === 'string' && operand !== '' && !operand.startsWith('--') ? operand : null;
}

// --sign uses the configured issuer key. No key configured is not an error: the pack is
// written unsigned and says so. A key that is configured but unusable is an error.
function issuerKeyFor(args) {
  if (!args.includes('--sign')) return null;
  try {
    return readIssuerSealKey();
  } catch (error) {
    throw new EvidencePackError('ISSUER_KEY_UNUSABLE', error.message);
  }
}

function packResult(args, io) {
  const issuerKey = issuerKeyFor(args);
  const cli = io.cli || io.deps.createCli();
  const workspace = flagValue(args, 'workspace');
  const result = collectEvidencePack({
    from: flagValue(args, 'from'),
    to: flagValue(args, 'to'),
    outDir: flagValue(args, 'out'),
    ...(workspace ? { workspaceId: workspace } : {}),
    ...(issuerKey ? { issuerKey } : {}),
    collectorStore: flagValue(args, 'collector-store'),
    collectorPubkeys: flagValue(args, 'collector-pubkeys'),
    graph: cli.kernel.graph,
    emergencyStopDir: defaultEmergencyStopDirectory(),
    externalReceiptsPath: defaultExternalActionReceiptPath(),
    backupOptions: cli._backupOptions(),
  });
  const files = result.files.map((file) => ({ path: file.path, integrityClass: file.integrityClass }));
  return {
    status: 'completed',
    data: { outDir: result.outDir, packHash: result.packHash, piiTypes: result.piiTypes, files, signed: Boolean(result.issuerKeyId), issuerKeyId: result.issuerKeyId },
    text: `Evidence pack written: ${result.outDir}\npackHash: ${result.packHash}\nfiles: ${files.length}`
      + `${args.includes('--sign') ? (result.issuerKeyId ? `\nsigned: ${result.issuerKeyId}` : '\nunsigned: no issuer key is configured') : ''}`
      + `${result.piiTypes.length ? `\nPII types seen (reported, not removed): ${result.piiTypes.join(', ')}` : ''}`,
  };
}

function verifyResult(args) {
  const dir = args[2];
  if (!dir) return { status: 'invalid_input', error: { code: 'INVALID_INPUT', message: USAGE } };
  const verdict = verifyPack(dir, { collectorPubkeys: flagValue(args, 'collector-pubkeys') });
  const lines = [`${verdict.valid ? 'VALID' : 'INVALID'}  ${dir}`];
  if (!verdict.valid) lines.push(`findings: ${verdict.findings.join(', ')}`);
  if (verdict.signature) lines.push(verdict.signature.signed ? `signature: signed  keyId: ${verdict.signature.keyId || 'unknown'}` : 'signature: unsigned');
  for (const warning of verdict.warnings) lines.push(`warning: ${warning}`);
  for (const file of verdict.files) lines.push(`  ${file.path}  ${file.integrityClass}`);
  for (const claim of verdict.nonClaims) lines.push(`  non-claim: ${claim}`);
  return { status: verdict.valid ? 'completed' : 'failed', data: verdict, text: lines.join('\n') };
}

function runSubcommand(args, io) {
  const sub = args[1];
  if (sub === 'pack') {
    const missing = ['from', 'to', 'out'].filter((name) => flagValue(args, name) === undefined);
    const bad = ['from', 'to', 'out', 'workspace', 'collector-store', 'collector-pubkeys'].filter((name) => flagValue(args, name) === null);
    if (missing.length > 0 || bad.length > 0) {
      const parts = [missing.length ? `missing --${missing.join(', --')}` : '', bad.length ? `--${bad.join(', --')} needs a value that is not another flag` : ''].filter(Boolean);
      return { status: 'invalid_input', error: { code: 'INVALID_INPUT', message: `${parts.join('; ')}. ${USAGE}` } };
    }
    return packResult(args, io);
  }
  if (sub === 'verify') {
    if (flagValue(args, 'collector-pubkeys') === null) return { status: 'invalid_input', error: { code: 'INVALID_INPUT', message: `--collector-pubkeys needs a directory. ${USAGE}` } };
    return verifyResult(args);
  }
  return { status: 'invalid_input', error: { code: 'INVALID_INPUT', message: USAGE } };
}

function evidenceFailure(error) {
  if (!(error instanceof EvidencePackError)) throw error;
  const status = INVALID_INPUT_CODES.has(error.code) ? 'invalid_input' : 'failed';
  return { status, error: { code: error.code, message: error.message } };
}

/**
 * @param {string[]} args argv with `--json` already removed; args[0] is `evidence`
 * @param {{json: boolean, stdout: Function, stderr: Function, workflowId: string|null, deps: object, cli?: object}} io
 * @returns {{interactive: false, exitCode: number, command: string, workflowId: string|null}}
 */
function runEvidenceArgv(args, io) {
  let outcome;
  try {
    outcome = runSubcommand(args, io);
  } catch (error) {
    outcome = evidenceFailure(error);
  }
  const { status, data, error, text } = outcome;
  if (io.json) {
    io.stdout(JSON.stringify(error ? jsonError(io.workflowId, status, error.code, error.message) : cliEnvelope(io.workflowId, { data }, status)));
  } else if (error) {
    io.stderr(`${error.code}: ${error.message}`);
  } else {
    io.stdout(text);
  }
  return { interactive: false, exitCode: CLI_EXIT_CODES[status], command: `evidence-${args[1] || ''}`, workflowId: io.workflowId };
}

module.exports = { runEvidenceArgv };
