'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { ACTION_CATEGORIES } = require('./action-risk-classifier');
const { isPlainObject } = require('./is-plain-object');

const EXTERNAL_ACTION_SCHEMA_VERSION = 'huqan.external-action.v1';

const EXTERNAL_ACTION_KINDS = Object.freeze({
  SHELL: 'shell',
  FILE_READ: 'file_read',
  FILE_WRITE: 'file_write',
  NETWORK: 'network',
  MEMORY: 'memory',
  DEPLOYMENT: 'deployment',
  PERMISSION: 'permission',
  AUTOMATION: 'automation',
  TOOL: 'tool',
});

const SECRET_KEY = /(?:api[_-]?key|authorization|cookie|credential|password|private[_-]?key|secret|token)/i;
const SECRET_VALUE = /(?:bearer\s+[a-z0-9._~+/-]{12,}|(?:sk|gh[opsu]|xox[baprs])-?[a-z0-9_-]{12,}|-----BEGIN [A-Z ]+PRIVATE KEY-----)/i;
const SAFE_SHELL = /^(?:pwd|whoami|hostname|dir|ls|Get-ChildItem|Get-Location|git\s+(?:status|diff|log|show|branch|rev-parse|remote)|rg|grep|find|where|which|type|Get-Content|cat|head|tail|wc|echo|stat|date|du|df)(?:\s|$)/i;
const VERSION_QUERY = /^\S+\s+(?:-v|-V|--version|version)$/i;
/**
 * Redirection, chaining and substitution make the leading verb a poor
 * description of what runs: `ls -la > out.txt` is a filesystem write, and
 * `type secrets.json > exfil` is a copy. The safe list only ever described the
 * verb, so it classified both as read-only (#1799). A command carrying any of
 * this is never read-only here, whatever it starts with.
 */
const SHELL_COMPOSITION = /[;&|<>`]|\$\(|\$\{/;
const DEPLOY_SHELL = /(?:^|\s)(?:git\s+push|npm\s+publish|docker\s+(?:push|deploy)|kubectl\s+(?:apply|delete|rollout)|terraform\s+apply|helm\s+(?:install|upgrade)|gh\s+pr\s+merge)(?:\s|$)/i;
const PERMISSION_SHELL = /(?:^|\s)(?:chmod|chown|icacls|takeown|setfacl|sudo)(?:\s|$)/i;
const WRITE_SHELL = /(?:^|[;&|]\s*)(?:cp|copy|mv|move|install|tee|touch|mkdir|md|del|erase|rm|rmdir|Remove-Item|Set-Content|Add-Content|New-Item)(?:\s|$)/i;

function text(value, fallback = '') {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function jsonClone(value, fallback = {}) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (_) {
    return fallback;
  }
}

function redactExternalValue(value, key = '', seen = new WeakSet()) {
  if (SECRET_KEY.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return SECRET_VALUE.test(value) ? '[REDACTED]' : value;
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return '[CIRCULAR]';
  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.map(item => redactExternalValue(item, '', seen));
    seen.delete(value);
    return result;
  }
  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redactExternalValue(childValue, childKey, seen);
  }
  seen.delete(value);
  return result;
}

function inferExternalActionKind(toolName, args = {}, explicitKind = '') {
  const kind = text(explicitKind).toLowerCase();
  if (Object.values(EXTERNAL_ACTION_KINDS).includes(kind)) return kind;
  const tool = text(toolName).toLowerCase();
  if (/(?:^|[_.:-])(?:bash|shell|terminal|exec|exec_command)(?:$|[_.:-])/.test(tool)) return EXTERNAL_ACTION_KINDS.SHELL;
  if (/(?:apply_patch|edit|write|create|delete|remove|move|copy|rename)/.test(tool)) return EXTERNAL_ACTION_KINDS.FILE_WRITE;
  if (/(?:read|glob|grep|search|list|find|stat)/.test(tool)) return EXTERNAL_ACTION_KINDS.FILE_READ;
  if (/(?:fetch|http|browser|network|web)/.test(tool)) return EXTERNAL_ACTION_KINDS.NETWORK;
  if (/(?:memory|learn|remember|store_fact)/.test(tool)) return EXTERNAL_ACTION_KINDS.MEMORY;
  if (/(?:deploy|release|publish|merge|push)/.test(tool)) return EXTERNAL_ACTION_KINDS.DEPLOYMENT;
  if (/(?:permission|chmod|chown|acl|grant)/.test(tool)) return EXTERNAL_ACTION_KINDS.PERMISSION;
  if (args && typeof args === 'object' && typeof args.command === 'string') return EXTERNAL_ACTION_KINDS.SHELL;
  return EXTERNAL_ACTION_KINDS.TOOL;
}

function extractCommand(args = {}, fallback = '') {
  if (typeof args === 'string') return args.trim();
  if (!isPlainObject(args)) return text(fallback);
  return text(args.command ?? args.cmd ?? args.shell ?? args.script ?? args.exec, text(fallback));
}

function extractTargetPath(args = {}, fallback = '') {
  if (!isPlainObject(args)) return text(fallback);
  return text(args.file_path ?? args.filePath ?? args.path ?? args.targetPath ?? args.destination, text(fallback));
}

function extractTargetUrl(args = {}, fallback = '') {
  if (!isPlainObject(args)) return text(fallback);
  return text(args.url ?? args.uri ?? args.endpoint ?? args.targetUrl, text(fallback));
}

function composed(command) {
  return SHELL_COMPOSITION.test(command);
}

/**
 * A deployment's own list of commands it does not want to approve every time
 * (`npm test`, `node --version`). It can only promote a command the classifier
 * would otherwise call an unclassified tool chain: deploy, permission and
 * write commands keep their category, a composed command is never promoted,
 * and the denylist -- applied later, in the hard block rules -- is untouched.
 *
 * An entry matches the whole command or a whole leading argument run, so
 * `npm test` covers `npm test -- --watch` but never `npm testify`.
 */
function allowlistMatch(command, allowedCommands) {
  if (!Array.isArray(allowedCommands) || composed(command)) return '';
  const normalized = command.replace(/\s+/g, ' ').trim();
  return allowedCommands
    .map(entry => text(entry).replace(/\s+/g, ' '))
    .find(entry => entry && (normalized === entry || normalized.startsWith(`${entry} `))) || '';
}

/**
 * The part of a command an allowlist entry could name, and nothing more (#3025).
 *
 * The receipt keeps only a digest of the arguments, so on its own the trail
 * cannot say which command a person approved, and nothing can propose one.
 * This is what lib/command-shape-log.js records beside the trail -- never in
 * it -- for a reviewed command: the leading run of plain words
 * (`npm run build`, `npx tsc`), stopping at the first flag, path, quote,
 * assignment or anything else that is data rather than a verb. Arguments are
 * where file names, URLs and tokens live; the words before them are the shape
 * `allowlistMatch` compares against.
 *
 * Empty for a composed command, which no entry can ever promote, and for one
 * whose shape still looks like a credential after the cut.
 */
const SHAPE_WORD = /^[A-Za-z][A-Za-z0-9._:@+-]{0,31}$/;
const MAX_SHAPE_WORDS = 3;

function commandShape(command) {
  if (typeof command !== 'string' || composed(command)) return '';
  const words = [];
  for (const word of command.trim().split(/\s+/)) {
    if (words.length === MAX_SHAPE_WORDS || !SHAPE_WORD.test(word)) break;
    words.push(word);
  }
  const shape = words.join(' ');
  return SECRET_VALUE.test(shape) ? '' : shape;
}

// Field-level evidence for a gate decision (#3618, R53).
//
// A gate's verdict names the rule that fired but not the field it measured or
// what the value was, so a reader of the audit trail cannot see *what* a
// normalization, redaction or truncation changed. This turns the bounded
// signals a decision already carries -- the caller's input key list, the
// allowlist entry that promoted a command, the resolved target, the command
// shape -- into `{propertyPath, valueBefore, valueAfter}` rows, and names the
// one projection that always changes the value: the firewall's 512-char clip
// (`valueBefore` is the true length, `valueAfter` the retained length).
//
// It is pure and only reads the redacted, already-bounded envelope, so no raw
// caller value enters the rows. Each row is capped at MAX_EVIDENCE_BYTES and
// the list at MAX_EVIDENCE_ROWS, so a decision can never carry an unbounded
// proof. Returns a frozen list; empty when the evidence is not a plain array.
const MAX_EVIDENCE_ROWS = 16;
const MAX_EVIDENCE_BYTES = 200;

function boundedEvidenceValue(value) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length > MAX_EVIDENCE_BYTES ? text.slice(0, MAX_EVIDENCE_BYTES) : text;
}

function externalActionFieldEvidence(envelope) {
  if (!isPlainObject(envelope)) return Object.freeze([]);
  const rows = [];
  const push = (propertyPath, valueBefore, valueAfter) => {
    if (rows.length >= MAX_EVIDENCE_ROWS) return;
    rows.push(Object.freeze({
      propertyPath,
      valueBefore: boundedEvidenceValue(valueBefore),
      valueAfter: boundedEvidenceValue(valueAfter),
    }));
  };

  // The key list is the only shape of the inputs the firewall keeps; naming it
  // beside the fingerprint says which fields the decision saw without copying
  // any of their values.
  const keys = Array.isArray(envelope.metadata?.inputKeys) ? envelope.metadata.inputKeys : [];
  if (keys.length) push('args', keys.join(','), keys.join(','));

  // The allowlist entry, when a deployment's own command policy is what
  // promoted a command that would otherwise have needed review (#1799). The
  // caller's command never lands here: only the matched entry does.
  if (envelope.allowlistedCommand) push('command.allowlist', '', envelope.allowlistedCommand);

  // The relative target and the one absolute file admission pinned (#1865).
  if (envelope.target?.path && envelope.target?.resolvedPath) {
    push('target.path', envelope.target.path, envelope.target.resolvedPath);
  }

  // The leading verb run a receipt records as the command's shape (#3025).
  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL && envelope.command) {
    const shape = commandShape(envelope.command);
    if (shape && shape !== envelope.command) push('command', shape, envelope.command);
  }
  return Object.freeze(rows);
}

function inferRiskCategory(envelope, allowedCommands = []) {
  if (Object.values(ACTION_CATEGORIES).includes(envelope.riskCategory)) return envelope.riskCategory;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL) {
    if (DEPLOY_SHELL.test(envelope.command)) return ACTION_CATEGORIES.DEPLOYMENT;
    if (PERMISSION_SHELL.test(envelope.command)) return ACTION_CATEGORIES.PERMISSION_CHANGE;
    if (WRITE_SHELL.test(envelope.command)) return ACTION_CATEGORIES.FILESYSTEM_WRITE;
    if (composed(envelope.command)) return ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
    if (SAFE_SHELL.test(envelope.command) || VERSION_QUERY.test(envelope.command)) return ACTION_CATEGORIES.READ_ONLY;
    if (allowlistMatch(envelope.command, allowedCommands)) return ACTION_CATEGORIES.READ_ONLY;
    return ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  }
  if (envelope.kind === EXTERNAL_ACTION_KINDS.FILE_READ) return ACTION_CATEGORIES.READ_ONLY;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.FILE_WRITE) return ACTION_CATEGORIES.FILESYSTEM_WRITE;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.NETWORK) return ACTION_CATEGORIES.NETWORK_CALL;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.MEMORY) return ACTION_CATEGORIES.MEMORY_WRITE;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.DEPLOYMENT) return ACTION_CATEGORIES.DEPLOYMENT;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.PERMISSION) return ACTION_CATEGORIES.PERMISSION_CHANGE;
  if (envelope.kind === EXTERNAL_ACTION_KINDS.AUTOMATION) return ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  return ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
}

function normalizeExternalActionEnvelope(input, options = {}) {
  const source = isPlainObject(input) ? input : {};
  const rawAgent = isPlainObject(source.agent) ? source.agent : {};
  const rawSession = isPlainObject(source.session) ? source.session : {};
  const rawTool = isPlainObject(source.tool) ? source.tool : {};
  const args = isPlainObject(source.args) || Array.isArray(source.args) ? jsonClone(source.args) : {};
  const toolName = text(rawTool.name, text(source.toolName ?? source.tool));
  const agentName = text(rawAgent.name, text(source.agentName, text(options.agentName)));
  const sessionId = text(rawSession.id, text(source.sessionId));
  const suppliedInvocationId = text(source.invocationId, text(source.toolUseId ?? source.toolCallId));
  const invocationId = suppliedInvocationId || crypto.randomUUID();
  const cwd = path.resolve(text(source.cwd, text(options.cwd, process.cwd())));
  const workspaceRoot = path.resolve(text(source.workspaceRoot, text(options.workspaceRoot, cwd)));
  const kind = inferExternalActionKind(toolName, args, rawTool.kind ?? source.kind);
  const envelope = {
    schemaVersion: EXTERNAL_ACTION_SCHEMA_VERSION,
    invocationId,
    generatedInvocationId: !suppliedInvocationId,
    agent: {
      name: agentName,
      version: text(rawAgent.version, text(source.agentVersion)),
      instanceId: text(rawAgent.instanceId, agentName),
    },
    session: {
      id: sessionId,
      turnId: text(rawSession.turnId, text(source.turnId)),
    },
    tool: { name: toolName, kind },
    kind,
    action: text(source.action, toolName),
    args,
    command: extractCommand(args, source.command),
    cwd,
    workspaceRoot,
    workspaceId: text(source.workspaceId, 'default'),
    targetWorkspaceId: text(source.targetWorkspaceId),
    workspaceGrants: Array.isArray(source.workspaceGrants) ? [...source.workspaceGrants] : [],
    target: {
      path: extractTargetPath(args, source.targetPath),
      url: extractTargetUrl(args, source.targetUrl),
    },
    riskCategory: text(source.riskCategory),
    // Carried through verbatim; lib/external-action-identity.js owns the card
    // contract. Keeping the shape unvalidated here avoids a require cycle
    // between the envelope and the identity module.
    identityCard: source.identity === undefined ? null : jsonClone(source.identity, null),
    // Detached capability-card signature (ed25519). Carried through verbatim;
    // lib/external-action-identity.js owns the verification contract.
    identityCardSignature: isPlainObject(source.identityCardSignature)
      ? jsonClone(source.identityCardSignature)
      : null,
    metadata: isPlainObject(source.metadata) ? jsonClone(source.metadata) : {},
  };
  envelope.riskCategory = inferRiskCategory(envelope, options.allowedCommands);
  // The one absolute file both readings measure. A relative target belongs to
  // the action, not to the guard process, so it resolves against the action
  // cwd once, here -- admission and outcome never re-resolve it (#1865).
  // `path.resolve` leaves an already-absolute target untouched.
  envelope.target.resolvedPath = envelope.target.path ? path.resolve(cwd, envelope.target.path) : '';
  // Recorded, not re-derived: a receipt has to be able to say that this allow
  // came from the deployment's list, and which entry did it. Only a command
  // the built-in rules would not have called read-only counts as promoted.
  envelope.allowlistedCommand = envelope.kind === EXTERNAL_ACTION_KINDS.SHELL
    && envelope.riskCategory === ACTION_CATEGORIES.READ_ONLY
    && !SAFE_SHELL.test(envelope.command) && !VERSION_QUERY.test(envelope.command)
    ? allowlistMatch(envelope.command, options.allowedCommands)
    : '';
  envelope.malformed = !toolName || !agentName || !sessionId;
  envelope.errors = [
    ...(!toolName ? ['missing_tool_name'] : []),
    ...(!agentName ? ['missing_agent_name'] : []),
    ...(!sessionId ? ['missing_session_id'] : []),
  ];
  return envelope;
}

module.exports = {
  EXTERNAL_ACTION_SCHEMA_VERSION,
  EXTERNAL_ACTION_KINDS,
  normalizeExternalActionEnvelope,
  inferExternalActionKind,
  inferRiskCategory,
  extractCommand,
  extractTargetPath,
  extractTargetUrl,
  redactExternalValue,
  commandShape,
  externalActionFieldEvidence,
};
