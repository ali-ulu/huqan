const fs = require('fs');
const path = require('path');
const readline = require('readline');
const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');
const Dream = require('./dream');
const LLMAdapter = require('./llmAdapter');
const { createAgent } = require('./agentRuntime');
const { createBackup, restoreBackup } = require('./backupRestore');
const { resolvePersistencePaths } = require('./persistencePaths');
const { evaluateMcpGate } = require('./lib/mcp-gate-adapter');

/**
 * @param {object} [opts]
 * @param {'v2'} [opts.version]
 * @returns {Kernel|KernelV2}
 */
function createKernel(opts = {}) {
  const { version, ...kernelOpts } = opts || {};
  const selected = version || process.env.AXIOM_KERNEL_VERSION;
  return selected === 'v2' ? new KernelV2(kernelOpts) : new Kernel(kernelOpts);
}

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
    .replace(/\uFEFF/g, '')
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

function isWorkflowRuntime(agent) {
  return Boolean(agent && (agent.kind === 'workflow' || agent.runtime === 'workflow'));
}

function unwrapAgentPayload(result) {
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'data')) {
    return result.data;
  }
  return result;
}

function mapCliCommandToMcpTool(command) {
  const normalized = normalizeCommandText(command);
  switch (normalized) {
    case 'ogret':
    case 'ogren':
    case 'yukle':
    case 'company-ingest':
    case 'company ingest':
      return 'axiom.learn';
    case 'ajan':
    case 'plan':
      return 'axiom.agent';
    case 'sor':
      return 'axiom.ask';
    case 'verify':
      return 'axiom.verify';
    case 'neden':
      return 'axiom.reason';
    case 'karsilastir':
      return 'axiom.compare';
    default:
      return null;
  }
}

// F-004: CLI mutation/maintenance commands that have no axiom.* MCP tool
// mapping but still affect persistence, canonical graph, or background
// automation. Every command here is REST-blocked via requestGuards
// UNSAFE_PUBLIC_API_COMMANDS; the CLI must likewise never silently bypass the
// gate. _evaluateCliGate consults this table (instead of returning null) so a
// gate decision + audit event is always produced for these commands.
//   - decision 'allow'  → local recovery/persistence ops that must still run
//                         (test-covered) but are audited (no silent mutation).
//   - decision 'review' → canonical-graph / automation mutations: gated like
//                         axiom.learn so execute() short-circuits (no write).
//   - mutationType 'none' → read-only/control aliases that are merely
//                           classified (not audited, not blocked).
const CLI_MUTATION_GATE = Object.freeze({
  kaydet:    { decision: 'allow',  reason: 'cli_persist_local',                 mutationType: 'persistence',   auditEvent: 'UPDATE' },
  backup:    { decision: 'allow',  reason: 'cli_backup_export_local',           mutationType: 'export',        auditEvent: 'EXPORTED' },
  restore:   { decision: 'allow',  reason: 'cli_restore_state_replace_local',   mutationType: 'state_replace', auditEvent: 'IMPORTED' },
  evolve:    { decision: 'review', reason: 'cli_canonical_mutation_requires_review', mutationType: 'canonical',  auditEvent: 'REVIEW' },
  optimize:  { decision: 'review', reason: 'cli_canonical_mutation_requires_review', mutationType: 'canonical',  auditEvent: 'REVIEW' },
  konsolide: { decision: 'review', reason: 'cli_canonical_mutation_requires_review', mutationType: 'canonical',  auditEvent: 'REVIEW' },
  dusun:     { decision: 'review', reason: 'cli_automation_requires_review',     mutationType: 'automation',    auditEvent: 'REVIEW' },
  ruya:      { decision: 'allow',  reason: 'cli_read_only_inference',            mutationType: 'none' },
});

class CLI {
  /**
   * @param {object} [opts]
   * @param {Kernel|KernelV2} [opts.kernelInstance]
   * @param {object} [opts.kernel]
   * @param {'v2'|'v3'} [opts.agentVersion]
   */
  constructor(opts = {}) {
    this.kernel = opts.kernelInstance || createKernel(opts.kernel || {});
    this.dream = new Dream(this.kernel);
    this.agent = createAgent({
      kernel: this.kernel,
      dream: this.dream,
      version: opts.agentVersion || process.env.AXIOM_AGENT_VERSION,
    });
    this.llm = new LLMAdapter();
  }

  parse(input) {
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
    if (trimmed.startsWith('learn:')) return { command: '\u00f6\u011fret', args: raw.slice(6).trim() };
    if (trimmed.startsWith('teach:')) return { command: '\u00f6\u011fret', args: raw.slice(6).trim() };
    if (trimmed.startsWith('ask:')) return { command: 'sor', args: raw.slice(4).trim() };
    if (trimmed.startsWith('why:')) return { command: 'neden', args: raw.slice(4).trim() };
    if (trimmed.startsWith('compare:')) return { command: 'kar\u015f\u0131la\u015ft\u0131r', args: normalizeCompareArgs(raw.slice(8).trim()) };
    if (trimmed.startsWith('verify:')) return { command: 'verify', args: raw.slice(7).trim() };
    if (trimmed.startsWith('dogrula:')) return { command: 'verify', args: raw.slice(8).trim() };
    if (trimmed.startsWith('upload:')) return { command: 'y\u00fckle', args: raw.slice(7).trim() };

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
    if (trimmed.startsWith('yükle:')) return { command: 'yükle', args: raw.slice(6).trim() };
    if (trimmed.startsWith('restore:')) return { command: 'restore', args: raw.slice(8).trim() };
    if (trimmed.startsWith('sor:')) return { command: 'sor', args: raw.slice(4).trim() };

    if (['cikis', 'exit', 'quit'].includes(plain)) return { command: 'exit', args: '' };

    if (['durum', 'durum nedir', 'ne durumdasın', 'nasılsın', 'durum raporu'].includes(trimmed)) return { command: 'durum', args: '' };
    if (['rüya', 'rüya gör', 'hayal kur', 'ne düşünüyorsun'].includes(trimmed)) return { command: 'rüya', args: '' };
    if (['kaydet', 'hafızayı kaydet'].includes(trimmed)) return { command: 'kaydet', args: '' };
    if (['backup', 'yedek', 'yedekle'].includes(trimmed)) return { command: 'backup', args: '' };
    if (['restore', 'geri yükle', 'geri yukle'].includes(trimmed)) return { command: 'restore', args: '' };
    if (['açık düşün', 'sürekli düşün', 'otomatik düşün', 'auto think', 'düşünmeye başla'].includes(trimmed)) return { command: 'düşün', args: 'başla' };
    if (['dur düşünme', 'düşünmeyi durdur', 'sus', 'sakin ol'].includes(trimmed)) return { command: 'düşün', args: 'dur' };
    if (['çıkış', 'kapat', 'güle güle', 'bb'].includes(trimmed)) return { command: 'çıkış', args: '' };
    if (['merhaba', 'selam', 'hey'].includes(trimmed)) return { command: 'selam', args: '' };
    if (['ne yapabilirsin', 'yardım', 'help', 'komutlar'].includes(trimmed)) return { command: 'yardım', args: '' };
    if (['optimize', 'temizle', 'hafızayı optimize et'].includes(trimmed)) return { command: 'optimize', args: '' };
    if (['birleştir', 'konsolide et', 'toparla'].includes(trimmed)) return { command: 'konsolide', args: '' };
    if (['evolve', 'evrim', 'geliş', 'kendini geliştir', 'kendilik'].includes(trimmed)) return { command: 'evolve', args: '' };

    const nedenMatch = trimmed.match(/^neden\s+(.+)/i);
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

    if (trimmed.split(/\s+/).filter(Boolean).length >= 2) return { command: 'öğret', args: trimmed };
    return { command: 'anlamadım', args: '' };
  }

  _backupOptions(extra = {}) {
    const descriptor = this.kernel.getPersistenceDescriptor();
    const resolved = resolvePersistencePaths({
      rootDir: process.cwd(),
      ...descriptor,
      ...extra,
    });
    return { ...resolved, ...extra };
  }

  _ensureCompanyCapabilities() {
    if (typeof this.kernel.hasCapability === 'function' && !this.kernel.hasCapability('companyMode')) {
      this.kernel.enableCapability('companyMode');
    }
    if (typeof this.kernel.hasCapability === 'function' && !this.kernel.hasCapability('pluginCapabilities')) {
      this.kernel.enableCapability('pluginCapabilities');
    }
    if (this.kernel.plugins && typeof this.kernel.plugins.load === 'function') {
      this.kernel.plugins.load(path.join(__dirname, 'plugins'));
    }
  }


  _ensureProductCapabilities() {
    if (typeof this.kernel.hasCapability === 'function' && !this.kernel.hasCapability('pluginCapabilities')) {
      this.kernel.enableCapability('pluginCapabilities');
    }
    if (typeof this.kernel.hasCapability === 'function' && !this.kernel.hasCapability('companyMode')) {
      this.kernel.enableCapability('companyMode');
    }
    if (typeof this.kernel.hasCapability === 'function' && !this.kernel.hasCapability('temporal')) {
      this.kernel.enableCapability('temporal');
    }
    if (typeof this.kernel.hasCapability === 'function' && !this.kernel.hasCapability('evidenceRanking')) {
      this.kernel.enableCapability('evidenceRanking');
    }
    if (this.kernel.plugins && typeof this.kernel.plugins.load === 'function') {
      this.kernel.plugins.load(path.join(__dirname, 'plugins'));
    }
  }
  execute(command, args) {
    const gateResult = this._evaluateCliGate(command, args);
    if (gateResult && !gateResult.canExecute) {
      return this._formatCliGateMessage(command, gateResult);
    }
    switch (command) {
      case 'öğret': {
        this.kernel.learn(args);
        const subject = String(args || '').toLowerCase().split(/\s+/)[0];
        return `OK "${subject}" öğrendim.`;
      }
      case 'verify': {
        const result = this.kernel.verify(args);
        const data = result.data || {};
        const evidence = Array.isArray(result.evidence) ? result.evidence : [];
        let out = `Verify: ${data.status || 'unknown'} (confidence: ${typeof data.confidence === 'number' ? data.confidence.toFixed(2) : 'n/a'})`;
        if (evidence.length > 0 && evidence[0] && evidence[0].text) out += `\nEvidence: ${evidence[0].text}`;
        return out;
      }
      case 'sor': {
        const result = this.kernel.ask(args);
        const answer = result.data.answer;
        return answer === 'Bilmiyorum' ? `X ${answer}` : `Cevap: ${answer}`;
      }
      case 'neden': {
        const result = this.kernel.reason(args);
        const answer = result.data.answer;
        return answer === 'Bilmiyorum' ? `X ${answer}` : `Neden: ${answer}`;
      }
      case 'karşılaştır': {
        const [left, right] = String(args || '').split('|');
        const result = this.kernel.compare(left.trim(), right.trim());
        const answer = result.data.answer;
        return answer === 'Bilmiyorum' ? `X ${answer}` : `Karsilastirma: ${answer}`;
      }
      case 'mri': {
        this._ensureProductCapabilities();
        const run = this.kernel.runCapability('ideaMri', { text: String(args || '').trim() });
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) return `MRI hatasi: ${result?.error || 'bilinmeyen hata'}`;
          const data = result.data || {};
          const claim = data.mainClaim || String(args || '').trim();
          const risks = Array.isArray(data.risks)
            ? data.risks.slice(0, 2).map(item => item?.text).filter(Boolean).join(' | ')
            : '';
          const gaps = Array.isArray(data.missingEvidence)
            ? data.missingEvidence.slice(0, 2).map(item => item?.text).filter(Boolean).join(' | ')
            : '';
          return `MRI: ${claim}\nRiskler: ${risks || 'yok'}\nEksik kanit: ${gaps || 'yok'}`;
        });
      }
      case 'tartis': {
        this._ensureProductCapabilities();
        const run = this.kernel.runCapability('devilAdvocate', { text: String(args || '').trim() });
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) return `Tartisma hatasi: ${result?.error || 'bilinmeyen hata'}`;
          const data = result.data || {};
          return `Seytanin Avukati (${data.mode || 'unknown'}): ${data.counterArgument || 'cikti yok'}`;
        });
      }
      case 'celiski': {
        this._ensureProductCapabilities();
        const run = this.kernel.runCapability('contradictionAlert', { text: String(args || '').trim() });
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) return `Celiski hatasi: ${result?.error || 'bilinmeyen hata'}`;
          const data = result.data || {};
          const count = Array.isArray(data.conflictingThoughts) ? data.conflictingThoughts.length : 0;
          return `Celiski Analizi: ${count} bulgu${data.conflictType ? ` (${data.conflictType})` : ''}`;
        });
      }

      case 'llm-sor': {
        const axiomResult = this.kernel.ask(args);
        const verifyResult = this.kernel.verify(args);
        const verify = verifyResult.data;
        let out = `AXIOM dogrulamasi: ${verify.status} (guven: ${verify.confidence.toFixed(2)})`;
        if (axiomResult.data.answer !== 'Bilmiyorum') out += `\nAXIOM: ${axiomResult.data.answer}`;
        if (verifyResult.evidence.length > 0) out += `\nKanit: ${verifyResult.evidence[0].text}`;
        if (verify.risk && verify.risk.manipulation) {
          const labels = Array.isArray(verify.risk.labels) && verify.risk.labels.length > 0 ? verify.risk.labels.join(', ') : 'manipulation';
          out += `\nRisk: ${labels} (skor: ${verify.risk.score.toFixed(2)})`;
        }
        out += `\nLLM yaniti icin: ollama run ${this.llm.model} "${args}"`;
        return out;
      }
      case 'plan': {
        const result = this.agent.plan(args);
        const plan = unwrapAgentPayload(result);
        const steps = (plan.steps || []).map((step, index) => `  ${index + 1}. ${step.action} -> ${step.tool} | ${step.rationale}`).join('\n');
        const nextAction = plan.nextAction ? `${plan.nextAction.action} -> ${plan.nextAction.tool}` : 'yok';
        const recommendations = Array.isArray(plan.recommendations?.items) ? plan.recommendations.items : [];
        const runtimeLine = isWorkflowRuntime(this.agent) ? 'Runtime: workflow' : 'Runtime: legacy';
        return [
          `Ajan planı: ${plan.objective} (${plan.status})`,
          `Hedef: ${plan.goal}`,
          runtimeLine,
          `Seçilen araçlar: ${(plan.selectedTools || []).join(', ') || 'yok'}`,
          `Sonraki adım: ${nextAction}`,
          `Öneriler: ${recommendations.length > 0 ? recommendations.join(' | ') : 'yok'}`,
          `Adımlar:\n${steps || '  -'}`,
          `Güven: ${plan.confidence.toFixed(2)}`,
        ].join('\n');
      }
      case 'ajan': {
        const result = this.agent.run(args);
        const data = unwrapAgentPayload(result);
        const agentStatus = typeof this.agent.getStatus === 'function' ? this.agent.getStatus() : null;
        const lastPlan = agentStatus?.lastPlan || null;
        const lastRun = agentStatus?.lastRun || null;
        const steps = (data.steps || []).map((step, index) => {
          const status = step.result?.ok === false ? 'hata' : 'tamam';
          return `  ${index + 1}. ${step.action} -> ${status}${step.summary ? ` | ${step.summary}` : ''}`;
        }).join('\n');
        const nextAction = data.nextAction ? `${data.nextAction.action} -> ${data.nextAction.tool}` : 'yok';
        const recommendations = Array.isArray(data.recommendations?.items) ? data.recommendations.items : [];
        const runtimeLine = isWorkflowRuntime(this.agent) ? 'Runtime: workflow' : 'Runtime: legacy';
        return [
          `Ajan durumu: ${data.status}`,
          `Hedef: ${data.goal}`,
          `Amaç: ${data.objective}`,
          runtimeLine,
          data.checkpointId ? `Checkpoint: ${data.checkpointId}${data.resumed ? ' (resume)' : ''}` : 'Checkpoint: yok',
          typeof data.budgetRemaining === 'number' ? `Kalan bütçe: ${data.budgetRemaining}` : 'Kalan bütçe: bilinmiyor',
          lastPlan ? `Son plan: ${lastPlan.goal} (${lastPlan.steps} adım)` : 'Son plan: yok',
          lastRun ? `Son çalışma: ${lastRun.status} · ${lastRun.goal}` : 'Son çalışma: yok',
          `Araçlar: ${(data.selectedTools || []).join(', ') || 'yok'}`,
          `Sonraki adım: ${nextAction}`,
          `Öneriler: ${recommendations.length > 0 ? recommendations.join(' | ') : 'yok'}`,
          `Adımlar:\n${steps || '  -'}`,
          `Sonuç: ${data.finalAnswer}`,
        ].join('\n');
      }
      case 'yükle': {
        try {
          const text = fs.readFileSync(args, 'utf8');
          const count = this.kernel.learnDocument(text);
          return `"${args}" dosyasından ${count} bilgi öğrenildi.`;
        } catch (error) {
          return `Dosya okunamadı: ${error.message}`;
        }
      }
      case 'company-ingest': {
        const payload = args && typeof args === 'object' ? args : {};
        const source = String(payload.source || '').toLowerCase();
        this._ensureCompanyCapabilities();

        if (source === 'manuel' || source === 'manual') {
          const run = this.kernel.runCapability('companyBrain', {
            action: 'manual',
            sourceType: 'manual',
            text: payload.text,
            author: payload.author,
            date: payload.date,
          });
          return Promise.resolve(run).then(result => `Manual ingest: ${result.ok ? 'ok' : 'hata'} (${result.added || 0})`);
        }

        if (source === 'karar' || source === 'decision') {
          const run = this.kernel.runCapability('companyBrain', {
            action: 'decision',
            sourceType: 'decision',
            title: payload.title,
            rationale: payload.rationale,
            decidedBy: payload.author,
            date: payload.date,
          });
          return Promise.resolve(run).then(result => `Decision ingest: ${result.ok ? 'ok' : 'hata'} (${result.decisionId || '-'})`);
        }

        if (source === 'github' || source === 'repo') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'github',
            repoUrl: payload.repoUrl,
          });
          return Promise.resolve(run).then(result => `Repo ingest: ${result.ok ? 'ok' : 'hata'} (files=${result.files || 0}, added=${result.added || 0})`);
        }

        if (source === 'markdown' || source === 'md') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'markdown',
            path: payload.targetPath,
          });
          return Promise.resolve(run).then(result => `Markdown ingest: ${result.ok ? 'ok' : 'hata'} (files=${result.files || 0}, added=${result.added || 0})`);
        }

        return 'Desteklenmeyen kaynak. Kullanim: ogren --kaynak manuel|karar|github|markdown ...';
      }
      case 'company-query': {
        this._ensureCompanyCapabilities();
        const run = this.kernel.runCapability('companyBrain', {
          action: 'query',
          question: String(args || '').trim(),
        });
        return Promise.resolve(run).then(result => {
          if (!result.ok) return `Sorgu hatasi: ${result.error || 'bilinmeyen hata'}`;
          return `Company Brain: ${result.answer}\nKaynak: ${result.source}\nRefs: ${(result.sourceRefs || []).join(', ') || 'yok'}`;
        });
      }
      case 'ingest-status': {
        this._ensureCompanyCapabilities();
        const run = this.kernel.runCapability('ingestStatus', {});
        return Promise.resolve(run).then(result => {
          if (!result.ok) return `Ingest durum hatasi: ${result.error || 'bilinmeyen hata'}`;
          const dist = result.distribution || {};
          return `Ingest durum -> node:${result.totalNodes} repo:${dist.repo || 0} markdown:${dist.markdown || 0} manual:${dist.manual || 0}`;
        });
      }
      case 'backup': {
        const result = createBackup(this._backupOptions());
        return `Backup tamamlandi: ${result.backupDir} (${result.copied.length} dosya)`;
      }
      case 'restore': {
        const result = restoreBackup(this._backupOptions({ backupDir: args || undefined }));
        this.kernel.reload();
        return `Restore tamamlandi: ${result.restored.length} dosya geri yüklendi. Guvenlik yedegi: ${result.safetyBackupDir}`;
      }
      case 'düşün': {
        if (args === 'dur') {
          this.kernel.stopAutoThink();
          return 'Dusunmeyi durdurdum.';
        }
        this.kernel.startAutoThink(15000);
        return 'Arka planda dusunmeye basladim.';
      }
      case 'optimize': {
        const result = this.kernel.optimize();
        return `Optimize: ${result.pruned} kenar budandi, ${result.removedNodes} dugum silindi.`;
      }
      case 'konsolide': {
        const dryRun = this.kernel.consolidate(true);
        if (dryRun.removed === 0) return 'Temizlenecek celiskili kenar bulunamadi.';
        const result = this.kernel.consolidate(false);
        return `${result.removed} celiskili kenar temizlendi.`;
      }
      case 'evolve': {
        const result = this.kernel.selfEvolve();
        let text = `Kendilik dongusu tamam: ${result.dreams} hipotez incelendi`;
        if (result.added > 0) text += `, ${result.added} yeni bilgi eklendi`;
        text += `, ${result.consolidated} celiski temizlendi, ${result.optimized} kenar budandi.`;
        return text;
      }
      case 'durum': {
        const nodes = Object.keys(this.kernel.graph._nodes).length;
        const edges = this.kernel.graph._edges.length;
        const entropy = this.kernel.entropy();
        const gaps = this.kernel.detectGaps();
        const contradictions = this.kernel.detectContradictions();
        let out = `Durum: ${nodes} düğüm, ${edges} kenar, entropi: ${entropy.toFixed(3)}`;
        if (isWorkflowRuntime(this.agent)) out += `\n  Agent runtime: workflow`;
        if (gaps.length > 0) out += `\n  ${gaps.length} baglantisiz dugum: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''}`;
        for (const item of contradictions.slice(0, 5)) {
          out += `\n  Celiski [${item.type}]: ${item.node} -> ${item.targets.join(', ')}`;
        }
        return out;
      }
      case 'rüya': {
        const hypotheses = this.dream.dream();
        if (hypotheses.length === 0) return 'Hipotez uretemedim, daha fazla bilgiye ihtiyacim var.';
        const lines = hypotheses.map(item => `  ${item.from} -> ${item.to} (${item.type}, guven: ${item.confidence.toFixed(2)})`);
        return `${hypotheses.length} hipotez:\n${lines.join('\n')}`;
      }
      case 'selam':
        return 'Merhaba! Bana bir sey ogretebilir veya soru sorabilirsin.';
      case 'yardım':
        return [
          'AXIOM komutlari:',
          '  "kedi balik yer"          -> bilgi ogrenirim',
          '  "kedi nedir"              -> soruyu cevaplarim',
          '  "neden tavuk"             -> sebep analizi',
          '  "tavuk mu yumurta mi"     -> karsilastirma',
          '  "durum"                   -> sistem durumu',
          '  "ruya"                    -> hipotez uretirim',
          '  "plan: hedef"             -> ajan plani uretirim',
          '  "ajan: hedef"             -> cok adimli ajan calistiririm',
          '  "backup"                  -> calisma durumunu yedeklerim',
          '  "restore[: yol]"          -> en son veya secili yedekten geri yuklerim',
          '  "kaydet"                  -> hafizayi kaydederim',
          '  "llm-sor: soru"           -> LLM tavsiyesi hazirlarim',
          '  "yükle: dosya.txt"        -> dosyadan ogrenirim',
          '  English-first aliases:',
          '  "learn: cats are animals" -> teach alias',
          '  "ask: cat nedir"          -> ask alias',
          '  "why: tavuk"              -> why alias',
          '  "compare: tavuk | yumurta"-> compare alias',
          '  "verify: kedi bitkidir"   -> guarded verify alias',
          '  "upload: notes.txt"       -> upload alias',
          '  Turkish compatibility aliases: \u00f6\u011fret, sor, neden, kar\u015f\u0131la\u015ft\u0131r, do\u011frula, y\u00fckle',
          '  "çıkış"                   -> cikis',
        ].join('\n');
      case 'anlamadım':
        return 'Anlamadim. Daha uzun bir cumle yaz veya "yardım" yaz.';
      default:
        return 'Bilinmeyen komut.';
    }
  }

  start() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'axiom> ',
    });

    console.log('AXIOM - dogal dil ile konus, ogret, sor');
    console.log('  "kedi balik yer"       | Bilgi ogret');
    console.log('  "kedi nedir"           | Soru sor');
    console.log('  "learn: cats are animals" | English-first teach alias');
    console.log('  "ask: cat nedir"          | English-first ask alias');
    console.log('  "verify: kedi bitkidir"   | English-first verify alias');
    console.log('  "plan: hedef"          | Ajan plani');
    console.log('  "ajan: hedef"          | Ajan calistir');
    console.log('  "backup"               | Durumu yedekle');
    console.log('  "restore[: yol]"       | Yedekten don');
    console.log('  "yardım"               | Komutlar');
    console.log('  "çıkış"                | Cikis\n');

    rl.prompt();
    rl.on('line', async (line) => {
      const parsed = this.parse(line);
      if (parsed.command === 'kaydet') {
        this._auditCliMutation('kaydet', CLI_MUTATION_GATE.kaydet, 'allow', true);
        this.kernel.persist();
        console.log('Hafiza kaydedildi.');
      } else if (parsed.command === 'çıkış' || parsed.command === 'exit') {
        const rawCommand = String(line || '').trim().toLowerCase();
        const sourceCommand = rawCommand === 'exit' || rawCommand === 'quit' ? 'exit' : 'cikis';
        this._auditCliMutation(sourceCommand, CLI_MUTATION_GATE.kaydet, 'allow', true);
        this.kernel.persist();
        console.log('Hafiza kaydedildi. Gule gule.');
        rl.close();
        return;
      } else if (parsed.command === 'llm-sor') {
        console.log(this.execute('llm-sor', parsed.args));
      } else {
        const output = await Promise.resolve(this.execute(parsed.command, parsed.args));
        console.log(output);
      }
      rl.prompt();
    });
    rl.on('close', () => process.exit(0));
  }

  _evaluateCliGate(command, args) {
    const tool = mapCliCommandToMcpTool(command);
    if (!tool) {
      // F-004: commands without an MCP tool mapping may still mutate. Route
      // them through the CLI mutation gate so they are never silently
      // bypassed. Genuinely read-only commands (durum, sor, selam, yardım…)
      // are absent from CLI_MUTATION_GATE and return null (no gate runs).
      return this._evaluateCliMutationGate(command, args);
    }

    const metadata = {
      source: 'cli',
      actor: 'cli-user',
      runner: 'cli',
      sourceTrust: 'local',
    };

    let gateArgs = {};
    switch (tool) {
      case 'axiom.learn':
        gateArgs = { text: typeof args === 'string' ? args : JSON.stringify(args || {}) };
        break;
      case 'axiom.agent':
        gateArgs = { goal: typeof args === 'string' ? args : JSON.stringify(args || {}) };
        break;
      case 'axiom.ask':
        gateArgs = { question: String(args || '') };
        break;
      case 'axiom.verify':
        gateArgs = { statement: String(args || '') };
        break;
      case 'axiom.reason':
        gateArgs = { subject: String(args || '') };
        break;
      case 'axiom.compare': {
        const [left = '', right = ''] = String(args || '').split('|');
        gateArgs = { left: left.trim(), right: right.trim() };
        break;
      }
      default:
        gateArgs = {};
    }

    return evaluateMcpGate({ tool, args: gateArgs, metadata });
  }

  _formatCliGateMessage(command, gate) {
    const decision = gate?.decision || 'block';
    const reason = gate?.reason || 'gate_blocked';
    const commandLabel = String(command || '');
    if (decision === 'dry_run_only') {
      return `Gate: ${commandLabel} dry-run-only. Calisma baslatilmadi. Karar: ${decision}. Sebep: ${reason}.`;
    }
    if (decision === 'review') {
      return `Gate: ${commandLabel} review gerektiriyor. Sessiz mutation/calistirma yapilmadi. Karar: ${decision}. Sebep: ${reason}.`;
    }
    return `Gate: ${commandLabel} engellendi. Karar: ${decision}. Sebep: ${reason}.`;
  }

  // F-004: synthetic gate decision for CLI mutation/maintenance commands that
  // have no axiom.* MCP tool. Returns null for unknown/read-only commands so
  // they proceed ungated. Every real mutation attempt is audited (allow OR
  // review) so nothing mutates silently.
  _evaluateCliMutationGate(command, args) {
    const normalized = normalizeCommandText(command);
    let classification = CLI_MUTATION_GATE[normalized];
    // 'düşün dur' stops the auto-think loop — a control action, not a mutation.
    if (normalized === 'dusun' && String(args || '').trim() === 'dur') {
      classification = { decision: 'allow', reason: 'cli_automation_stop', mutationType: 'none' };
    }
    if (!classification) return null;

    const decision = classification.decision;
    const canExecute = decision === 'allow';
    if (classification.mutationType !== 'none') {
      this._auditCliMutation(normalized, classification, decision, canExecute);
    }
    return {
      ok: true,
      allowed: canExecute,
      canExecute,
      canDryRun: decision === 'review',
      decision,
      reason: classification.reason,
      requiredReview: decision === 'review',
      dryRunOnly: false,
      findings: [{ gate: 'CLI', command: normalized, mutationType: classification.mutationType, decision }],
      warnings: [],
      metadata: { source: 'cli', command: normalized, mutationType: classification.mutationType },
    };
  }

  _auditCliMutation(command, classification, decision, executed) {
    try {
      if (!this.kernel || typeof this.kernel.recordCliMutationAudit !== 'function') return;
      this.kernel.recordCliMutationAudit({
        sourceCommand: command,
        mutationType: classification.mutationType,
        eventType: classification.auditEvent || (decision === 'allow' ? 'UPDATE' : 'REVIEW'),
        decision,
        executionEligible: executed,
        reason: classification.reason,
        actor: 'cli-user',
      });
    } catch (_) {
      // Audit must never break command execution.
    }
  }
}

if (require.main === module) {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    const cli = new CLI({ kernel: { noLoad: true, loadPlugins: false } });
    console.log(cli.execute('yardım', ''));
    process.exit(0);
  }

  const cli = new CLI();
  cli.kernel.reload();
  cli.start();
}

module.exports = CLI;
module.exports.createKernel = createKernel;
