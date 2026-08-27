'use strict';

/**
 * Free-text command parsing, shared between the CLI's REPL and the HTTP
 * `/api?q=` endpoint. Both need to turn a typed Turkish/English sentence into
 * a `{ command, args }` pair before dispatching it — this used to live only
 * on the CLI class, so server.js had to construct a whole CLI instance
 * (kernel + Dream + agent + LLM adapter) just to reach `.parse()` (#326).
 * `parseCommand` takes the kernel it needs as an explicit argument instead.
 */

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
  const [approvalId = '', requestedDecision = 'approved'] = String(raw || '').trim().split(/\s+/, 2);
  const decision = requestedDecision.toLowerCase();
  const valid = ['approved', 'approve', 'rejected', 'reject'];
  return {
    approvalId,
    decision,
    invalidDecision: Boolean(decision) && !valid.includes(decision),
  };
}

function parseTrustReceiptArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const workspaceIndex = parts.indexOf('--workspace');
  return {
    receiptId: parts[0] || '',
    workspaceId: workspaceIndex >= 0 ? (parts[workspaceIndex + 1] || '') : 'default',
  };
}

function parseHypothesesArgs(raw) {
  const parts = String(raw || '').trim().split(/\s+/).filter(Boolean);
  const readFlag = (...names) => {
    for (const name of names) {
      const index = parts.indexOf(`--${name}`);
      if (index >= 0) return parts[index + 1] || '';
    }
    return '';
  };
  const base = {
    workspaceId: readFlag('workspaceId', 'workspace', 'w') || 'default',
    confidenceFloor: readFlag('confidenceFloor'),
    criticalInDegree: readFlag('critical'),
    smallComponentSize: readFlag('small'),
    propose: parts.includes('--propose'),
    json: parts.includes('--json'),
  };

  // `hypotheses feedback` reports what the recorded verdicts add up to per
  // rule. Read-only, like the bare report, and parsed as its own shape so it
  // never reaches the analysis path with a rule-report's thresholds applied.
  if (parts[0] === 'feedback' || parts[0] === 'geribildirim') return { ...base, feedback: true };

  // `hypotheses tuning` turns that feedback into a threshold proposal. Also
  // read-only: it advises, and applying the advice stays a human act.
  if (parts[0] === 'tuning' || parts[0] === 'ayar') return { ...base, tuning: true };

  // `hypotheses fitness` scores graph health. Read-only: it measures, and
  // acting on the measurement is not this command's job.
  if (parts[0] === 'fitness' || parts[0] === 'saglik') return { ...base, fitness: true };

  // `hypotheses review <candidateId> --accept|--reject` records a human
  // verdict on a queued candidate. It is the only sub-command here that
  // writes, and it is parsed as a distinct shape so the read-only report path
  // cannot be reached with review arguments still attached.
  if (parts[0] !== 'review' && parts[0] !== 'incele') return base;
  const decision = parts.includes('--accept') || parts.includes('--kabul')
    ? 'accept'
    : parts.includes('--reject') || parts.includes('--ret')
      ? 'reject'
      : '';
  return {
    ...base,
    review: true,
    candidateId: parts[1] && !parts[1].startsWith('--') ? parts[1] : '',
    decision,
    reviewer: readFlag('reviewer', 'reviewedBy'),
  };
}

/**
 * @param {string} input free-text command
 * @param {object} [kernel] used only for the final bare-noun-lookup fallback
 * @returns {{command: string, args: *}}
 */
function parseCommand(input, kernel) {
  const raw = String(input || '').trim();
  const trimmed = raw.toLowerCase();
  const normalized = normalizeCommandText(raw);
  const plain = normalized.replace(/[^a-z0-9:\s-]/g, '');

  if (/^(ogren|öğren)\s+--kaynak\s+/i.test(raw)) {
    const parsed = parseCompanyIngestArgs(raw);
    return { command: 'company-ingest', args: parsed };
  }
  // Prefix commands decide on the folded reader text, never on raw `trimmed`.
  //
  // RFC-001 decision 7 — "a reader accepts both spellings; a writer emits only
  // the canonical form" — was already applied to the fixed-word commands below,
  // but the `:` prefixes still compared against `trimmed`, the raw lowercased
  // input. That made the family asymmetric in both directions: `öğret:` and
  // `yükle:` were reachable only in their diacritic spelling, while `dogrula:`
  // was reachable only in its ASCII one, and each new alias had to be pinned by
  // hand next to its twin. `prefixKey` folds the text before the first colon
  // exactly the way `plain` folds the rest of the reader input, so both
  // spellings of every prefix resolve to the same command.
  //
  // The payload is sliced from `raw` at the colon rather than by a fixed
  // offset: folding is not guaranteed to preserve length, and the payload must
  // reach the handler byte-for-byte — only the prefix decision is folded.
  const colonIndex = raw.indexOf(':');
  const prefixKey = colonIndex >= 0
    ? normalizeCommandText(raw.slice(0, colonIndex)).replace(/[^a-z0-9\s-]/g, '')
    : '';
  const prefixPayload = colonIndex >= 0 ? raw.slice(colonIndex + 1).trim() : '';
  const isPrefix = (...names) => colonIndex >= 0 && names.includes(prefixKey);

  if (isPrefix('sirket-sor')) return { command: 'company-query', args: prefixPayload };
  if (trimmed === 'ingest-durum') return { command: 'ingest-status', args: '' };
  if (isPrefix('learn', 'teach', 'ogret')) return { command: 'öğret', args: prefixPayload };
  if (isPrefix('ask', 'sor')) return { command: 'sor', args: prefixPayload };
  if (isPrefix('why', 'neden')) return { command: 'neden', args: prefixPayload };
  if (isPrefix('compare', 'karsilastir')) return { command: 'karşılaştır', args: normalizeCompareArgs(prefixPayload) };
  if (isPrefix('verify', 'dogrula')) return { command: 'verify', args: prefixPayload };
  if (isPrefix('upload', 'yukle')) return { command: 'yükle', args: prefixPayload };

  if (isPrefix('onayla')) return { command: 'onayla', args: parseApprovalDecisionArgs(prefixPayload) };
  if (isPrefix('receipt')) return { command: 'receipt', args: parseTrustReceiptArgs(prefixPayload) };
  if (isPrefix('hypotheses', 'hipotezler')) return { command: 'hypotheses', args: parseHypothesesArgs(prefixPayload) };

  if (isPrefix('mri', 'mr')) return { command: 'mri', args: prefixPayload };
  if (isPrefix('tartis')) return { command: 'tartis', args: prefixPayload };
  if (isPrefix('celiski')) return { command: 'celiski', args: prefixPayload };

  if (isPrefix('llm-sor')) return { command: 'llm-sor', args: prefixPayload };

  const hypothesesMatch = trimmed.match(/^(?:hypotheses|hipotezler)(?:\s+(.+))?$/i);
  if (hypothesesMatch) return { command: 'hypotheses', args: parseHypothesesArgs(hypothesesMatch[1] || '') };

  if (isPrefix('plan')) return { command: 'plan', args: prefixPayload };
  if (isPrefix('ajan', 'agent')) return { command: 'ajan', args: prefixPayload };
  if (isPrefix('restore')) return { command: 'restore', args: prefixPayload };
  if (/^restore\s+--dry-run(?:\s+|$)/i.test(raw)) return { command: 'restore', args: { dryRun: true, backupDir: raw.replace(/^restore\s+--dry-run\s*/i, '').trim() } };

  // Fixed-word commands match on `plain`, so every entry below is written in
  // its diacritic-folded form.
  //
  // RFC-001 decision 7 is "a reader accepts both spellings; a writer emits only
  // the canonical form", and these lists used to compare against `trimmed` —
  // the raw lowercased input — while holding entries like 'yardım' and 'rüya'.
  // That accepted only the diacritic spelling: `yardım` reached the help,
  // `yardim` fell through to 'anlamadım'. The ASCII spelling is the one
  // `compatibilityHelpText()` and the `/api/v2/workflows` manifest print, so
  // the surfaces were advertising exactly the spelling the reader rejected.
  //
  // `normalized` and `plain` were already computed at the top of this function
  // and simply were not used here; the `exit` line below has always matched on
  // `plain`, which is why `çıkış` alone worked in both spellings. Folding the
  // rest is what makes that the rule rather than the exception, and it removes
  // the need for the one-off ASCII aliases ('dogrula:', 'geri yukle') that had
  // been accumulating next to their diacritic twins.
  if (['cikis', 'exit', 'quit'].includes(plain)) return { command: 'exit', args: '' };

  if (['quickstart', 'demo', 'basla'].includes(plain)) return { command: 'quickstart', args: '' };
  if (['durum', 'durum nedir', 'ne durumdasin', 'nasilsin', 'durum raporu', 'status'].includes(plain)) return { command: 'durum', args: '' };
  if (['ruya', 'ruya gor', 'hayal kur', 'ne dusunuyorsun', 'dream'].includes(plain)) return { command: 'rüya', args: '' };
  if (['kaydet', 'hafizayi kaydet', 'save'].includes(plain)) return { command: 'kaydet', args: '' };
  if (['backup', 'yedek', 'yedekle'].includes(plain)) return { command: 'backup', args: '' };
  if (['onaylar', 'approvals'].includes(plain)) return { command: 'onaylar', args: '' };
  if (plain === 'hypotheses' || plain === 'hipotezler') return { command: 'hypotheses', args: parseHypothesesArgs('') };
  if (['restore', 'geri yukle'].includes(plain)) return { command: 'restore', args: '' };
  if (['acik dusun', 'surekli dusun', 'otomatik dusun', 'dusun', 'auto think', 'dusunmeye basla', 'think', 'start thinking'].includes(plain)) return { command: 'düşün', args: 'başla' };
  if (['dur dusunme', 'dusunmeyi durdur', 'sus', 'sakin ol', 'stop thinking'].includes(plain)) return { command: 'düşün', args: 'dur' };
  // 'çıkış' is deliberately absent: it folds to 'cikis' and is already answered
  // by the exit line above, in both spellings.
  if (['kapat', 'gule gule', 'bb'].includes(plain)) return { command: 'çıkış', args: '' };
  if (['merhaba', 'selam', 'hey', 'hello', 'hi'].includes(plain)) return { command: 'selam', args: '' };
  if (['ne yapabilirsin', 'yardim', 'help', 'komutlar'].includes(plain)) return { command: 'yardım', args: '' };
  if (['optimize', 'temizle', 'hafizayi optimize et'].includes(plain)) return { command: 'optimize', args: '' };
  if (['birlestir', 'konsolide', 'konsolide et', 'toparla', 'consolidate'].includes(plain)) return { command: 'konsolide', args: '' };
  if (['evolve', 'evrim', 'gelis', 'kendini gelistir', 'kendilik'].includes(plain)) return { command: 'evolve', args: '' };

  const approvalDetailMatch = trimmed.match(/^(onaylar|approvals)\s+(show|detail|göster|goster|detay)\s+(\S+)$/i);
  if (approvalDetailMatch) return { command: 'onaylar', args: { approvalId: approvalDetailMatch[3] } };

  const approvalMatch = trimmed.match(/^(onayla|approve)\s+(.+)/i);
  if (approvalMatch) return { command: 'onayla', args: parseApprovalDecisionArgs(approvalMatch[2]) };

  const receiptMatch = trimmed.match(/^(receipt|trust-receipt)\s+(.+)/i);
  if (receiptMatch) return { command: 'receipt', args: parseTrustReceiptArgs(receiptMatch[2]) };

  // Bare `why X` alongside bare `neden X`. The `why:` prefix already existed;
  // the prefixless form did not, so `why chicken` fell through to the question
  // heuristic and answered as an ask.
  const nedenMatch = trimmed.match(/^(?:neden|why)\s+(.+)/i);
  if (nedenMatch) return { command: 'neden', args: nedenMatch[1] };

  const compareMatch = trimmed.match(/(.+?)\s+(ile|vs|ve)\s+(.+?)\s+(arasında|arasındaki fark|karşılaştır)/i);
  if (compareMatch) return { command: 'karşılaştır', args: `${compareMatch[1]}|${compareMatch[3]}` };

  const miMatch = trimmed.match(/^(.+?)\s+(mı|mi|mu|mü)\s+(.+?)\s+(mı|mi|mu|mü)/i);
  if (miMatch) {
    const left = miMatch[1].trim();
    const right = miMatch[3].trim();
    if (left && right && left !== right) return { command: 'karşılaştır', args: `${left}|${right}` };
  }

  const questionPattern = /\b(nedir|kimdir|nasıl|nerede|nereden|nereye|niçin|niye|kaç|hangi|mı|mi|mu|mü)\b/i;
  if (questionPattern.test(trimmed)) return { command: 'sor', args: trimmed };

  if (trimmed) {
    const wordNode = typeof kernel?.normalizeWord === 'function' ? kernel.normalizeWord(trimmed) : trimmed;
    if (typeof kernel?.graph?.getNode === 'function' && kernel.graph.getNode(wordNode)) {
      return { command: 'sor', args: trimmed };
    }
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
  parseHypothesesArgs,
};
