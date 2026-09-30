'use strict';

/**
 * Free-text command parsing, shared between the CLI's REPL and the HTTP
 * `/api?q=` endpoint. Both need to turn a typed Turkish/English sentence into
 * a `{ command, args }` pair before dispatching it — this used to live only
 * on the CLI class, so server.js had to construct a whole CLI instance
 * (kernel + Dream + agent + LLM adapter) just to reach `.parse()` (#326).
 * `parseCommand` takes the kernel it needs as an explicit argument instead.
 */

const {
  parseHypothesesArgs,
  parseConflictReviewArgs,
} = require('./command-parser-review-args');

function extractQuoted(raw) {
  const quoted = String(raw || '').match(/"([^"]+)"/g) || [];
  return quoted.map(item => item.slice(1, -1));
}

function parseCompanyIngestArgs(raw) {
  const text = String(raw || '');
  const sourceMatch = text.match(/--kaynak\s+(\S+)/i);
  if (!sourceMatch) return null;
  const source = sourceMatch[1].toLowerCase();
  const quoted = extractQuoted(text);

  const readFlag = (name) => {
    const match = text.match(new RegExp(`--${name}\\s+([^\\s]+)`, 'i'));
    return match ? match[1] : '';
  };

  return {
    source,
    author: readFlag('yazar') || readFlag('author') || 'unknown',
    repoUrl: readFlag('repo') || readFlag('url'),
    targetPath: readFlag('yol') || readFlag('path'),
    title: readFlag('baslik') || quoted[0] || '',
    rationale: readFlag('gerekce') || quoted[1] || '',
    text: quoted[quoted.length - 1] || '',
    date: readFlag('tarih') || '',
  };
}

function normalizeCommandText(input) {
  return String(input || '')
    .replace(/﻿/g, '')
    .toLowerCase()
    .trim()
    .replace(/[ç]/g, 'c')
    .replace(/[ğ]/g, 'g')
    .replace(/[ı]/g, 'i')
    .replace(/[ö]/g, 'o')
    .replace(/[ş]/g, 's')
    .replace(/[ü]/g, 'u');
}

function normalizeCompareArgs(raw) {
  const text = String(raw || '').trim();
  if (!text) return '';
  const pipeParts = text.split('|').map(part => part.trim()).filter(Boolean);
  if (pipeParts.length === 2) return `${pipeParts[0]}|${pipeParts[1]}`;
  const vsParts = text.split(/\s+vs\s+/i).map(part => part.trim()).filter(Boolean);
  if (vsParts.length === 2) return `${vsParts[0]}|${vsParts[1]}`;
  return text;
}

function parseApprovalDecisionArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const workspaceIndex = parts.indexOf('--workspace');
  const workspaceId = workspaceIndex >= 0 ? (parts[workspaceIndex + 1] || '') : 'default';
  const positional = workspaceIndex >= 0
    ? parts.filter((part, index) => index !== workspaceIndex && index !== workspaceIndex + 1)
    : parts;
  const [approvalId = '', requestedDecision = 'approved'] = positional;
  const decision = requestedDecision.toLowerCase();
  const valid = ['approved', 'approve', 'rejected', 'reject'];
  return {
    approvalId,
    decision,
    invalidDecision: Boolean(decision) && !valid.includes(decision),
    ...(workspaceIndex >= 0 ? { workspaceId } : {}),
  };
}

function parseApprovalListArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const index = parts.indexOf('--workspace');
  return { workspaceId: index >= 0 ? (parts[index + 1] || '') : 'default' };
}

function parseTrustReceiptArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const workspaceIndex = parts.indexOf('--workspace');
  return {
    receiptId: parts[0] || '',
    workspaceId: workspaceIndex >= 0 ? (parts[workspaceIndex + 1] || '') : 'default',
  };
}

function parseExperienceReadArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const workspaceIndex = parts.indexOf('--workspace');
  const positional = workspaceIndex >= 0
    ? parts.filter((part, index) => index !== workspaceIndex && index !== workspaceIndex + 1)
    : parts;
  return {
    runId: positional[0] || '',
    workspaceId: workspaceIndex >= 0 ? (parts[workspaceIndex + 1] || '') : 'default',
  };
}

/** `experience-reconcile [<operationId>] [--workspace <id>] [--performed|--not-performed] [--reason <text>]`.
 * The reason runs to the next flag, so it may contain spaces. */
function parseExperienceReconcileArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const out = { operationId: '', workspaceId: '', performed: false, notPerformed: false, reason: '' };
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part === '--performed') {
      out.performed = true;
    } else if (part === '--not-performed') {
      out.notPerformed = true;
    } else if (part === '--workspace') {
      out.workspaceId = parts[index + 1] || '';
      index += 1;
    } else if (part === '--reason') {
      const words = [];
      while (index + 1 < parts.length && !parts[index + 1].startsWith('--')) {
        index += 1;
        words.push(parts[index]);
      }
      out.reason = words.join(' ').replace(/^["']|["']$/g, '');
    } else if (!out.operationId) {
      out.operationId = part;
    }
  }
  return out;
}


/** `experience-learn <runId> --workspace <id> [--kind <kind>] [--params <json>] [--parent-version <n>]`.
 * The `--params` JSON runs to the end of the line, so it may contain spaces and
 * must be the last flag. It is split off before any flag is read: a `--kind`
 * string inside the payload is parameter data, not a command flag. */
function parseExperienceLearnArgs(raw) {
  const text = String(raw || '').trim();
  const paramsMatch = text.match(/--params\s+(.+)$/i);
  const head = paramsMatch ? text.slice(0, paramsMatch.index) : text;
  let params;
  if (paramsMatch) {
    try { params = JSON.parse(paramsMatch[1].trim()); } catch { params = null; }
  }
  const readFlag = (name) => {
    const match = head.match(new RegExp(`--${name}\\s+(\\S+)`, 'i'));
    // A value that is itself a flag means the operand was omitted. Treat the
    // flag as absent rather than reading `--kind` as a workspace id; the
    // workspace then falls back to its documented default and the run lookup
    // fails closed rather than silently using the wrong scope.
    return match && !match[1].startsWith('--') ? match[1] : '';
  };
  const parentVersionRaw = readFlag('parent-version');
  // Remove each flag and, only when it actually has an operand, that operand.
  // `--workspace --kind x` must leave `x` behind (and not swallow `--kind`),
  // so a missing operand cannot silently become the runId.
  const positional = head
    .replace(/--(?:workspace|kind|parent-version)(?:\s+(?!-)\S+)?/gi, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const runId = positional[0] || '';
  return {
    runId,
    workspaceId: readFlag('workspace') || 'default',
    kind: readFlag('kind') || undefined,
    params,
    parentVersion: parentVersionRaw ? Number(parentVersionRaw) : undefined,
  };
}

/**
 * @param {string} input free-text command
 * @param {object} [kernel] used only for the final bare-noun-lookup fallback
 * @returns {{command: string, args: *}}
 */
// The rules of parseCommand, in the order they are tried (#2401). Each takes
// the parse context and returns `{ command, args }` or null; the first hit
// wins, so order is behavior and a new command is a new row in its place.
//
// Prefix commands (`name: payload`) decide on the folded text before the first
// colon, never on raw `trimmed`. RFC-001 decision 7 -- "a reader accepts both
// spellings; a writer emits only the canonical form" -- used to hold only for
// the fixed words: `öğret:` and `yükle:` were reachable only with diacritics
// and `dogrula:` only without. Folding the key makes both spellings of every
// prefix resolve to the same command. The payload is sliced from `raw` at the
// colon, not by a fixed offset: folding need not preserve length, and the
// payload must reach the handler byte-for-byte.
//
// Fixed-word commands match on `plain`, the folded reader text, so every
// entry is written in its folded form. These lists once compared against
// `trimmed` while holding 'yardım' and 'rüya', so `yardim` -- the spelling
// `compatibilityHelpText()` and the `/api/v2/workflows` manifest print -- fell
// through to 'anlamadım'. Folding here is what removed the one-off ASCII
// aliases ('dogrula:', 'geri yukle') that had been accumulating.
const identity = (payload) => payload;

function prefixRule(names, command, toArgs = identity) {
  return (ctx) => (ctx.isPrefix(...names) ? { command, args: toArgs(ctx.prefixPayload) } : null);
}

function wordRule(words, command, args = '') {
  const list = Array.isArray(words) ? words : [words];
  return (ctx) => (list.includes(ctx.plain) ? { command, args } : null);
}

function matchRule(pattern, source, build) {
  return (ctx) => {
    const match = ctx[source].match(pattern);
    return match ? build(match, ctx) : null;
  };
}

const COMMAND_RULES = Object.freeze([
  (ctx) => (/^(ogren|öğren)\s+--kaynak\s+/i.test(ctx.raw)
    ? { command: 'company-ingest', args: parseCompanyIngestArgs(ctx.raw) }
    : null),
  prefixRule(['sirket-sor'], 'company-query'),
  (ctx) => (ctx.trimmed === 'ingest-durum' ? { command: 'ingest-status', args: '' } : null),
  prefixRule(['learn', 'teach', 'ogret'], 'öğret'),
  prefixRule(['ask', 'sor'], 'sor'),
  prefixRule(['why', 'neden'], 'neden'),
  prefixRule(['compare', 'karsilastir'], 'karşılaştır', normalizeCompareArgs),
  prefixRule(['verify', 'dogrula'], 'verify'),
  prefixRule(['upload', 'yukle'], 'yükle'),
  prefixRule(['onayla'], 'onayla', parseApprovalDecisionArgs),
  prefixRule(['receipt'], 'receipt', parseTrustReceiptArgs),
  matchRule(/^experience-read(?:\s+(.+))?$/i, 'raw',
    (match) => ({ command: 'experience-read', args: parseExperienceReadArgs(match[1] || '') })),
  matchRule(/^experience-reconcile(?:\s+(.+))?$/i, 'raw',
    (match) => ({ command: 'experience-reconcile', args: parseExperienceReconcileArgs(match[1] || '') })),
  matchRule(/^experience-learn(?:\s+(.+))?$/i, 'raw',
    (match) => ({ command: 'experience-learn', args: parseExperienceLearnArgs(match[1] || '') })),
  prefixRule(['audit'], 'audit'),
  prefixRule(['hypotheses', 'hipotezler'], 'hypotheses', parseHypothesesArgs),
  prefixRule(['mri', 'mr'], 'mri'),
  prefixRule(['tartis'], 'tartis'),
  prefixRule(['celiski'], 'celiski'),
  prefixRule(['llm-sor'], 'llm-sor'),
  matchRule(/^(?:hypotheses|hipotezler)(?:\s+(.+))?$/i, 'trimmed',
    (match) => ({ command: 'hypotheses', args: parseHypothesesArgs(match[1] || '') })),
  // `conflicts` mirrors `hypotheses`, but reviews conflict-detector candidates
  // (#3187). Matched against `raw`: a candidateId is an opaque identifier, so
  // folding its case could name a different candidate than the user typed.
  matchRule(/^(?:conflicts|catismalar)(?:\s+(.+))?$/i, 'raw', (match) => {
    const args = parseConflictReviewArgs(match[1] || '');
    return args ? { command: 'conflicts', args } : null;
  }),
  prefixRule(['plan'], 'plan'),
  prefixRule(['ajan', 'agent'], 'ajan'),
  prefixRule(['restore'], 'restore'),
  (ctx) => (/^restore\s+--dry-run(?:\s+|$)/i.test(ctx.raw)
    ? { command: 'restore', args: { dryRun: true, backupDir: ctx.raw.replace(/^restore\s+--dry-run\s*/i, '').trim() } }
    : null),
  wordRule(['cikis', 'exit', 'quit'], 'exit'),
  wordRule(['quickstart', 'demo', 'basla'], 'quickstart'),
  wordRule('doctor', 'doctor'),
  wordRule(['durum', 'durum nedir', 'ne durumdasin', 'nasilsin', 'durum raporu', 'status'], 'durum'),
  wordRule(['ruya', 'ruya gor', 'hayal kur', 'ne dusunuyorsun', 'dream'], 'rüya'),
  wordRule(['kaydet', 'hafizayi kaydet', 'save'], 'kaydet'),
  wordRule(['backup', 'yedek', 'yedekle'], 'backup'),
  wordRule(['onaylar', 'approvals'], 'onaylar'),
  matchRule(/^(onaylar|approvals)\s+--workspace\s+(\S+)$/i, 'trimmed',
    (match) => ({ command: 'onaylar', args: { workspaceId: match[2] } })),
  (ctx) => (ctx.plain === 'hypotheses' || ctx.plain === 'hipotezler'
    ? { command: 'hypotheses', args: parseHypothesesArgs('') }
    : null),
  wordRule(['restore', 'geri yukle'], 'restore'),
  wordRule(['acik dusun', 'surekli dusun', 'otomatik dusun', 'dusun', 'auto think', 'dusunmeye basla', 'think', 'start thinking'], 'düşün', 'başla'),
  wordRule(['dur dusunme', 'dusunmeyi durdur', 'sus', 'sakin ol', 'stop thinking'], 'düşün', 'dur'),
  // 'çıkış' is deliberately absent: it folds to 'cikis', answered by `exit` above.
  wordRule(['kapat', 'gule gule', 'bb'], 'çıkış'),
  wordRule(['merhaba', 'selam', 'hey', 'hello', 'hi'], 'selam'),
  wordRule(['ne yapabilirsin', 'yardim', 'help', 'komutlar'], 'yardım'),
  wordRule(['optimize', 'temizle', 'hafizayi optimize et'], 'optimize'),
  wordRule(['birlestir', 'konsolide', 'konsolide et', 'toparla', 'consolidate'], 'konsolide'),
  wordRule(['evolve', 'evrim', 'gelis', 'kendini gelistir', 'kendilik'], 'evolve'),
  matchRule(/^(onaylar|approvals)\s+(show|detail|göster|goster|detay)\s+(\S+)$/i, 'trimmed',
    (match) => ({ command: 'onaylar', args: { approvalId: match[3] } })),
  matchRule(/^(onayla|approve)\s+(.+)/i, 'trimmed',
    (match) => ({ command: 'onayla', args: parseApprovalDecisionArgs(match[2]) })),
  matchRule(/^(receipt|trust-receipt)\s+(.+)/i, 'trimmed',
    (match) => ({ command: 'receipt', args: parseTrustReceiptArgs(match[2]) })),
  matchRule(/^audit\s*(.*)$/i, 'trimmed', (match) => ({ command: 'audit', args: (match[1] || '').trim() })),
  // `coder <task.json> [flags]`, bare form only, matched against `raw`: it
  // carries file paths and git refs, where folding case is not harmless
  // (`--base HEAD` became `--base head`, and a path changed on case-sensitive
  // filesystems). The command word stays case-insensitive via the flag.
  matchRule(/^coder\s+(.+)$/i, 'raw', (match) => ({ command: 'coder', args: match[1].trim() })),
  // Bare `why X` alongside bare `neden X`; without it `why chicken` fell
  // through to the question heuristic and answered as an ask.
  matchRule(/^(?:neden|why)\s+(.+)/i, 'trimmed', (match) => ({ command: 'neden', args: match[1] })),
  matchRule(/(.+?)\s+(ile|vs|ve)\s+(.+?)\s+(arasında|arasındaki fark|karşılaştır)/i, 'trimmed',
    (match) => ({ command: 'karşılaştır', args: `${match[1]}|${match[3]}` })),
  matchRule(/^(.+?)\s+(mı|mi|mu|mü)\s+(.+?)\s+(mı|mi|mu|mü)/i, 'trimmed', (match) => {
    const left = match[1].trim();
    const right = match[3].trim();
    return left && right && left !== right ? { command: 'karşılaştır', args: `${left}|${right}` } : null;
  }),
  (ctx) => (/\b(nedir|kimdir|nasıl|nerede|nereden|nereye|niçin|niye|kaç|hangi|mı|mi|mu|mü)\b/i.test(ctx.trimmed)
    ? { command: 'sor', args: ctx.trimmed }
    : null),
  (ctx) => {
    if (!ctx.trimmed) return null;
    const { kernel } = ctx;
    const wordNode = typeof kernel?.normalizeWord === 'function' ? kernel.normalizeWord(ctx.trimmed) : ctx.trimmed;
    return typeof kernel?.graph?.getNode === 'function' && kernel.graph.getNode(wordNode)
      ? { command: 'sor', args: ctx.trimmed }
      : null;
  },
]);

function parseCommand(input, kernel) {
  const raw = String(input || '').trim();
  const colonIndex = raw.indexOf(':');
  const prefixKey = colonIndex >= 0
    ? normalizeCommandText(raw.slice(0, colonIndex)).replace(/[^a-z0-9\s-]/g, '')
    : '';
  const ctx = {
    raw,
    trimmed: raw.toLowerCase(),
    plain: normalizeCommandText(raw).replace(/[^a-z0-9:\s-]/g, ''),
    prefixPayload: colonIndex >= 0 ? raw.slice(colonIndex + 1).trim() : '',
    isPrefix: (...names) => colonIndex >= 0 && names.includes(prefixKey),
    kernel,
  };
  for (const rule of COMMAND_RULES) {
    const parsed = rule(ctx);
    if (parsed) return parsed;
  }
  return { command: 'anlamadım', args: '' };
}

const parseCommandPair = parseCommand;
const { workflowIdForCommand } = require('./cli-workflow-adapter');

function parseWorkflowCommand(input, kernel) {
  const parsed = parseCommandPair(input, kernel);
  return { ...parsed, workflowId: workflowIdForCommand(parsed.command) };
}

module.exports = {
  parseCommand: parseWorkflowCommand,
  parseCompanyIngestArgs,
  extractQuoted,
  normalizeCommandText,
  normalizeCompareArgs,
  parseApprovalDecisionArgs,
  parseTrustReceiptArgs,
  parseExperienceReadArgs,
  parseExperienceLearnArgs,
  parseExperienceReconcileArgs,
  parseHypothesesArgs,
  parseConflictReviewArgs,
};
