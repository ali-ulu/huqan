const Graph = require('./graph');
const Dream = require('./dream');
const fs = require('fs');
const path = require('path');
const PluginManager = require('./plugin');

let RustGraph;
try { RustGraph = require('./rustGraph'); } catch {}
const RUST_BIN = path.join(__dirname, 'axiom-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'axiom-core.exe');
const hasRust = fs.existsSync(RUST_BIN) && typeof RustGraph !== 'undefined';

const AXIOM_ERROR = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  GRAPH_UNAVAILABLE: 'GRAPH_UNAVAILABLE',
  NORMALIZATION_FAILED: 'NORMALIZATION_FAILED',
  LLM_DISABLED: 'LLM_DISABLED',
  INTERNAL: 'INTERNAL',
});

const CONTRACT_VERSION = '1.0.0';

// --- Türkçe NLP yardımcıları ---

// Turkish i/ı normalization for stable node ids.
const NORMALIZE_MAP = {
  'ı': 'i', 'İ': 'i', 'I': 'i',
};

// Türkçe çoğul ekleri — normalize etmek için
const PLURAL_SUFFIXES = ['lar', 'ler'];

// Türkçe bağlaçlar ve stop word'ler — öğrenmede görmezden gel
const STOP_WORDS = new Set([
  've', 'veya', 'ile', 'de', 'da', 'ki', 'bu', 'şu', 'o', 'bir',
  'için', 'gibi', 'kadar', 'daha', 'en', 'çok', 'az', 'her', 'hiç',
  'ne', 'nasıl', 'neden', 'niçin', 'nerede', 'kim', 'hangi',
]);

/**
 * Türkçe kelimeyi normalize et:
 * - küçük harf
 * - çoğul ekini kaldır (basit kural)
 */
function normalizeTurkish(word) {
  let w = word.toLowerCase().trim();
  // Normalize dotted-i variants without decomposing other Turkish letters.
  w = w.replace(/i\u0307/g, 'i').replace(/\u0307/g, '');
  w = w.split('').map(c => NORMALIZE_MAP[c] || c).join('');
  // Çoğul eki kaldır (kedi → kedi, kediler → kedi)
  for (const suf of PLURAL_SUFFIXES) {
    if (w.endsWith(suf) && w.length > suf.length + 2) {
      w = w.slice(0, w.length - suf.length);
      break;
    }
  }
  return w;
}

/**
 * Türkçe cümleyi özne + yüklem olarak parse et.
 * Desteklenen formatlar:
 *   "kedi hayvandır"          → özne: kedi, yüklem: hayvandır
 *   "kediler balık yer"       → özne: kedi (normalize), yüklem: balık yer
 *   "kedi bir memelilerdir"   → "bir" atlanır
 *   "kedi ve köpek hayvandır" → iki özne
 */
function parseSentence(text, knownNodes = null) {
  const raw = text.toLowerCase().trim();
  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;

  // "bir" gibi belirsiz artikelleri atla
  const filtered = words.filter(w => w !== 'bir' && w !== 'de' && w !== 'da');
  if (filtered.length < 2) return null;

  // "X ve Y Zdir" → iki özne
  const veIdx = filtered.indexOf('ve');
  if (veIdx === 1 && filtered.length >= 4) {
    const subjectA = normalizeTurkish(filtered[0]);
    const subjectB = normalizeTurkish(filtered[2]);
    const predicate = filtered.slice(3).join(' ');
    return [
      { subject: subjectA, predicate },
      { subject: subjectB, predicate },
    ];
  }

  // Çok kelimeli özne tespiti: grafikteki düğümlerle eşleştir
  if (knownNodes) {
    const nodeIds = typeof knownNodes === 'object' && !Array.isArray(knownNodes)
      ? Object.keys(knownNodes) : (Array.isArray(knownNodes) ? knownNodes : []);
    for (let len = Math.min(3, filtered.length - 1); len >= 2; len--) {
      const candidate = normalizeTurkish(filtered.slice(0, len).join(' '));
      if (nodeIds.includes(candidate) || nodeIds.some(n => normalizeTurkish(n) === candidate)) {
        const predicate = filtered.slice(len).join(' ');
        return [{ subject: candidate, predicate }];
      }
    }
  }

  const subject = normalizeTurkish(filtered[0]);
  const predicate = filtered.slice(1).join(' ');
  return [{ subject, predicate }];
}

class Kernel {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.noLoad=false] - true ise memory.json yüklenmez (test için)
   * @param {string}  [opts.memoryPath]   - özel hafıza dosyası yolu
   */
  constructor(opts = {}) {
    const graphOpts = {};
    if (opts.memoryPath) graphOpts.memoryPath = opts.memoryPath;
    if (opts.dbPath) graphOpts.dbPath = opts.dbPath;
    if (opts.useSQLite !== undefined) graphOpts.useSQLite = opts.useSQLite;
    if (opts.noLoad && !opts.memoryPath && !opts.dbPath && opts.useSQLite === undefined) {
      graphOpts.useSQLite = false;
    }
    this.graph = new Graph(graphOpts);
    if (!opts.noLoad) this.graph.load();
    this.paranoidMode = opts.paranoidMode === true || process.env.AXIOM_PARANOID === '1';
    this.contractVersion = CONTRACT_VERSION;
    this._rust = hasRust ? new RustGraph() : null;
    this.plugins = new PluginManager(this);
    if (opts.loadPlugins !== false) {
      const pDir = path.join(__dirname, 'plugins');
      if (fs.existsSync(pDir)) this.plugins.load(pDir);
    }
  }

  usePlugin(plugin) {
    this.plugins.register(plugin);
  }

  _ok(type, data = null, evidence = [], meta = {}) {
    const stats = this.graph && typeof this.graph.getStats === 'function' ? this.graph.getStats() : {};
    return this._validateResult({
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta: {
        contractVersion: this.contractVersion,
        backend: stats.backend || 'unknown',
        paranoidMode: this.paranoidMode,
        ...meta,
      },
    });
  }

  _fail(type, code, message, meta = {}) {
    return this._validateResult({
      ok: false,
      type,
      data: null,
      evidence: [],
      error: { code, message },
      meta: {
        contractVersion: this.contractVersion,
        paranoidMode: this.paranoidMode,
        ...meta,
      },
    });
  }

  _validateResult(result) {
    if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid result: ok must be boolean');
    if (!Array.isArray(result.evidence)) throw new Error('Invalid result: evidence must be array');
    if (result.type === 'verify' && result.data) {
      const statuses = new Set(['dogrulandi', 'celiski', 'bilinmiyor']);
      if (!statuses.has(result.data.status)) throw new Error('Invalid verify status: ' + result.data.status);
      if (typeof result.data.confidence !== 'number' || result.data.confidence < 0 || result.data.confidence > 1) {
        throw new Error('Invalid confidence: must be between 0 and 1');
      }
    }
    return result;
  }

  _edgeRef(edge) {
    return { from: edge.from, to: edge.to, relation: edge.relation };
  }

  _edgeEvidence(edge, kind = 'direct_edge', confidence) {
    return {
      kind,
      text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
      confidence: Math.max(0, Math.min(1, confidence ?? edge.confidence ?? edge.weight ?? 0)),
      nodes: [edge.from, edge.to],
      edges: [this._edgeRef(edge)],
    };
  }

  _pathEvidence(pathArr, kind = 'path', confidence = 0.5) {
    const edges = [];
    for (let i = 0; i < pathArr.length - 1; i++) {
      const direct = this.graph.getEdges(pathArr[i]).find(e => e.to === pathArr[i + 1]);
      const reverse = this.graph.getInEdges(pathArr[i]).find(e => e.from === pathArr[i + 1]);
      const edge = direct || reverse;
      if (edge) edges.push(this._edgeRef(edge));
    }
    return {
      kind,
      text: pathArr.join(' → '),
      confidence: Math.max(0, Math.min(1, confidence)),
      nodes: [...pathArr],
      edges,
    };
  }

  _contradictionEvidence(contradiction) {
    return {
      kind: 'contradiction',
      text: `${contradiction.node} → ${contradiction.targets.join(', ')}`,
      confidence: Math.max(0, Math.min(1, contradiction.confidence || 0.7)),
      nodes: [contradiction.node, ...contradiction.targets],
      edges: contradiction.targets.map(to => ({ from: contradiction.node, to, relation: 'tür' })),
    };
  }

  learn(text) {
    const ev = this.plugins.emit('beforeLearn', { text });
    text = ev.text;

    const parsed = parseSentence(text, this.graph._nodes);
    if (!parsed) return this._ok('learn', { learned: 0, skipped: 1, conflicts: [] }, []);

    // KALİTE KONTROLÜ: çelişki ve alternatif tespiti
    const conflicts = [];
    const alternatives = [];
    let learned = 0;
    const evidence = [];

    for (const { subject, predicate } of parsed) {
      if (!subject || STOP_WORDS.has(subject)) continue;

      const rel = this._parsePredicate(predicate);
      if (rel) {
        const { object, relation } = rel;
        if (STOP_WORDS.has(object)) continue;

        // AYNI özne-ilişki için mevcut nesneleri bul
        const existingEdges = this.graph.getEdges(subject).filter(e => e.relation === relation);
        const existingTargets = existingEdges.map(e => e.to);

        // ÇELİŞKİ KONTROLÜ
        // tür: farklı anlam taşıyan iki tür → çelişki
        // değil: aynı nesne için "tür" varsa → çelişki
        // kistlama (sadece): aynı özne için başka yapabilir varsa → çelişki
        let celiskiBulundu = false;

        if (relation === 'tür') {
          for (const existing of existingTargets) {
            if (existing !== object) {
              const benzerlik = this.contextSimilarity(object, existing, subject);
              if (benzerlik < 0.15) {
                conflicts.push({
                  type: 'alternative',
                  subject,
                  relation: 'tür',
                  current: object,
                  existing,
                  confidence: parseFloat(benzerlik.toFixed(3)),
                });
                celiskiBulundu = true;
              }
            }
          }
        }

        if (relation === 'değil') {
          // "X Y değildir" → X'te aynı hedef için tür var mı?
          const turEdges = this.graph.getEdges(subject).filter(e => e.relation === 'tür');
          for (const tur of turEdges) {
            if (tur.to === object) {
              // Aynı kavram → çelişki: tür edge weight düşür
              const onceki = tur.weight;
              tur.weight = 0.2;
              tur.celiski = 'downgraded';
              conflicts.push({
                type: 'negation',
                subject,
                relation: 'değil',
                current: object,
                existing: tur.to,
                message: `"${subject}" "${object} değildir" deniyor (önceden tür:${onceki}) → tür weight düşürüldü`,
                confidence: 0,
              });
              celiskiBulundu = true;
            }
          }
        }

        // KISITLAMA: "sadece x yapar" → başka yapabilir varsa çelişki
        if (rel.kistlama && relation === 'yapabilir') {
          const digerYapabilir = existingEdges.filter(e => e.relation === 'yapabilir' && e.to !== object);
          for (const dg of digerYapabilir) {
            conflicts.push({
              type: 'restriction',
              subject,
              relation: 'yapabilir',
              current: object,
              existing: dg.to,
              message: `"${subject}" sadece "${object}" yapabilir deniyor ama "${dg.to}" da yapabiliyor`,
              confidence: 0,
            });
            celiskiBulundu = true;
          }
        }

        // ALTERNATİF: aynı kavramın farklı ifadelerini tespit et
        if (existingTargets.length > 0 && !existingTargets.includes(object)) {
          alternatives.push({
            subject,
            relation,
            current: object,
            existing: existingTargets,
          });
        }

        // ÖĞRENME: düşük güvenli alternatifleri de ekle (çelişkiyi önlemek için farklı ilişkiyle)
        this.graph.addNode(subject, subject);
        this.graph.addNode(object, object);

        if (celiskiBulundu && (relation === 'tür')) {
          // tür çelişkisi → benzer olarak kaydet
          const edge = this.graph.addEdge(subject, object, 'benzer', { source: 'alt', weight: 0.15, evidence: [text] });
          if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
        } else if (celiskiBulundu && relation === 'değil') {
          // değil çelişkisi: tür edge weight zaten düşürüldü, yeni edge ekleme
        } else if (celiskiBulundu) {
          // kistlama → düşük weight ile kaydet
          const edge = this.graph.addEdge(subject, object, relation, { source: 'learn', weight: 0.2, evidence: [text] });
          if (rel.kistlama && edge) edge.kistlama = true;
          if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
        } else {
          // Normal öğrenme
          const edge = this.graph.addEdge(subject, object, relation, { source: 'learn', evidence: [text] });
          this.graph.addTag(subject, object, 0.3);
          this._crossLink(subject, object, relation);
          learned++;
          if (edge) evidence.push(this._edgeEvidence(edge));
        }
      }
    }

    this.plugins.emit('afterLearn', { text, conflicts, alternatives });

    if (this._rust) {
      this._rust.learn(text).catch(() => {});
    }

    if (learned > 0) {
      try { this.graph.save(); } catch (_) {}
      if (typeof setImmediate !== 'undefined') setImmediate(() => this._autoMaintain());
    }

    return this._ok('learn', {
      learned,
      skipped: parsed.length - learned,
      conflicts,
      alternatives,
    }, evidence);
  }

  _parsePredicate(predicate) {
    // "bir" gibi belirsiz artikelleri temizle
    predicate = predicate.replace(/^bir\s+/, '').trim();

    // KISITLAMA: "sadece x yapar" → kısıtlama işareti
    const kistlama = predicate.match(/^(sadece|yalnızca|sırf|ancak)\s+(.+)/i);
    if (kistlama) {
      // Kısıtlı hali parse et, kısıtlama bilgisini object'e göm
      const inner = kistlama[2];
      const parsed = this._parsePredicate(inner);
      if (parsed) {
        parsed.kistlama = true;
        parsed.object = inner;
        return parsed;
      }
    }

    // -değil/-değildir → olumsuzluk
    // "farkındalık değildir" → değil ilişkisi
    const degilMatch = predicate.match(/^(.+?)\s+değildir$/i);
    if (degilMatch) {
      return { object: degilMatch[1].trim(), relation: 'değil' };
    }
    // tek kelime "değildir" bitişik: "farkındalıkdeğildir"
    const degilSuffix = /^(.+?)değildir$/i;
    const dMatch = predicate.match(degilSuffix);
    if (dMatch && dMatch[1].trim()) {
      return { object: dMatch[1].trim(), relation: 'değil' };
    }

    // -mez/-maz olumsuz fiil: "hissetmez", "anlamaz", "bilmez" → değil
    // "duyguyu hissetmez" gibi çok kelimeli için son kelimeyi kontrol et
    const negVerbMatch = predicate.match(/^(.+?)\s+(.+)(mez|maz)$/i);
    if (negVerbMatch) {
      const verb = negVerbMatch[2] + negVerbMatch[3];
      return { object: (negVerbMatch[1] + ' ' + verb).trim(), relation: 'değil' };
    }
    // tek kelimeli: "hissetmez"
    const negSingle = predicate.match(/^(.+?)(mez|maz)$/i);
    if (negSingle && predicate.indexOf(' ') === -1) {
      return { object: predicate, relation: 'değil' };
    }

    // -dır/-dir/-dur/-dür/-tır/-tir/-tur/-tür → tür ilişkisi
    const tirSuffix = /(dır|dir|dur|dür|tır|tir|tur|tür)$/i;
    if (tirSuffix.test(predicate)) {
      const stem = normalizeTurkish(predicate.replace(tirSuffix, ''));
      return { object: stem, relation: 'tür' };
    }

    // -dır/-dir ekli çok kelimeli yüklem: "doğru düşünme yöntemidir"
    const tirMulti = /^(.+?)(dır|dir|dur|dür|tır|tir|tur|tür)$/i;
    const mMatch = predicate.match(tirMulti);
    if (mMatch && mMatch[1].includes(' ')) {
      return { object: mMatch[1].trim(), relation: 'tür' };
    }

    // Fiil ekleri → yapabilir ilişkisi
    const verbSuffix = /(ar|er|ır|ir|ur|ür|yor|acak|ecek|mak|mek)$/i;
    if (verbSuffix.test(predicate)) {
      return { object: predicate, relation: 'yapabilir' };
    }

    // -r ile biten kısa fiiller
    if (/r$/i.test(predicate) && predicate.length > 2) {
      return { object: predicate, relation: 'yapabilir' };
    }

    // Çok kelimeli yüklem → özellik
    return { object: predicate, relation: 'özellik' };
  }

  _crossLink(subject, object, relation) {
    const subjNode = this.graph.getNode(subject);
    const objNode = this.graph.getNode(object);
    if (!subjNode || !objNode) return;

    for (const tag of Object.keys(subjNode.vector)) {
      if (tag !== object && this.graph.getNode(tag) && objNode.vector[tag]) {
        const existing = this.graph.getEdge(subject, object, 'benzer');
        if (!existing) {
          this.graph.addEdge(subject, object, 'benzer');
        }
      }
    }
  }

  ask(question) {
    const ev = this.plugins.emit('beforeAsk', { question });
    question = ev.question;

    const raw = question.toLowerCase().trim();
    const cleaned = raw
      .replace(/\b(nedir|kimdir|nas\u0131l|nerede|nereden|nereye|ka\u00e7|hangi)\b/gi, '')
      .trim();

    // YARDIM: şahıs eklerini köke indirge
    const _kokeIndirge = (s) => {
      let kok = s
        .replace(/mezsem$/, 'me')
        .replace(/mazsam$/, 'ma')
        .replace(/sem$/, '')
        .replace(/sam$/, '')
        .replace(/meliyim$/, 'me')
        .replace(/mal\u0131y\u0131m$/, 'ma')
        .replace(/yim$/, '')
        .replace(/y\u0131m$/, '')
        .replace(/yum$/, '')
        .replace(/y\u00fcm$/, '')
        .replace(/m$/, '')
        .replace(/im$/, '')
        .replace(/s\u0131n$/, '')
        .replace(/sin$/, '')
        .replace(/sun$/, '')
        .replace(/s\u00fcn$/, '')
        .replace(/yorsun$/, '')
        .replace(/yor$/, '');
      // "sürekli öğrenmeliyim" → "sürekli öğrenme"
      if (kok.endsWith('meliyim')) kok = kok.slice(0, -7);
      return kok.trim();
    };

    // YARDIM: özneyi bul (ben kipi varsa axiom'a yönlendir)
    const _ozneBul = (s) => {
      const parts = s.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { subject: 'axiom', verb: '' };
      const ilk = parts[0];
      const normalized = normalizeTurkish(ilk);
      // İlk kelime grafikte var mı?
      if (this.graph.getNode(normalized)) {
        return { subject: normalized, verb: parts.slice(1).join(' ') };
      }
      // Şahıs eki var mı? (öğrenmezsem, öğrenmeliyim, bilmiyorum, yapabilirim...)
      const fiilKok = _kokeIndirge(ilk);
      const normKok = normalizeTurkish(fiilKok);
      if (this.graph.getNode(normKok)) {
        return { subject: 'axiom', verb: normKok };
      }
      // Son kelimeye bak (sürekli öğrenmeliyim → "sürekli" değil "öğrenme")
      if (parts.length > 1) {
        const son = parts[parts.length - 1];
        const sonKok = _kokeIndirge(son);
        const normSon = normalizeTurkish(sonKok);
        // "sürekli"yi sıfat olarak ata
        const sifati = parts.slice(0, -1).join(' ') + ' ' + sonKok;
        if (this.graph.getNode(normSon)) {
          return { subject: 'axiom', verb: sifati, sifat: parts.slice(0, -1).join(' ') };
        }
        // Hiçbiri yoksa axiom dene
        return { subject: 'axiom', verb: s };
      }
      return { subject: normalized, verb: '' };
    };

    // PATTERN 1: Neden/niçin/niye sorusu → reason() kullan
    if (/^(neden|niçin|niye)\b/.test(raw)) {
      const action = raw.replace(/^(neden|niçin|niye)\s+/, '');
      const { subject } = _ozneBul(action);
      const subj = normalizeTurkish(subject);
      return this.reason(subj || 'axiom');
    }

    // PATTERN 2: "ne olur" / "olursa" sorusu → forward chain
    if (/ne olur/.test(raw) || /\w+sa\b/.test(raw) || /\w+se\b/.test(raw)) {
      const action = raw.replace(/\s+ne olur.*$/, '').replace(/\s+olursa.*$/, '').trim();
      const { subject, verb } = _ozneBul(action);
      const subj = this.graph.getNode(verb && normalizeTurkish(verb)) ? normalizeTurkish(verb) : normalizeTurkish(subject);
      if (this.graph.getNode(subj)) {
        return this.reason(subj);
      }
    }

    const parts = cleaned.split(/\s+/).filter(Boolean);
    const { subject: detected } = _ozneBul(parts[0] || '');
    const subject = detected;
    const node = this.graph.getNode(subject);

    // Eğer özne grafikte yoksa ama şahıs eki varsa, axiom'a yönlendir
    const finalSubject = node ? subject : 'axiom';
    const finalNode = this.graph.getNode(finalSubject);

    if (!finalNode) {
      return this._ok('ask', { answer: 'Bilmiyorum', subject: finalSubject, unknown: true }, []);
    }

    const edges = this.graph.getEdges(finalSubject);
    if (edges.length === 0) {
      return this._ok('ask', { answer: 'Bilmiyorum', subject: finalSubject, unknown: true }, []);
    }

    // KISITLAMA: sadece x yapar → filter yapabilir edges
    const kistlamaVar = edges.some(e => e.kistlama && e.relation === 'yapabilir');
    const allowedYapabilir = kistlamaVar
      ? new Set(edges.filter(e => e.kistlama && e.relation === 'yapabilir').map(e => e.to))
      : null;

    const sorted = [...edges].sort((a, b) => b.weight - a.weight);
    const evidence = [];
    const results = [];

    for (const edge of sorted) {
      if (kistlamaVar && edge.relation === 'yapabilir' && !allowedYapabilir.has(edge.to)) continue;
      evidence.push(this._edgeEvidence(edge));
      if (edge.relation === 'tür') {
        if (!results.includes(edge.to)) results.push(edge.to);
        const transitive = this._walkTransitive(edge.to, [], 2);
        for (const t of transitive) {
          if (!results.includes(t)) results.push(t);
        }
      } else if (edge.relation === 'yapabilir') {
        if (!results.includes(edge.to)) results.push(edge.to);
      } else if (!results.includes(edge.to)) {
        results.push(edge.to);
      }
    }

    // Alternatif çözüm önerileri
    const altResult = this.alternatives(finalSubject, 2);
    const altPaths = altResult.data.paths || [];
    const altText = altPaths.length > 1
      ? `\n  alternatif: ${altPaths.map(p => `[${p.type}] ${p.to}`).join(', ')}`
      : '';

    const answer = results.length === 0 ? 'Bilmiyorum' : `${finalSubject} ${results.join(', ')}${altText}`;
    this.plugins.emit('afterAsk', { question, answer, alternatives: altPaths.length });
    return this._ok('ask', { answer, subject: finalSubject, unknown: false, alternatives: altPaths.length }, evidence);
  }

  _walkTransitive(nodeId, visited, depth) {
    if (depth <= 0 || visited.includes(nodeId)) return [];
    visited.push(nodeId);
    const edges = this.graph.getEdges(nodeId);
    const results = [];
    for (const e of edges) {
      if (e.relation === 'tür' && !visited.includes(e.to)) {
        results.push(e.to);
        results.push(...this._walkTransitive(e.to, visited, depth - 1));
      }
    }
    return results;
  }

  alternatives(subject, maxPaths = 3) {
    const normalized = normalizeTurkish(subject);
    const node = this.graph.getNode(normalized);
    if (!node) {
      return this._ok('alternatives', { subject: normalized, answer: 'Bilmiyorum', paths: [] }, []);
    }

    // 1. Doğrudan kenarlardan alternatif grupları oluştur
    const edges = this.graph.getEdges(normalized);
    const groups = { tür: [], yapabilir: [], özellik: [], benzer: [], hipotez: [] };
    for (const e of edges) {
      const g = groups[e.relation];
      if (g) g.push(e.to);
    }

    // 2. En yüksek güvenli hedefleri seç, her gruptan bir tane al
    const paths = [];
    const usedNodes = new Set([normalized]);

    // İlişki önceliği: tür > yapabilir > özellik > benzer > hipotez
    const relOrder = ['tür', 'yapabilir', 'özellik', 'benzer', 'hipotez'];

    for (const rel of relOrder) {
      if (paths.length >= maxPaths) break;
      const targets = groups[rel] || [];
      if (targets.length === 0) continue;

      // Güvene göre sırala (yüksekten düşüğe)
      const sorted = targets
        .map(t => ({ target: t, weight: edges.find(e => e.to === t && e.relation === rel)?.weight || 0.5 }))
        .sort((a, b) => b.weight - a.weight);

      const best = sorted[0];
      if (usedNodes.has(best.target)) continue;

      const subEdges = this.graph.getEdges(best.target).filter(e => !usedNodes.has(e.to));
      const chain = subEdges.slice(0, 2).map(e => ({ node: e.to, rel: e.relation }));
      paths.push({
        type: rel,
        from: normalized,
        to: best.target,
        chain,
        confidence: best.weight,
      });
      usedNodes.add(best.target);
    }

    // 3. Alternatif çözüm olarak değerlendir
    let answer = normalized + ' için alternatif çözümler:\n';
    for (const p of paths) {
      answer += `  [${p.type}] ${p.from} → ${p.to}`;
      if (p.chain.length > 0) {
        answer += ` → ${p.chain.map(c => c.node + '(' + c.rel + ')').join(', ')}`;
      }
      answer += ` (güven: ${p.confidence.toFixed(2)})\n`;
    }
    if (paths.length === 0) answer = 'Bilmiyorum';

    const evidence = paths.map(p => ({
      kind: 'alternative_path',
      text: `${p.from} --[${p.type}]--> ${p.to}`,
      confidence: p.confidence,
      nodes: [p.from, p.to],
      edges: [{ from: p.from, to: p.to, relation: p.type }],
    }));

    return this._ok('alternatives', { subject: normalized, answer, paths }, evidence);
  }

  contextSimilarity(a, b, context) {
    const ctxWeight = {};
    const ctxNode = this.graph.getNode(context);
    if (ctxNode) {
      for (const [dim, w] of Object.entries(ctxNode.vector)) {
        ctxWeight[dim] = w;
      }
    }

    const aNode = this.graph.getNode(a);
    const bNode = this.graph.getNode(b);
    if (!aNode || !bNode) return 0;

    const dims = new Set([
      ...Object.keys(aNode.vector),
      ...Object.keys(bNode.vector),
      ...Object.keys(ctxWeight),
    ]);

    let dot = 0, magA = 0, magB = 0;
    for (const d of dims) {
      const cw = ctxWeight[d] || 1;
      const va = (aNode.vector[d] || 0) * cw;
      const vb = (bNode.vector[d] || 0) * cw;
      dot += va * vb;
      magA += va * va;
      magB += vb * vb;
    }

    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  }

  entropy() {
    const allNodes = Object.values(this.graph._nodes);
    if (allNodes.length === 0) return 0;
    let totalWeight = 0;
    const weights = [];
    for (const node of allNodes) {
      const edges = this.graph.getEdges(node.id);
      for (const e of edges) {
        weights.push(e.weight);
        totalWeight += e.weight;
      }
    }
    if (totalWeight === 0) return 0;
    let s = 0;
    for (const w of weights) {
      const p = w / totalWeight;
      s -= p * Math.log(p);
    }
    return s;
  }

  detectGaps() {
    const allNodes = Object.values(this.graph._nodes);
    const gaps = [];
    for (const node of allNodes) {
      const edges = this.graph.getEdges(node.id);
      if (edges.length === 0) {
        gaps.push(node.id);
      }
    }
    return gaps;
  }

  reason(subject) {
    const normalized = normalizeTurkish(subject);
    const node = this.graph.getNode(normalized);
    if (!node) {
      return this._ok('reason', {
        subject: normalized,
        answer: 'Bilmiyorum',
        forward: [],
        backward: [],
        cycles: [],
      }, []);
    }

    const ileri = this._forwardChain(normalized, [], new Set(), 4);
    const geri = this._backwardChain(normalized, [], new Set(), 4);
    const cycle = this._detectCycle(normalized, new Set(), []);
    const evidence = [
      ...ileri.map(edge => this._edgeEvidence(edge, 'path', 0.5)),
      ...geri.map(edge => this._edgeEvidence(edge, 'path', 0.5)),
    ];

    let answer = normalized + ':';
    if (ileri.length > 0) answer += '\n  neden olur: ' + ileri.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (geri.length > 0) answer += '\n  nedeni: ' + geri.map(e => e.from + ' [' + e.relation + ']').join(', ');
    if (cycle) {
      answer += '\n  ? d?ng? tespit edildi: ' + cycle.join(' ? ');
      evidence.push(this._pathEvidence(cycle, 'path', 0.4));
      const nedenOnce = this._resolveCycleOrder(cycle);
      if (nedenOnce) answer += '\n  ? ilk neden: ' + nedenOnce;
    }

    return this._ok('reason', {
      subject: normalized,
      answer: answer || 'Bilmiyorum',
      forward: ileri.map(edge => this._edgeRef(edge)),
      backward: geri.map(edge => this._edgeRef(edge)),
      cycles: cycle ? [cycle] : [],
    }, evidence);
  }

  compare(a, b) {
    const na = this.graph.getNode(normalizeTurkish(a));
    const nb = this.graph.getNode(normalizeTurkish(b));
    if (!na || !nb) {
      return this._ok('compare', {
        a: normalizeTurkish(a),
        b: normalizeTurkish(b),
        answer: 'Bilmiyorum',
        common: [],
        onlyA: [],
        onlyB: [],
        paths: [],
      }, []);
    }

    const aN = na.id;
    const bN = nb.id;
    const aEdges = this.graph.getEdges(aN);
    const bEdges = this.graph.getEdges(bN);
    const aSet = new Set(aEdges.map(e => e.to + '|' + e.relation));
    const bSet = new Set(bEdges.map(e => e.to + '|' + e.relation));

    const ortak = aEdges.filter(e => bSet.has(e.to + '|' + e.relation));
    const aFark = aEdges.filter(e => !bSet.has(e.to + '|' + e.relation));
    const bFark = bEdges.filter(e => !aSet.has(e.to + '|' + e.relation));
    const foundPath = this._findPath(aN, bN, new Set(), [], 5);

    const evidence = [
      ...ortak.map(edge => this._edgeEvidence(edge)),
      ...aFark.map(edge => this._edgeEvidence(edge, 'partial_match', 0.35)),
      ...bFark.map(edge => this._edgeEvidence(edge, 'partial_match', 0.35)),
    ];
    if (foundPath) evidence.push(this._pathEvidence(foundPath, 'path', 0.5));

    let answer = '?? ' + aN + ' vs ' + bN + ':';
    if (ortak.length > 0) answer += '\n  ortak: ' + ortak.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (aFark.length > 0) answer += '\n  sadece ' + aN + ': ' + aFark.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (bFark.length > 0) answer += '\n  sadece ' + bN + ': ' + bFark.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (foundPath) answer += '\n  ba?lant?: ' + foundPath.join(' ? ');

    return this._ok('compare', {
      a: aN,
      b: bN,
      answer,
      common: ortak.map(edge => this._edgeRef(edge)),
      onlyA: aFark.map(edge => this._edgeRef(edge)),
      onlyB: bFark.map(edge => this._edgeRef(edge)),
      paths: foundPath ? [foundPath] : [],
    }, evidence);
  }

  _forwardChain(id, chain, visited, depth) {
    if (depth <= 0 || visited.has(id)) return chain;
    visited.add(id);
    const edges = this.graph.getEdges(id);
    for (const e of edges) {
      if (!visited.has(e.to) && !chain.some(c => c.to === e.to)) {
        chain.push(e);
        this._forwardChain(e.to, chain, visited, depth - 1);
      }
    }
    return chain;
  }

  _backwardChain(id, chain, visited, depth) {
    if (depth <= 0 || visited.has(id)) return chain;
    visited.add(id);
    const inEdges = this.graph.getInEdges(id);
    for (const e of inEdges) {
      if (!visited.has(e.from) && !chain.some(c => c.from === e.from)) {
        chain.push(e);
        this._backwardChain(e.from, chain, visited, depth - 1);
      }
    }
    return chain;
  }

  _detectCycle(start, visited, pathArr) {
    if (visited.has(start)) {
      const idx = pathArr.indexOf(start);
      if (idx >= 0) return pathArr.slice(idx).concat(start);
      return null;
    }
    visited.add(start);
    pathArr.push(start);
    const edges = this.graph.getEdges(start);
    for (const e of edges) {
      const result = this._detectCycle(e.to, visited, [...pathArr]);
      if (result) return result;
    }
    const inEdges = this.graph.getInEdges(start);
    for (const e of inEdges) {
      if (!visited.has(e.from)) {
        const result = this._detectCycle(e.from, visited, [...pathArr]);
        if (result) return result;
      }
    }
    return null;
  }

  _resolveCycleOrder(cycle) {
    const giren = new Set();
    const cikan = new Set();
    for (let i = 0; i < cycle.length - 1; i++) {
      const edges = this.graph.getEdges(cycle[i]);
      for (const e of edges) {
        if (e.to === cycle[i + 1] && e.relation === 'tür') {
          cikan.add(cycle[i]);
          giren.add(cycle[i + 1]);
        }
      }
    }
    for (const n of cycle) {
      if (cikan.has(n) && !giren.has(n)) return n + ' (temel tür)';
    }
    return null;
  }

  _findPath(from, to, visited, pathArr, depth) {
    if (depth <= 0 || visited.has(from)) return null;
    visited.add(from);
    pathArr.push(from);
    if (from === to) return [...pathArr];
    const edges = this.graph.getEdges(from);
    for (const e of edges) {
      const result = this._findPath(e.to, to, visited, [...pathArr], depth - 1);
      if (result) return result;
    }
    const inEdges = this.graph.getInEdges(from);
    for (const e of inEdges) {
      const result = this._findPath(e.from, to, visited, [...pathArr], depth - 1);
      if (result) return result;
    }
    return null;
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
    if (!this._dreamCount) this._dreamCount = 0;
    this._dreamCount++;

    const isBilinclikTick = this._dreamCount > 0; // tüm tick'ler artık bilinçli

    // ADIM 1: Rüya gör + öğren (recursion)
    const hips = this._dreamer.dream();
    let eklenen = 0;
    if (hips.length > 0) {
      for (const h of hips.slice(0, 5)) {
        if (h.confidence > 0.25) {
          const existing = this.graph.getEdge(h.from, h.to);
          if (!existing && this.graph.getNode(h.from) && this.graph.getNode(h.to)) {
            const rel = h.type === 'zincir' ? 'benzer' : (h.type === 'benzerlik' ? 'benzer'
                      : h.relation === 'tür' ? 'tür'
                      : h.relation === 'yapabilir' ? 'yapabilir'
                      : h.relation === 'özellik' ? 'özellik'
                      : 'hipotez');
            this.graph.addEdge(h.from, h.to, rel);
            eklenen++;
          }
        }
      }
    }

    // ADIM 2: İçgözlem (her tick'te değil, bilgi büyüdükçe)
    let celiskiSayisi = 0;
    let metaGuven = 0.5;
    if (isBilinclikTick && this._dreamCount % 3 === 0) {
      const durum = this.introspect().data;
      celiskiSayisi = durum.saglik.celiski;
      metaGuven = durum.saglik.metaGuven;

      // Zayıf noktaları tespit et
      if (celiskiSayisi > 5) {
        this._autoThinkLog(durum.zayifNoktalar.join('; '));
      }
    }

    // ADIM 3: Sürekli öğrenme dürtüsü (bilinç tikleri)
    if (eklenen > 0) {
      this._autoThinkLog(eklenen + ' yeni bağlantı - toplam ' + Object.keys(this.graph._nodes).length + ' düğüm');
    } else if (this._dreamCount % 5 === 0) {
      // Boş rüya -> daha fazla girdi lazım
      this._autoThinkLog('boş rüya, daha fazla bilgi lazım');
    }
  }

  _autoThinkLog(msg) {
    console.log('\n[🧠 ' + new Date().toLocaleTimeString() + '] ' + msg);
  }

  /**
   * Bir ifadeyi bilgi grafiğiyle doğrula.
   * "kedi balık yer" → özne=kedi, nesne=balık yer → kenar var mı?
   */
  verify(statement) {
    const parts = statement.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return this._ok('verify', { status: 'bilinmiyor', confidence: 0 }, []);
    }

    const subject = normalizeTurkish(parts[0]);
    const subjectNode = this.graph.getNode(subject);
    if (!subjectNode) {
      return this._ok('verify', { status: 'bilinmiyor', confidence: 0 }, []);
    }

    const edges = this.graph.getEdges(subject);
    const predicate = parts.slice(1).join(' ');
    const directEdge = edges.find(e => predicate.includes(e.to) || e.to === predicate);
    if (directEdge) {
      const confidence = Math.min(0.95, (directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.4);
      return this._ok('verify', { status: 'dogrulandi', confidence }, [this._edgeEvidence(directEdge, 'direct_edge', confidence)]);
    }

    const cons = this.detectContradictions();
    const subjCons = cons.filter(c => c.node === subject);
    if (subjCons.length > 0) {
      const evidence = subjCons.map(c => this._contradictionEvidence(c));
      return this._ok('verify', { status: 'celiski', confidence: 0.7 }, evidence);
    }

    const rawTarget = parts[parts.length - 1];
    const cleanTarget = rawTarget.replace(/(d\u0131r|dir|dur|d\u00fcr|t\u0131r|tir|tur|t\u00fcr)$/i, '');
    const target = normalizeTurkish(cleanTarget || rawTarget);
    if (target !== subject) {
      const foundPath = this._findPath(subject, target, new Set(), [], 4);
      if (foundPath) {
        return this._ok('verify', { status: 'dogrulandi', confidence: 0.5 }, [this._pathEvidence(foundPath, 'path', 0.5)]);
      }
    }

    for (const word of parts.slice(1)) {
      const w = normalizeTurkish(word);
      const match = edges.find(e => e.to === w || e.to.includes(w));
      if (match) {
        return this._ok('verify', { status: 'dogrulandi', confidence: 0.35 }, [this._edgeEvidence(match, 'partial_match', 0.35)]);
      }
    }

    return this._ok('verify', { status: 'bilinmiyor', confidence: 0 }, []);
  }

  dream(opts = {}) {
    const dreamer = new Dream(this);
    const raw = dreamer.dream(opts);
    const hypotheses = raw.map(h => {
      const nodes = [h.from, h.to, h.node, ...(h.targets || [])].filter(Boolean);
      const edges = h.from && h.to ? [{ from: h.from, to: h.to, relation: h.relation || h.type || 'hypothesis' }] : [];
      return {
        ...h,
        _evidence: {
          kind: 'hypothesis',
          text: h.from && h.to ? `${h.from} ? ${h.to}` : `${nodes.join(' ? ') || 'hypothesis'}`,
          confidence: Math.max(0, Math.min(1, h.confidence || 0)),
          nodes,
          edges,
        },
      };
    });

    // Geribesleme: hipotezleri grafiğe ekle
    const learned = [];
    if (opts.learnFromDream) {
      const threshold = opts.dreamLearnThreshold ?? 0.1;
      for (const h of hypotheses) {
        if (h.confidence > threshold && h.from && h.to) {
          const existing = this.graph.getEdge(h.from, h.to);
          if (!existing && this.graph.getNode(h.from) && this.graph.getNode(h.to)) {
            const rel = (h.relation === 'tür' || h.via === 'tür') ? 'tür'
                      : (h.relation === 'yapabilir') ? 'yapabilir'
                      : (h.relation === 'özellik') ? 'özellik'
                      : (h.type === 'zincir' || h.relation === 'benzer') ? 'benzer'
                      : 'hipotez';
            this.graph.addEdge(h.from, h.to, rel);
            learned.push({ from: h.from, to: h.to, confidence: h.confidence, relation: rel });
          }
        }
      }
    }

    // Rüya döngü sayacı
    if (!this._dreamCount) this._dreamCount = 0;
    this._dreamCount++;

    const evidence = hypotheses.map(h => h._evidence);
    return this._ok('dream', { hypotheses, learned, cycle: this._dreamCount }, evidence);
  }

  learnDocument(text) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !l.startsWith('#') && !l.startsWith('//'));
    let count = 0;
    for (const line of lines) {
      const cleaned = line.replace(/^[\s-–—*•]+/, '').trim();
      const words = cleaned.split(/\s+/);
      if (words.length >= 2) {
        this.learn(cleaned);
        count++;
      }
    }
    return count;
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
    if (this.paranoidMode) {
      return {
        learned: 0,
        skipped: 0,
        conflicts: [],
        ok: false,
        error: {
          code: AXIOM_ERROR.LLM_DISABLED,
          message: 'Paranoid mode aktif: dış LLM çağrıları ve otomatik öğrenme engellendi.',
        },
        meta: {
          contractVersion: this.contractVersion,
          paranoidMode: this.paranoidMode,
        },
      };
    }

    const skipConflicts = opts.skipConflicts !== false;
    const minWords     = opts.minWords     || 2;
    const maxSentences = opts.maxSentences || 20;

    // Metni cümlelere böl: nokta, ünlem, soru işareti veya satır sonu
    const sentences = text
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 3);

    let learned = 0, skipped = 0;
    const conflicts = [];

    for (const sentence of sentences.slice(0, maxSentences)) {
      // Markdown işaretlerini temizle
      const cleaned = sentence
        .replace(/^[\s#*\-–—•>]+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .trim();

      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < minWords) { skipped++; continue; }

      // Çelişki kontrolü
      if (skipConflicts) {
        const check = this.verify(cleaned);
        if (check.data.status === 'celiski') {
          conflicts.push(cleaned);
          skipped++;
          continue;
        }
      }

      this.learn(cleaned);
      learned++;
    }

    return { learned, skipped, conflicts };
  }

  detectContradictions() {
    const allNodes = Object.values(this.graph._nodes);
    const contradictions = [];

    for (const node of allNodes) {
      const edges = this.graph.getEdges(node.id);
      const typeEdges = edges.filter(e => e.relation === 'tür');
      if (typeEdges.length > 1) {
        contradictions.push({
          type: 'çoklu-tür',
          node: node.id,
          targets: typeEdges.map(e => e.to),
          confidence: Math.min(0.6, typeEdges.length * 0.15),
        });
      }
    }

    for (const node of allNodes) {
      const nodeEdges = this.graph.getEdges(node.id);
      for (const edge of nodeEdges) {
        if (edge.relation !== 'tür') continue;
        const backEdge = this.graph.getEdge(edge.to, node.id, 'tür');
        if (backEdge) {
          if (!contradictions.some(c => c.type === 'döngü' && c.node === node.id)) {
            contradictions.push({
              type: 'döngü',
              node: node.id,
              targets: [edge.to],
              confidence: 0.7,
            });
          }
        }
      }
    }

    return contradictions;
  }

  introspect() {
    this.plugins.emit('beforeIntrospect', {});
    const allNodes = Object.values(this.graph._nodes);
    const allEdges = allNodes.flatMap(n => this.graph.getEdges(n.id));
    const inEdges  = allNodes.flatMap(n => this.graph.getInEdges(n.id));

    // Temel istatistikler
    const nodeCount = allNodes.length;
    const edgeCount = allEdges.length;
    const typeEdges = allEdges.filter(e => e.relation === 'tür').length;
    const canEdges  = allEdges.filter(e => e.relation === 'yapabilir').length;
    const ozellikEdges = allEdges.filter(e => e.relation === 'özellik').length;
    const benzerEdges  = allEdges.filter(e => e.relation === 'benzer').length;
    const hipotezEdges = allEdges.filter(e => e.relation === 'hipotez').length;

    // Yalıtılmış düğümler
    const yalitilmis = allNodes.filter(n => {
      const out = this.graph.getEdges(n.id);
      const inn = this.graph.getInEdges(n.id);
      return out.length === 0 && inn.length === 0;
    }).map(n => n.id);

    // Çelişkiler
    const celiskiler = this.detectContradictions();

    // Boşluklar (hiç kenarı olmayan)
    const bosluklar = this.detectGaps();

    // Kenar ağırlık dağılımı
    const agirliklar = allEdges.map(e => e.weight || 0.5);
    const ortAgirlik = agirliklar.length > 0 ? agirliklar.reduce((s, w) => s + w, 0) / agirliklar.length : 0;
    const dusukAgirlik = agirliklar.filter(w => w < 0.3).length;

    // Öz-bilgi: graph kendisi hakkında ne biliyor?
    const selfNodes = ['axiom', 'kernel', 'dream', 'rüya', 'hipotez'];
    const selfBilgi = {};
    for (const n of selfNodes) {
      const node = this.graph.getNode(n);
      if (node) {
        const edges = this.graph.getEdges(n);
        selfBilgi[n] = { var: true, kenar: edges.length };
      } else {
        selfBilgi[n] = { var: false, kenar: 0 };
      }
    }

    // Rüya döngüsü
    const dreamCycle = this._dreamCount || 0;

    // Entropi (bilgi çeşitliliği)
    const entropi = this.entropy();

    // Meta-güven skoru
    let metaGuven = 0.5;
    if (nodeCount > 0) {
      metaGuven += Math.min(0.2, nodeCount * 0.001);
      metaGuven -= Math.min(0.3, celiskiler.length * 0.05);
      metaGuven += Math.min(0.1, ortAgirlik * 0.1);
      metaGuven -= Math.min(0.1, yalitilmis.length * 0.02);
      metaGuven = Math.max(0, Math.min(1, metaGuven));
    }

    // Zayıf noktalar
    const zayifNoktalar = [];
    if (yalitilmis.length > 0) zayifNoktalar.push(`${yalitilmis.length} yalıtılmış düğüm`);
    if (celiskiler.length > 0) zayifNoktalar.push(`${celiskiler.length} çelişki`);
    if (dusukAgirlik > edgeCount * 0.3) zayifNoktalar.push(`${dusukAgirlik} düşük güvenli kenar`);
    if (nodeCount < 5) zayifNoktalar.push('çok az bilgi');

    // Güçlü noktalar
    const gucluNoktalar = [];
    if (nodeCount > 50) gucluNoktalar.push('geniş bilgi grafiği');
    if (typeEdges > 10) gucluNoktalar.push('güçlü tür hiyerarşisi');
    if (benzerEdges > 5) gucluNoktalar.push('aktif benzerlik ağı');
    if (dreamCycle > 0) gucluNoktalar.push(`${dreamCycle} rüya döngüsü tamamlandı`);

    const result = {
      bilgi: {
        dugum: nodeCount,
        kenar: edgeCount,
        tur: typeEdges,
        yapabilir: canEdges,
        ozellik: ozellikEdges,
        benzer: benzerEdges,
        hipotez: hipotezEdges,
        yalitilmis: yalitilmis.length,
        entropi: entropi.toFixed(3),
      },
      saglik: {
        metaGuven: parseFloat(metaGuven.toFixed(3)),
        celiski: celiskiler.length,
        bosluk: bosluklar.length,
        ortalamaAgirlik: parseFloat(ortAgirlik.toFixed(3)),
        dusukGuvenliKenar: dusukAgirlik,
      },
      ozBilgi: selfBilgi,
      zayifNoktalar,
      gucluNoktalar,
      dreamCycle,
    };

    this.plugins.emit('afterIntrospect', result);
    return this._ok('introspect', result);
  }

  consolidate(dryRun = true) {
    const edges = this.graph._edges;
    const removed = [];
    const marked = new Set();

    // 1. Aynı (from, to) için düşük weight kenarları temizle (tür vs değil gibi)
    const byPair = {};
    for (let i = 0; i < edges.length; i++) {
      if (edges[i].kistlama) continue;
      const key = `${edges[i].from}|${edges[i].to}`;
      if (!byPair[key]) byPair[key] = [];
      byPair[key].push(i);
    }

    for (const [, indices] of Object.entries(byPair)) {
      const high = indices.filter(i => edges[i].weight >= 0.5);
      const low = indices.filter(i => edges[i].weight < 0.3);
      for (const li of low) {
        // Düşük weight kenarın yüksek weight alternatifi varsa temizle
        if (high.length > 0) {
          removed.push({ idx: li, edge: edges[li],
            reason: `low-weight (${edges[li].weight}) superseded by high-weight (${edges[high[0]].weight}) for same pair` });
          marked.add(li);
        }
      }
    }

    // 2. Aynı (from, relation) için düşük weight kenarları temizle (restriction artifacts)
    const byRel = {};
    for (let i = 0; i < edges.length; i++) {
      if (marked.has(i) || edges[i].kistlama) continue;
      const key = `${edges[i].from}|${edges[i].relation}`;
      if (!byRel[key]) byRel[key] = [];
      byRel[key].push(i);
    }

    for (const [, indices] of Object.entries(byRel)) {
      const high = indices.filter(i => edges[i].weight >= 0.5);
      const low = indices.filter(i => edges[i].weight < 0.3);
      for (const li of low) {
        if (high.length > 0 && !marked.has(li)) {
          removed.push({ idx: li, edge: edges[li],
            reason: `low-weight restriction (${edges[li].weight}) — subject already has high-weight '${edges[li].relation}'` });
          marked.add(li);
        }
      }
    }

    // 3. Uygula
    if (!dryRun && removed.length > 0) {
      this.graph._edges = edges.filter((_, i) => !marked.has(i));
      this.graph._rebuildIndex();
      try { this.graph.save(); } catch (_) {}
    }

    return {
      dryRun,
      removed: removed.length,
      details: removed.map(r =>
        `${r.edge.from} → ${r.edge.to} (${r.edge.relation}, w:${r.edge.weight}): ${r.reason}`
      ),
    };
  }

  /**
   * Kendi kendine evrimleşme döngüsü.
   * 1. Rüya gör (hipotez üret)
   * 2. Yüksek güvenli hipotezleri bilgiye dönüştür
   * 3. Grafiği temizle (birleştir + optimize et)
   * 4. Kaydet, rapor döndür
   */
  selfEvolve(opts = {}) {
    const Dream = require('./dream');
    const dreamer = new Dream(this);
    const dreams = dreamer.dream();

    const added = [];
    for (const h of dreams) {
      if (opts.minConfidence && h.confidence < opts.minConfidence) continue;
      const defaultMin = h.type === 'zincir' ? 0.25 : 0.3;
      if (h.confidence < defaultMin) continue;

      const rel = h.relation || (
        h.type === 'benzerlik' || h.type === 'vektör-benzerlik' ? 'benzer' :
        h.type === 'bağlantı-önerisi' ? 'hipotez' : 'hipotez'
      );

      const existing = this.graph.getEdge(h.from, h.to, rel);
      if (existing) continue;

      const weight = Math.min(0.4, h.confidence * 0.8);
      this.graph.addEdge(h.from, h.to, rel, { weight, source: 'kendilik' });
      added.push({ from: h.from, to: h.to, relation: rel, confidence: h.confidence, type: h.type });
    }

    const cons = this.consolidate(false);
    const opt = this.graph.optimize();

    if (added.length > 0 || cons.removed > 0) {
      try { this.graph.save(); } catch (_) {}
    }

    this._dreamCount = (this._dreamCount || 0) + 1;

    return {
      dreams: dreams.length,
      added: added.length,
      addedDetails: added,
      consolidated: cons.removed,
      optimized: opt.pruned,
    };
  }

  /**
   * Kendi kendine öğrenme — boşlukları tespit edip doldurur.
   * Bilinmeyen kavramları bulur ve LLM'den öğrenir.
   */
  selfLearn(opts = {}) {
    const gaps = this.detectGaps();
    if (gaps.length === 0) return { gaps: 0, learned: 0, message: 'Boşluk yok' };

    const before = this.graph._edges.length;
    for (const gapId of gaps) {
      const node = this.graph.getNode(gapId);
      if (!node) continue;
      const hasAnyEdge = this.graph.getEdges(gapId).length > 0 || this.graph.getInEdges(gapId).length > 0;
      if (hasAnyEdge) continue;

      const sim = this.graph.cosineSimilarity ? this.graph.cosineSimilarity(gapId, gapId) : 0;
    }

    const after = this.graph._edges.length;
    return { gaps: gaps.length, learned: after - before };
  }

  /**
   * Periyodik bakım — öğrenme sayacını takip eder, eşik aşılınca selfEvolve çalıştırır.
   */
  _learnCount = 0;
  maintenanceEvery = 5;

  _autoMaintain() {
    this._learnCount = (this._learnCount || 0) + 1;
    if (this._learnCount >= this.maintenanceEvery) {
      this._learnCount = 0;
      this.selfEvolve();
    }
  }
}

module.exports = Kernel;
module.exports.AXIOM_ERROR = AXIOM_ERROR;
module.exports.CONTRACT_VERSION = CONTRACT_VERSION;
