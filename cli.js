#!/usr/bin/env node

const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./lib/environment-compat');
validateEnvironmentCompatibility();
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { isPathWithinRoot } = require('./lib/path-safety');
const { createKernel } = require('./lib/kernel-factory');
const { cliHelpText } = require('./lib/cli-help');
const { runCliHypotheses } = require('./lib/cli-hypotheses');
const { runCliArgv: runWorkflowCliArgv } = require('./lib/cli-workflow-adapter');
const { runQuickstartCommand } = require('./lib/quickstart-cli');
const {
  parseCommand,
  normalizeCommandText,
  parseApprovalDecisionArgs,
} = require('./lib/command-parser');
const Dream = require('./dream');
const LLMAdapter = require('./llmAdapter');
const { createAgent } = require('./agentRuntime');
const { createBackup, runCliRestore, formatCliRestore } = require('./backupRestore');
const { resolvePersistencePaths } = require('./persistencePaths');
const { evaluateMcpGate } = require('./lib/mcp-gate-adapter');
const {
  CLI_MUTATION_GATE,
  auditCliMutation,
  commitCliMutation,
  evaluateCliMutationGate,
} = require('./lib/cli-mutation-gate');
const {
  callTool: callMcpTool,
  createApprovalStoreFromKernel,
} = require('./mcpServer');
const { formatCliApprovalList, formatCliApprovalDecision } = require('./lib/mcp-approval-views');

const {
  shellQuote,
  getCliReadRoots,
  resolveCliReadPath,
  isWorkflowRuntime,
  unwrapAgentPayload,
  formatAgentRunResult,
  mapCliCommandToMcpTool,
  commandFailure,
} = require('./lib/cli-helpers');

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
      version: opts.agentVersion || readCompatibleEnvironmentVariable('AGENT_VERSION'),
    });
    this.llm = new LLMAdapter();
    this.approvalStore = null;
    this._mcpOperatorToken = opts.mcpOperatorToken || crypto.randomBytes(32).toString('hex');
    this._approvalRuntimeOptions = Object.freeze({
      ...(Object.hasOwn(opts, 'trustEvidenceLedger') ? { trustEvidenceLedger: opts.trustEvidenceLedger } : {}),
      ...(Object.hasOwn(opts, 'humanOversightApprovalRuntime')
        ? { humanOversightApprovalRuntime: opts.humanOversightApprovalRuntime }
        : {}),
      ...(Object.hasOwn(opts, 'agentIdentityRuntime')
        ? { agentIdentityRuntime: opts.agentIdentityRuntime }
        : {}),
      ...(Object.hasOwn(opts, 'humanOversightRequesterContext')
        ? { humanOversightRequesterContext: opts.humanOversightRequesterContext }
        : {}),
      ...(Object.hasOwn(opts, 'humanOversightApproverContext')
        ? { humanOversightApproverContext: opts.humanOversightApproverContext }
        : {}),
      ...(Object.hasOwn(opts, 'humanOversightContextResolver')
        ? { humanOversightContextResolver: opts.humanOversightContextResolver }
        : {}),
    });
  }

  parse(input) {
    return parseCommand(input, this.kernel);
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

  _approvalRuntime() {
    if (!this.approvalStore) this.approvalStore = createApprovalStoreFromKernel(this.kernel);
    return {
      approvalStore: this.approvalStore,
      operatorToken: this._mcpOperatorToken,
      ...this._approvalRuntimeOptions,
    };
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
  execute(command, args, opts = {}) {
    const gateResult = Object.prototype.hasOwnProperty.call(opts, 'gateResult')
      ? opts.gateResult
      : this._evaluateCliGate(command, args);
    if (gateResult && !gateResult.canExecute) {
      return this._formatCliGateMessage(command, gateResult);
    }
    switch (command) {
      case 'öğret': {
        this.kernel.learn(args, { sourceType: 'cli', sourceRef: 'cli:öğret', actor: 'cli-user' });
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
        // Defaults, the way _evaluateCliGate()'s 'huqan.compare' branch already
        // writes it. normalizeCompareArgs() returns the text unchanged when it
        // finds neither '|' nor ' vs ', so a single-term `compare: elma` reached
        // `right.trim()` on undefined and threw a raw stack trace at the user
        // (#1029).
        const [left = '', right = ''] = String(args || '').split('|');
        if (!left.trim() || !right.trim()) {
          return commandFailure('Kullanim: compare: <a>|<b>', opts);
        }
        const result = this.kernel.compare(left.trim(), right.trim());
        const answer = result.data.answer;
        return answer === 'Bilmiyorum' ? `X ${answer}` : `Karsilastirma: ${answer}`;
      }
      case 'mri': {
        this._ensureProductCapabilities();
        const run = this.kernel.runCapability('ideaMri', { text: String(args || '').trim() });
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) {
            return commandFailure(`MRI error: ${result?.error || 'unknown error'}`, opts);
          }
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
          if (!result || result.ok === false) {
            return commandFailure(`Debate error: ${result?.error || 'unknown error'}`, opts);
          }
          const data = result.data || {};
          return `Devil's advocate (${data.mode || 'unknown'}): ${data.counterArgument || 'no output'}`;
        });
      }
      case 'celiski': {
        this._ensureProductCapabilities();
        const run = this.kernel.runCapability('contradictionAlert', { text: String(args || '').trim() });
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) {
            return commandFailure(`Contradiction error: ${result?.error || 'unknown error'}`, opts);
          }
          const data = result.data || {};
          const count = Array.isArray(data.conflictingThoughts) ? data.conflictingThoughts.length : 0;
          return `Contradiction analysis: ${count} finding(s)${data.conflictType ? ` (${data.conflictType})` : ''}`;
        });
      }

      case 'llm-sor': {
        const axiomResult = this.kernel.ask(args);
        const verifyResult = this.kernel.verify(args);
        const verify = verifyResult.data || {};
        // The verify branch above guards these with `typeof === 'number'`; this
        // one did not, so a non-numeric confidence or risk score crashed the
        // same way (#1029).
        const confidenceText = typeof verify.confidence === 'number' ? verify.confidence.toFixed(2) : 'n/a';
        let out = `AXIOM dogrulamasi: ${verify.status || 'unknown'} (guven: ${confidenceText})`;
        if (axiomResult.data.answer !== 'Bilmiyorum') out += `\nAXIOM: ${axiomResult.data.answer}`;
        const evidence = Array.isArray(verifyResult.evidence) ? verifyResult.evidence : [];
        if (evidence.length > 0 && evidence[0] && evidence[0].text) out += `\nKanit: ${evidence[0].text}`;
        if (verify.risk && verify.risk.manipulation) {
          const labels = Array.isArray(verify.risk.labels) && verify.risk.labels.length > 0 ? verify.risk.labels.join(', ') : 'manipulation';
          const scoreText = typeof verify.risk.score === 'number' ? verify.risk.score.toFixed(2) : 'n/a';
          out += `\nRisk: ${labels} (skor: ${scoreText})`;
        }
        out += `\nLLM yaniti icin: ollama run ${shellQuote(this.llm.model)} ${shellQuote(args)}`;
        return out;
      }
      case 'plan': {
        const result = this.agent.plan(args);
        const plan = unwrapAgentPayload(result);
        if (opts.json) return result;
        const steps = (plan.steps || []).map((step, index) => `  ${index + 1}. ${step.action} -> ${step.tool} | ${step.rationale}`).join('\n');
        const nextAction = plan.nextAction ? `${plan.nextAction.action} -> ${plan.nextAction.tool}` : 'none';
        const recommendations = Array.isArray(plan.recommendations?.items) ? plan.recommendations.items : [];
        const runtimeLine = isWorkflowRuntime(this.agent) ? 'Runtime: workflow' : 'Runtime: legacy';
        return [
          `Ajan planı: ${plan.objective} (${plan.status})`,
          `Hedef: ${plan.goal}`,
          runtimeLine,
          `Seçilen araçlar: ${(plan.selectedTools || []).join(', ') || 'yok'}`,
          `Next step: ${nextAction}`,
          `Recommendations: ${recommendations.length > 0 ? recommendations.join(' | ') : 'none'}`,
    `Steps:\n${steps || '  -'}`,
          `Güven: ${plan.confidence.toFixed(2)}`,
        ].join('\n');
      }
      case 'ajan': {
        const result = this.agent.run(args);
        if (opts.json) return result;
        return result && typeof result.then === 'function'
          ? result.then(resolved => formatAgentRunResult(this.agent, resolved))
          : formatAgentRunResult(this.agent, result);
      }
      case 'yükle': {
        try {
          const filePath = resolveCliReadPath(args);
          const text = fs.readFileSync(filePath, 'utf8');
          const count = this.kernel.learnDocument(text, {
            sourceType: 'cli',
            sourceRef: `cli:yükle:${args}`,
            actor: 'cli-user',
          });
          return `Learned ${count} fact(s) from "${args}".`;
        } catch (error) {
          return commandFailure(`Could not read file: ${error.message}`, opts);
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
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`Manual ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Manual ingest: ok (${result.added || 0})`;
          });
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
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`Decision ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Decision ingest: ok (${result.decisionId || '-'})`;
          });
        }

        if (source === 'github' || source === 'repo') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'github',
            repoUrl: payload.repoUrl,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`Repo ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Repo ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
          });
        }

        if (source === 'markdown' || source === 'md') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'markdown',
            path: payload.targetPath,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`Markdown ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Markdown ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
          });
        }

        if (source === 'json') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'json',
            path: payload.targetPath,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`JSON ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Json ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
          });
        }

        if (source === 'yaml' || source === 'yml') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'yaml',
            path: payload.targetPath,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`YAML ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Yaml ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
          });
        }

        if (source === 'git-log' || source === 'gitlog') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'git-log',
            path: payload.targetPath,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`Git-log ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Git-log ingest: ok (commits=${result.commits || 0}, added=${result.added || 0})`;
          });
        }

        if (source === 'pdf') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'pdf',
            path: payload.targetPath,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`PDF ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Pdf ingest: ok (files=${result.files || 0}, added=${result.added || 0})`;
          });
        }

        if (source === 'http' || source === 'url') {
          const run = this.kernel.runCapability('repoMemory', {
            action: 'ingest',
            sourceType: 'http',
            url: payload.repoUrl,
            enforceConnectorFirewall: true,
          });
          return Promise.resolve(run).then(result => {
            if (!result || result.ok === false) {
              return commandFailure(`HTTP ingest error: ${result?.error || 'unknown error'}`, opts);
            }
            return `Http ingest: ok (urls=${result.urls || 0}, added=${result.added || 0})`;
          });
        }

        return commandFailure(
          'Desteklenmeyen kaynak. Kullanim: ogren --kaynak manuel|karar|github|markdown|json|yaml|git-log|pdf|http ...',
          opts,
          2
        );
      }
      case 'company-query': {
        this._ensureCompanyCapabilities();
        const run = this.kernel.runCapability('companyBrain', {
          action: 'query',
          question: String(args || '').trim(),
        });
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) {
            return commandFailure(`Query error: ${result?.error || 'unknown error'}`, opts);
          }
          return `Company Brain: ${result.answer}\nKaynak: ${result.source}\nRefs: ${(result.sourceRefs || []).join(', ') || 'yok'}`;
        });
      }
      case 'ingest-status': {
        this._ensureCompanyCapabilities();
        const run = this.kernel.runCapability('ingestStatus', {});
        return Promise.resolve(run).then(result => {
          if (!result || result.ok === false) {
            return commandFailure(`Ingest status error: ${result?.error || 'unknown error'}`, opts);
          }
          const dist = result.distribution || {};
          return `Ingest status -> node:${result.totalNodes} repo:${dist.repo || 0} markdown:${dist.markdown || 0} json:${dist.json || 0} yaml:${dist.yaml || 0} gitlog:${dist['git-log'] || 0} pdf:${dist.pdf || 0} http:${dist.http || 0} manual:${dist.manual || 0}`;
        });
      }
      case 'backup': {
        const result = createBackup(this._backupOptions());
        return `Backup complete: ${result.backupDir} (${result.copied.length} files)${this._commitCliMutation('backup')}`;
      }
      case 'kaydet':
        this.kernel.persist();
        return `Memory saved.${this._commitCliMutation('kaydet')}`;
      case 'onaylar': {
        const result = callMcpTool(
          this.kernel,
          { name: 'huqan.approvals', operatorToken: this._mcpOperatorToken, arguments: { limit: 50, workspaceId: 'default' } },
          this._approvalRuntime()
        );
        if (!result || result.ok === false) {
          return commandFailure(`Approval list error: ${result?.error?.message || 'unknown error'}`, opts);
        }
        return formatCliApprovalList(result, args, opts.json);
      }
      case 'onayla': {
        const approval = args && typeof args === 'object' ? args : parseApprovalDecisionArgs(args);
        if (!approval.approvalId || approval.invalidDecision) {
          return commandFailure(
            'Usage: onayla <approvalId> [approved|rejected]',
            opts,
            2
          );
        }
        return Promise.resolve(callMcpTool(this.kernel, {
          name: 'huqan.approve',
          operatorToken: this._mcpOperatorToken,
          arguments: { approvalId: approval.approvalId, decision: approval.decision, workspaceId: 'default' },
        }, this._approvalRuntime())).then(result => {
          if (!result || result.ok === false) {
            const error = result?.error;
            const message = `Approval error: ${error?.code || 'APPROVAL_FAILED'}: ${error?.message || 'unknown error'}`;
            if (opts.throwOnError === true && error?.code) {
              const failure = new Error(message);
              failure.code = error.code;
              const boundedMeta = {};
              if (result?.meta?.identity && typeof result.meta.identity === 'object') boundedMeta.identity = result.meta.identity;
              if (result?.meta?.oversight && typeof result.meta.oversight === 'object') boundedMeta.oversight = result.meta.oversight;
              if (Object.keys(boundedMeta).length > 0) failure.meta = boundedMeta;
              throw failure;
            }
            return commandFailure(message, opts);
          }
          return formatCliApprovalDecision(result, approval.approvalId, opts.json);
        });
      }
      case 'receipt': return require('./lib/cli-trust-receipt').runCliTrustReceipt(this.kernel, args, opts);
      case 'restore': {
        const result = runCliRestore(args, this._backupOptions({ backupDir: args?.backupDir || args || undefined }));
        if (!result.dryRun) { this.kernel.reload(); this._commitCliMutation('restore'); }
        return formatCliRestore(result, opts.json);
      }
      case 'düşün': {
        if (args === 'dur') {
          this.kernel.stopAutoThink();
          return 'Dusunmeyi durdurdum.';
        }
        return this._formatCliGateMessage(command, {
          decision: 'block',
          reason: 'cli_automation_unavailable',
        });
      }
      case 'optimize':
      case 'konsolide':
      case 'evolve':
        return this._formatCliGateMessage(command, {
          decision: 'block',
          reason: 'cli_canonical_mutation_unavailable',
        });
      case 'quickstart':
        return runQuickstartCommand({
          callTool: callMcpTool,
          createApprovalStore: createApprovalStoreFromKernel,
          operatorToken: this._mcpOperatorToken,
        });
      case 'durum': {
        const stats = this.kernel.graph.getStats();
        const nodes = stats.nodes;
        const edges = stats.edges;
        const entropy = this.kernel.entropy();
        const gaps = this.kernel.detectGaps();
        const contradictions = this.kernel.detectContradictions();
        let out = `Status: ${nodes} nodes, ${edges} edges, entropy: ${entropy.toFixed(3)}`;
        if (isWorkflowRuntime(this.agent)) out += `\n  Agent runtime: workflow`;
        if (gaps.length > 0) out += `\n  ${gaps.length} baglantisiz dugum: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''}`;
        for (const item of contradictions.slice(0, 5)) {
          out += `\n  Contradiction [${item.type}]: ${item.node} -> ${item.targets.join(', ')}`;
        }
        return out;
      }
      case 'rüya': {
        const hypotheses = this.dream.dream();
        if (hypotheses.length === 0) return 'I could not produce a hypothesis; I need more information.';
        const lines = hypotheses.map(item => `  ${item.from} -> ${item.to} (${item.type}, guven: ${item.confidence.toFixed(2)})`);
        return `${hypotheses.length} hipotez:\n${lines.join('\n')}`;
      }
      case 'hypotheses': {
        const argsObject = args && typeof args === 'object' ? args : {};
        const applies = argsObject.tuning === true && argsObject.apply === true;
        const writes = argsObject.propose === true || argsObject.review === true;
        return runCliHypotheses(this.kernel, argsObject, {
          json: opts.json === true,
          commitMutation: applies
            ? () => this._commitCliMutation('hypotheses-tuning-apply', CLI_MUTATION_GATE['hypotheses-tuning-apply'])
            : writes
              ? () => this._commitCliMutation('hypotheses', CLI_MUTATION_GATE.hypotheses)
              : null,
        });
      }
      case 'selam':
        return 'Hello! You can teach me something or ask me a question.';
      case 'yardım':
        return cliHelpText();
      case 'anlamadım':
        return 'I did not understand. Write a longer sentence, or type "yardım" for help.';
      default:
        return 'Unknown command.';
    }
  }

  start() {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'axiom> ',
    });

    console.log('HUQAN - talk, teach and ask in natural language');
    console.log('  "learn: cats are animals" | Learn a fact');
    console.log('  "ask: what is a cat"      | Ask a question');
    console.log('  "verify: cats are plants" | Guarded verification');
    console.log('  "plan: <goal>"            | Agent plan');
    console.log('  "agent: <goal>"           | Run the agent');
    console.log('  "backup"                  | Back up current state');
    console.log('  "restore[: path]"         | Restore from a backup');
    console.log('  "help"                    | Command reference');
    console.log('  "exit"                    | Exit\n');

    let closing = false;
    const handleLine = async (line) => {
      const parsed = this.parse(line);
      if (parsed.command === 'kaydet') {
        // Persisting without its audit record is the fail-open this gate
        // exists to prevent, so an unwritable audit stops the write (#760).
        const audit = this._auditCliMutation('kaydet', CLI_MUTATION_GATE.kaydet, 'allow', true);
        if (!audit.auditRecorded) {
          console.log(`Kaydetme durduruldu: denetim kaydi yazilamadi (${audit.errorCode}).`);
        } else {
          this.kernel.persist();
          console.log(`Memory saved.${this._commitCliMutation('kaydet', CLI_MUTATION_GATE.kaydet)}`);
        }
      } else if (parsed.command === 'çıkış' || parsed.command === 'exit') {
        const rawCommand = String(line || '').trim().toLowerCase();
        const sourceCommand = rawCommand === 'exit' || rawCommand === 'quit' ? 'exit' : 'cikis';
        const audit = this._auditCliMutation(sourceCommand, CLI_MUTATION_GATE.kaydet, 'allow', true);
        if (!audit.auditRecorded) {
          // Exit still exits — refusing to quit would trap the user — but the
          // unaudited save does not happen, and the session says so.
          console.log(`Kaydetmeden cikiliyor: denetim kaydi yazilamadi (${audit.errorCode}).`);
        } else {
          this.kernel.persist();
          console.log(`Memory saved. Goodbye.${this._commitCliMutation(sourceCommand, CLI_MUTATION_GATE.kaydet)}`);
        }
        closing = true;
        rl.close();
        return;
      } else if (parsed.command === 'llm-sor') {
        console.log(this.execute('llm-sor', parsed.args));
      } else {
        const output = await Promise.resolve(this.execute(parsed.command, parsed.args));
        console.log(output);
      }
    };

    let lineQueue = Promise.resolve();
    let closeExit = null;
    rl.prompt();
    rl.on('line', (line) => {
      // The prompt is restored in `finally`, not at the end of handleLine.
      // A throw inside a command branch skipped `rl.prompt()` entirely, so the
      // only thing the user saw was a raw Error object from the catch below and
      // then no prompt at all on the next line (#1029). `closing` keeps the
      // exit branches from printing one last prompt after the goodbye.
      const current = lineQueue.then(() => handleLine(line));
      lineQueue = current
        .catch(error => {
          console.error(error?.message || error);
        })
        .finally(() => {
          if (!closing) rl.prompt();
        });
      return current;
    });
    rl.on('close', () => {
      if (!closeExit) {
        closeExit = lineQueue.then(() => {
          try { this.approvalStore?.close?.(); } catch (_) {}
          process.exit(0);
        });
      }
      return closeExit;
    });
  }

  _evaluateCliGate(command, args) {
    // Approval execution is delegated to the MCP approval handler. It validates
    // the persisted id and runs the admission-aware learn path, so a synthetic
    // CLI allow decision must not bypass that authority.
    if (normalizeCommandText(command) === 'onayla') return null;
    // The bare report is read-only; --propose and `review` both write to the
    // candidate-claim family and stay behind the gate.
    if (normalizeCommandText(command) === 'hypotheses'
      && !(args && typeof args === 'object'
        && (args.propose === true || args.review === true || (args.tuning === true && args.apply === true)))) return null;
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
      case 'huqan.learn':
        gateArgs = { text: typeof args === 'string' ? args : JSON.stringify(args || {}) };
        break;
      case 'huqan.agent':
        gateArgs = { goal: typeof args === 'string' ? args : JSON.stringify(args || {}) };
        break;
      case 'huqan.ask':
        gateArgs = { question: String(args || '') };
        break;
      case 'huqan.verify':
        gateArgs = { statement: String(args || '') };
        break;
      case 'huqan.reason':
        gateArgs = { subject: String(args || '') };
        break;
      case 'huqan.compare': {
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
  // have no huqan.* MCP tool. Returns null for unknown/read-only commands so
  // they proceed ungated. Every real mutation attempt is audited (allow OR
  // review) so nothing mutates silently.
  _evaluateCliMutationGate(command, args) {
    return evaluateCliMutationGate({ kernel: this.kernel, command, args });
  }

  _auditCliMutation(command, classification, decision, executed, phase = 'attempted') {
    return auditCliMutation(this.kernel, { command, classification, decision, executed, phase });
  }

  // Records that a mutation actually completed. Its failure is reported, not
  // fatal: the state change already happened, so refusing it here would only
  // hide it (#760).
  _commitCliMutation(command, classification = null) {
    const audit = commitCliMutation(this.kernel, command, classification);
    return audit.auditRecorded ? '' : `\nUyari: ${command} tamamlandi ama commit denetim kaydi yazilamadi (${audit.errorCode}).`;
  }
}

async function runCliArgv(argv = [], io = {}) {
  return runWorkflowCliArgv(argv, io, {
    createCli: options => new CLI(options),
    version: require('./package.json').version,
  });
}

async function main(argv = process.argv.slice(2)) {
  const result = await runCliArgv(argv);
  if (result.interactive) {
    const cli = new CLI();
    cli.kernel.reload();
    cli.start();
    return;
  }
  process.exitCode = result.exitCode;
}

if (require.main === module) {
  main().catch(error => {
    console.error(`CLI error: ${error?.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = CLI;
module.exports.createKernel = createKernel;
module.exports.shellQuote = shellQuote;
module.exports.runCliArgv = runCliArgv;
