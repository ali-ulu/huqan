'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { ACTION_CATEGORIES, RISK_LEVELS, resolveRiskLevel } = require('./action-risk-classifier');
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
// caller value enters the rows. Each row value is capped at MAX_EVIDENCE_BYTES
// and the row count is bounded by construction (one row per signal), so a
// decision can never carry an unbounded proof. Returns a frozen list; empty
// when the evidence is not a plain array.
const MAX_EVIDENCE_BYTES = 200;

function boundedEvidenceValue(value) {
  const text = String(value);
  if (Buffer.byteLength(text, 'utf8') <= MAX_EVIDENCE_BYTES) return text;
  // The cap is a byte budget, so measure UTF-8 bytes and cut on a code-point
  // boundary: String.length counts UTF-16 code units, which would let a run of
  // multi-byte characters exceed the cap and could split a character.
  let result = '';
  let bytes = 0;
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (bytes + size > MAX_EVIDENCE_BYTES) break;
    result += char;
    bytes += size;
  }
  return result;
}

function externalActionFieldEvidence(envelope) {
  if (!isPlainObject(envelope)) return Object.freeze([]);
  const rows = [];
  const push = (propertyPath, valueBefore, valueAfter) => {
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

  // The leading verb run a receipt records as the command's shape (#3025):
  // the command is reduced to its shape, so before is the command and after
  // the shape it became.
  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL && envelope.command) {
    const shape = commandShape(envelope.command);
    if (shape && shape !== envelope.command) push('command', envelope.command, shape);
  }
  return Object.freeze(rows);
}

/**
 * How strict a category's rule is, least strict first: the risk level the
 * category carries. Used only to compare two categories, never to decide what
 * the action is.
 */
const RISK_SEVERITY = Object.freeze({
  [RISK_LEVELS.LOW]: 1,
  [RISK_LEVELS.MEDIUM]: 2,
  [RISK_LEVELS.HIGH]: 3,
  [RISK_LEVELS.CRITICAL]: 4,
});

function severityOf(category) {
  return RISK_SEVERITY[resolveRiskLevel(category)] || 0;
}

/**
 * The categories a declared category may replace: the generic bucket (shape
 * not recognised) and READ_ONLY (the only rule that can ALLOW, so any stricter
 * rule may take its place). Every other derived category carries a check of its
 * own, and replacing it would drop that check.
 */
const REPLACEABLE_BY_DECLARATION = Object.freeze([
  ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION,
  ACTION_CATEGORIES.READ_ONLY,
]);

const KIND_CATEGORY = Object.freeze({
  [EXTERNAL_ACTION_KINDS.FILE_READ]: ACTION_CATEGORIES.READ_ONLY,
  [EXTERNAL_ACTION_KINDS.FILE_WRITE]: ACTION_CATEGORIES.FILESYSTEM_WRITE,
  [EXTERNAL_ACTION_KINDS.NETWORK]: ACTION_CATEGORIES.NETWORK_CALL,
  [EXTERNAL_ACTION_KINDS.MEMORY]: ACTION_CATEGORIES.MEMORY_WRITE,
  [EXTERNAL_ACTION_KINDS.DEPLOYMENT]: ACTION_CATEGORIES.DEPLOYMENT,
  [EXTERNAL_ACTION_KINDS.PERMISSION]: ACTION_CATEGORIES.PERMISSION_CHANGE,
});

// The command's own shape, whatever kind the caller wrote (#4099).
function commandShapeCategory(command) {
  if (!command) return '';
  if (DEPLOY_SHELL.test(command)) return ACTION_CATEGORIES.DEPLOYMENT;
  if (PERMISSION_SHELL.test(command)) return ACTION_CATEGORIES.PERMISSION_CHANGE;
  if (WRITE_SHELL.test(command)) return ACTION_CATEGORIES.FILESYSTEM_WRITE;
  if (composed(command)) return ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  return '';
}

/**
 * The category the action's own shape implies: the command's verb, the
 * action's kind, and the deployment's own command policy.
 *
 * A command under a non-shell kind is graded by its shape too, and the
 * stricter finding wins (a tie goes to the command). The downgrade to
 * READ_ONLY by a safe command or the allowlist stays shell-only.
 */
function deriveRiskCategory(envelope, allowedCommands = []) {
  const byShape = commandShapeCategory(envelope.command);
  if (envelope.kind === EXTERNAL_ACTION_KINDS.SHELL) {
    if (byShape) return byShape;
    const { command } = envelope;
    if (SAFE_SHELL.test(command) || VERSION_QUERY.test(command)) return ACTION_CATEGORIES.READ_ONLY;
    if (allowlistMatch(command, allowedCommands)) return ACTION_CATEGORIES.READ_ONLY;
    return ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  }
  const byKind = KIND_CATEGORY[envelope.kind] || ACTION_CATEGORIES.TOOL_CHAIN_EXECUTION;
  return byShape && severityOf(byShape) >= severityOf(byKind) ? byShape : byKind;
}

/**
 * The category the envelope records, and the rule the gate will run.
 *
 * The action's own shape decides it. A declared category, which the caller
 * wrote, may only move it to a stricter place, and only where the shape left
 * the action open (see REPLACEABLE_BY_DECLARATION). A declaration that
 * lowered a deployment command to READ_ONLY would skip the production block
 * and get ALLOW, so it may never lower the action's severity.
 */
function inferRiskCategory(envelope, allowedCommands = []) {
  const derived = deriveRiskCategory(envelope, allowedCommands);
  const declared = envelope.riskCategory;
  if (!Object.values(ACTION_CATEGORIES).includes(declared)) return derived;
  if (!REPLACEABLE_BY_DECLARATION.includes(derived)) return derived;
  if (severityOf(declared) < severityOf(derived)) return derived;
  return declared;
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
