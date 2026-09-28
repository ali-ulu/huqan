'use strict';

const { runLearnDocument } = require('./kernel-learn-document');
const { runSelfLearn } = require('./kernel-self-learn');
const { runLearnFromLLM } = require('./kernel-learn-from-llm');
const { runDream } = require('./kernel-dream');
const { runSelfEvolve, buildSelfEvolveCollaborators, runAutoMaintain } = require('./kernel-self-evolve');
const { runAlternatives } = require('./kernel-alternatives');
const { runContextSimilarity } = require('./kernel-context-similarity');
const { runAutoThinkTick } = require('./kernel-auto-think');
const { runCrossLink } = require('./kernel-cross-link');
const { workspaceIdFrom } = require('./kernel-read-methods');
const { installKernelMethods } = require('./kernel-method-install');

// Higher-level cognition methods retain Kernel's public facade and delegate
// to the existing bounded inference, dream, and learning implementations.
function install(Kernel, Dream) {
  class KernelCognitionMethods {
  /**
   * FAZ2-PR3 (F-001-d): Derive "benzer" (similarity) edges from shared tags.
   *
   * Two entry modes:
   *  - Parent-allowed (context.parentAdmissionAllowed === true):
   *      Invoked from the main learn path AFTER user admission allowed the
   *      parent write.  Derived "benzer" edges inherit parent provenance and
   *      are audited as derived writes; no background admission round-trip
   *      so the derived chain does not deadlock on review-by-default.  This
   *      mirrors the parent admission decision rather than introducing a
   *      separate background gate for a write the user already authorized.
   *  - Background (no context):
   *      Invoked externally (e.g. inference/maintenance).  Routed through
   *      _commitBackgroundEdge so the synthetic provenance is admission-gated.
   *      Default decision is 'review' → no canonical write.
   *
   * Either path produces an audit event so the attempt is observable.
   */
  _crossLink(subject, object, relation, workspaceId = 'default', context = {}) {
    return runCrossLink({ graph: this.graph, appendAuditEvent: (...args) => this._appendAuditEvent(...args), admissionReceiptDetails: admission => this._admissionReceiptDetails(admission), commitBackgroundEdge: (...args) => this._commitBackgroundEdge(...args) }, subject, object, relation, workspaceId, context);
  }

  alternatives(subject, maxPaths = 3, workspaceId = 'default') {
    return runAlternatives(value => this.normalizeWord(value), this.graph, (type, data, evidence) => this.ok(type, data, evidence), subject, maxPaths, workspaceId);
  }

  contextSimilarity(a, b, context) {
    return runContextSimilarity(this.graph, a, b, context);
  }

  // --- Background auto-think ---
  startAutoThink(intervalMs = 10000) {
    if (this._thinkTimer) return;
    this._dreamer = new Dream(this);
    this._thinkTimer = setInterval(() => {
      try {
        this._autoThinkTick();
      } catch (e) {
        console.error('\n[autoThink hata]', e.message);
      }
    }, intervalMs);
    this._autoThinkLog('AutoThink başladı (her ' + (intervalMs / 1000) + 's)');
  }

  stopAutoThink() {
    if (this._thinkTimer) {
      clearInterval(this._thinkTimer);
      this._thinkTimer = null;
    }
    this._autoThinkLog('AutoThink durduruldu');
  }

  _autoThinkTick() {
    return runAutoThinkTick({ dreamer: this._dreamer, graph: this.graph, commitBackgroundEdge: (...args) => this._commitBackgroundEdge(...args), introspect: (...args) => this.introspect(...args), autoThinkLog: (...args) => this._autoThinkLog(...args), getDreamCount: () => this._dreamCount, setDreamCount: value => { this._dreamCount = value; } });
  }

  _autoThinkLog(msg) {
    console.log('\n[🧠 ' + new Date().toLocaleTimeString() + '] ' + msg);
  }

  dream(opts = {}) {
    return runDream(opts, { createDreams: dreamOpts => new Dream(this).dream(dreamOpts), graph: this.graph, commitBackgroundEdge: (from, to, relation, source, commitOpts) => this._commitBackgroundEdge(from, to, relation, source, commitOpts), getDreamCount: () => this._dreamCount, setDreamCount: value => { this._dreamCount = value; }, ok: (type, data, evidence) => this.ok(type, data, evidence) });
  }

  learnDocument(text, opts = {}) {
    return runLearnDocument((line, options) => this.learn(line, options), text, opts, { flushGraph: () => this.graph.save() });
  }

  /**
   * LLM yanıtından bilgi öğren.
   * Çelişkili cümleleri atlar, yeni bilgileri grafiğe ekler.
   *
   * @param {string} text - LLM'den gelen ham metin
   * @param {object} [opts]
   * @param {boolean} [opts.skipConflicts=true]  - çelişkili cümleleri atla
   * @param {number}  [opts.minWords=2]           - minimum kelime sayısı
   * @param {number}  [opts.maxSentences=20]      - max cümle sayısı
   * @returns {{ learned: number, skipped: number, conflicts: string[] }}
   */
  learnFromLLM(text, opts = {}) {
    return runLearnFromLLM(text, opts, { paranoidMode: this.paranoidMode, contractVersion: this.contractVersion, verify: (statement, verifyOpts) => this.verify(statement, verifyOpts), learn: (sentence, learnOpts) => this.learn(sentence, learnOpts) });
  }

  /**
   * Kendi kendine evrimleşme döngüsü.
   * 1. Rüya gör (hipotez üret)
   * 2. Yüksek güvenli hipotezleri bilgiye dönüştür
   * 3. Grafiği temizle (birleştir + optimize et)
   * 4. Kaydet, rapor döndür
   */
  selfEvolve(opts = {}) {
    return runSelfEvolve(opts, buildSelfEvolveCollaborators(this, Dream, workspaceIdFrom(opts)));
  }

  /**
   * Kendi kendine öğrenme için boşlukları tespit eder.
   * Governed bir öğrenme/admission yolu bağlanana kadar read-only stub döndürür.
   */
  selfLearn(opts = {}) {
    return runSelfLearn(() => this.detectGaps(), this.graph);
  }

  _autoMaintain() {
    runAutoMaintain(this);
  }
  }
  installKernelMethods(Kernel, KernelCognitionMethods);
}

module.exports = { install };
