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
  if (trimmed.startsWith('sirket-sor:')) return { command: 'company-query', args: raw.slice(11).trim() };
  if (trimmed === 'ingest-durum') return { command: 'ingest-status', args: '' };
  if (trimmed.startsWith('learn:')) return { command: 'öğret', args: raw.slice(6).trim() };
  if (trimmed.startsWith('teach:')) return { command: 'öğret', args: raw.slice(6).trim() };
  if (trimmed.startsWith('ask:')) return { command: 'sor', args: raw.slice(4).trim() };
  if (trimmed.startsWith('why:')) return { command: 'neden', args: raw.slice(4).trim() };
  if (trimmed.startsWith('compare:')) return { command: 'karşılaştır', args: normalizeCompareArgs(raw.slice(8).trim()) };
  if (trimmed.startsWith('verify:')) return { command: 'verify', args: raw.slice(7).trim() };
  if (trimmed.startsWith('dogrula:')) return { command: 'verify', args: raw.slice(8).trim() };
  if (trimmed.startsWith('upload:')) return { command: 'yükle', args: raw.slice(7).trim() };

  if (trimmed.startsWith('onayla:')) return { command: 'onayla', args: parseApprovalDecisionArgs(raw.slice(7).trim()) };
  if (trimmed.startsWith('receipt:')) return { command: 'receipt', args: parseTrustReceiptArgs(raw.slice(8).trim()) };

  if (plain.startsWith('mri:') || plain.startsWith('mr:') || plain.startsWith('tartis:') || plain.startsWith('celiski:')) {
    const sep = raw.indexOf(':');
    const payload = sep >= 0 ? raw.slice(sep + 1).trim() : '';
    if (plain.startsWith('mri:') || plain.startsWith('mr:')) return { command: 'mri', args: payload };
    if (plain.startsWith('tartis:')) return { command: 'tartis', args: payload };
    return { command: 'celiski', args: payload };
  }

  if (trimmed.startsWith('öğret:')) return { command: 'öğret', args: raw.slice(6).trim() };
  if (trimmed.startsWith('llm-sor:')) return { command: 'llm-sor', args: raw.slice(8).trim() };
  if (trimmed.startsWith('plan:')) return { command: 'plan', args: raw.slice(5).trim() };
  if (trimmed.startsWith('ajan:')) return { command: 'ajan', args: raw.slice(5).trim() };
  if (trimmed.startsWith('agent:')) return { command: 'ajan', args: raw.slice(6).trim() };
  if (trimmed.startsWith('yükle:')) return { command: 'yükle', args: raw.slice(6).trim() };
  if (trimmed.startsWith('restore:')) return { command: 'restore', args: raw.slice(8).trim() };
  if (/^restore\s+--dry-run(?:\s+|$)/i.test(raw)) return { command: 'restore', args: { dryRun: true, backupDir: raw.replace(/^restore\s+--dry-run\s*/i, '').trim() } };
  if (trimmed.startsWith('sor:')) return { command: 'sor', args: raw.slice(4).trim() };

  if (['cikis', 'exit', 'quit'].includes(plain)) return { command: 'exit', args: '' };

  if (['quickstart', 'demo', 'başla', 'basla'].includes(trimmed)) return { command: 'quickstart', args: '' };
  if (['durum', 'durum nedir', 'ne durumdasın', 'nasılsın', 'durum raporu', 'status'].includes(trimmed)) return { command: 'durum', args: '' };
  if (['rüya', 'rüya gör', 'hayal kur', 'ne düşünüyorsun', 'dream'].includes(trimmed)) return { command: 'rüya', args: '' };
  if (['kaydet', 'hafızayı kaydet', 'save'].includes(trimmed)) return { command: 'kaydet', args: '' };
  if (['backup', 'yedek', 'yedekle'].includes(trimmed)) return { command: 'backup', args: '' };
  if (['onaylar', 'approvals'].includes(trimmed)) return { command: 'onaylar', args: '' };
  if (['restore', 'geri yükle', 'geri yukle'].includes(trimmed)) return { command: 'restore', args: '' };
  if (['açık düşün', 'sürekli düşün', 'otomatik düşün', 'auto think', 'düşünmeye başla', 'think', 'start thinking'].includes(trimmed)) return { command: 'düşün', args: 'başla' };
  if (['dur düşünme', 'düşünmeyi durdur', 'sus', 'sakin ol', 'stop thinking'].includes(trimmed)) return { command: 'düşün', args: 'dur' };
  if (['çıkış', 'kapat', 'güle güle', 'bb'].includes(trimmed)) return { command: 'çıkış', args: '' };
  if (['merhaba', 'selam', 'hey', 'hello', 'hi'].includes(trimmed)) return { command: 'selam', args: '' };
  if (['ne yapabilirsin', 'yardım', 'help', 'komutlar'].includes(trimmed)) return { command: 'yardım', args: '' };
  if (['optimize', 'temizle', 'hafızayı optimize et'].includes(trimmed)) return { command: 'optimize', args: '' };
  if (['birleştir', 'konsolide et', 'toparla', 'consolidate'].includes(trimmed)) return { command: 'konsolide', args: '' };
  if (['evolve', 'evrim', 'geliş', 'kendini geliştir', 'kendilik'].includes(trimmed)) return { command: 'evolve', args: '' };

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
};
