const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');
const Dream = require('./dream');
const LLMAdapter = require('./llmAdapter');
const fs = require('fs');

function createKernel(opts = {}) {
  const { version, ...kernelOpts } = opts || {};
  const selected = version || process.env.AXIOM_KERNEL_VERSION;
  return selected === 'v2' ? new KernelV2(kernelOpts) : new Kernel(kernelOpts);
}

class CLI {
  constructor(opts = {}) {
    this.kernel = opts.kernelInstance || createKernel(opts.kernel || {});
    this.dream = new Dream(this.kernel);
    this.llm = new LLMAdapter();
  }

  parse(input) {
    const raw = input.trim();
    const trimmed = raw.toLowerCase();

    if (trimmed.startsWith('öğret:')) {
      return { command: 'öğret', args: raw.slice(6).trim() };
    }
    if (trimmed.startsWith('llm-sor:')) {
      return { command: 'llm-sor', args: raw.slice(8).trim() };
    }
    if (trimmed.startsWith('yükle:')) {
      return { command: 'yükle', args: raw.slice(6).trim() };
    }
    if (trimmed.startsWith('sor:')) {
      return { command: 'sor', args: raw.slice(4).trim() };
    }
    if (['durum', 'durum nedir', 'ne durumdasın', 'nasılsın', 'durum raporu'].includes(trimmed)) {
      return { command: 'durum', args: '' };
    }
    if (['rüya', 'rüya gör', 'hayal kur', 'ne düşünüyorsun'].includes(trimmed)) {
      return { command: 'rüya', args: '' };
    }
    if (['kaydet', 'hafızayı kaydet'].includes(trimmed)) {
      return { command: 'kaydet', args: '' };
    }
    if (['açık düşün', 'sürekli düşün', 'otomatik düşün', 'auto think', 'düşünmeye başla'].includes(trimmed)) {
      return { command: 'düşün', args: 'başla' };
    }
    if (['dur düşünme', 'düşünmeyi durdur', 'sus', 'sakin ol'].includes(trimmed)) {
      return { command: 'düşün', args: 'dur' };
    }
    if (['çıkış', 'kapat', 'güle güle', 'bb'].includes(trimmed)) {
      return { command: 'çıkış', args: '' };
    }
    if (['merhaba', 'selam', 'hey'].includes(trimmed)) {
      return { command: 'selam', args: '' };
    }
    if (['ne yapabilirsin', 'yardım', 'help', 'komutlar'].includes(trimmed)) {
      return { command: 'yardım', args: '' };
    }
    if (['optimize', 'temizle', 'hafızayı optimize et'].includes(trimmed)) {
      return { command: 'optimize', args: '' };
    }

    // "neden X" → sebep analizi
    const nedenMatch = trimmed.match(/^neden\s+(.+)/i);
    if (nedenMatch) {
      return { command: 'neden', args: nedenMatch[1] };
    }

    // "X ile Y arasında" → karşılaştır
    const compareMatch = trimmed.match(/(.+?)\s+(ile|vs|ve)\s+(.+?)\s+(arasında|arasındaki fark|karşılaştır)/i);
    if (compareMatch) {
      return { command: 'karşılaştır', args: compareMatch[1] + '|' + compareMatch[3] };
    }

    // "X mı Y mı" → karşılaştır
    const miMatch = trimmed.match(/^(.+?)\s+(mı|mi|mu|mü)\s+(.+?)\s+(mı|mi|mu|mü)/i);
    if (miMatch) {
      const a = miMatch[1].trim();
      const b = miMatch[3].trim();
      if (a && b && a !== b) {
        return { command: 'karşılaştır', args: a + '|' + b };
      }
    }

    // Soru kelimeleri → sor
    const sorKelimeler = /\b(nedir|kimdir|nasıl|nerede|nereden|nereye|niçin|niye|kaç|hangi|mı\b|mi\b|mu\b|mü\b)\b/i;
    if (sorKelimeler.test(trimmed)) {
      return { command: 'sor', args: trimmed };
    }

    // 2+ kelime → öğret
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length >= 2) {
      return { command: 'öğret', args: trimmed };
    }

    return { command: 'anlamadım', args: '' };
  }

  execute(command, args) {
    switch (command) {
      case 'öğret': {
        this.kernel.learn(args);
        const subject = args.toLowerCase().split(/\s+/)[0];
        return `✅ "${subject}" öğrendim.`;
      }
      case 'sor': {
        const result = this.kernel.ask(args);
        const cevap = result.data.answer;
        return cevap === 'Bilmiyorum' ? `\u274c ${cevap}` : `\u{1F4AC} ${cevap}`;
      }
      case 'neden': {
        const result = this.kernel.reason(args);
        const cevap = result.data.answer;
        return cevap === 'Bilmiyorum' ? `\u274c ${cevap}` : `\u{1F50D} ${cevap}`;
      }
      case 'kar\u015f\u0131la\u015ft\u0131r': {
        const parts = args.split('|');
        const result = this.kernel.compare(parts[0].trim(), parts[1].trim());
        const cevap = result.data.answer;
        return cevap === 'Bilmiyorum' ? `\u274c ${cevap}` : `\u{1F4CA} ${cevap}`;
      }
      case 'llm-sor': {
        // execute() is sync, so it returns AXIOM's local check only.
        const axiomResult = this.kernel.ask(args);
        const axiomCevap = axiomResult.data.answer;
        const dogrulamaResult = this.kernel.verify(args);
        const dogrulama = dogrulamaResult.data;
        const statusEmoji = { dogrulandi: '\u2705', celiski: '\u26A0\uFE0F', bilinmiyor: '\u2753' };
        const emoji = statusEmoji[dogrulama.status] || '\u2753';
        let out = `\u{1F916} AXIOM do\u011frulamas\u0131: ${emoji} ${dogrulama.status} (g\u00fcven: ${dogrulama.confidence.toFixed(2)})`;
        if (axiomCevap !== 'Bilmiyorum') out += `\n\u{1F4AC} AXIOM: ${axiomCevap}`;
        if (dogrulamaResult.evidence.length > 0) out += `\n\u{1F4CE} Kan\u0131t: ${dogrulamaResult.evidence[0].text}`;
        out += `\n\u23F3 LLM yan\u0131t\u0131 i\u00e7in: ollama run ${this.llm.model} "${args}"`;
        return out;
      }
      case 'yükle': {
        try {
          const text = fs.readFileSync(args, 'utf-8');
          const count = this.kernel.learnDocument(text);
          return `📄 "${args}" dosyasından ${count} bilgi öğrenildi.`;
        } catch (e) {
          return '❌ Dosya okunamadı: ' + e.message;
        }
      }
      case 'düşün': {
        if (args === 'dur') {
          this.kernel.stopAutoThink();
          return '🧘 Düşünmeyi durdurdum.';
        }
        this.kernel.startAutoThink(15000);
        return '🧠 Arka planda düşünmeye başladım (15sn aralıkla). "dur düşünme" ile durdurabilirsin.';
      }
      case 'optimize': {
        const result = this.kernel.graph.optimize();
        return `🧹 Optimize: ${result.pruned} kenar budandı, ${result.removedNodes} düğüm silindi.`;
      }
      case 'durum': {
        const nodes = Object.keys(this.kernel.graph._nodes).length;
        const edges = this.kernel.graph._edges.length;
        const entropy = this.kernel.entropy();
        const gaps = this.kernel.detectGaps();
        const cons = this.kernel.detectContradictions();
        let out = `📊 Durum: ${nodes} düğüm, ${edges} kenar, entropi: ${entropy.toFixed(3)}`;
        if (gaps.length > 0) out += `\n  ⚠️  ${gaps.length} bağlantısız düğüm: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''}`;
        if (cons.length > 0) {
          for (const c of cons.slice(0, 5)) {
            out += `\n  🔄 Çelişki [${c.type}]: ${c.node} → ${c.targets.join(', ')}`;
          }
        }
        return out;
      }
      case 'rüya': {
        const hypotheses = this.dream.dream();
        if (hypotheses.length === 0) {
          return '💭 Hipotez üretemedim, daha fazla bilgiye ihtiyacım var.';
        }
        const lines = hypotheses.map(h =>
          `  ${h.from} → ${h.to} (${h.type}, güven: ${h.confidence.toFixed(2)})`
        );
        return `💭 ${hypotheses.length} hipotez:\n${lines.join('\n')}`;
      }
      case 'selam': {
        return '👋 Merhaba! Bana bir şey öğretebilir veya soru sorabilirsin.';
      }
      case 'yardım': {
        return [
          '🧠 AXIOM - Doğal dil ile konuş benimle.',
          '  "kedi balık yer"          → bilgi öğrenirim',
          '  "kedi nedir"              → sorunu cevaplarım',
          '  "neden tavuk"             → sebep analizi',
          '  "tavuk mu yumurta mı"     → karşılaştırma',
          '  "durum" / "nasılsın"      → durumumu gösteririm',
          '  "rüya" / "ne düşünüyorsun"→ hipotez üretirim',
          '  "açık düşün"              → arka planda öğrenirim',
          '  "optimize"                → hafızayı temizlerim',
          '  "kaydet"                  → hafızayı kaydederim',
          '  "llm-sor: soru"           → LLM\'ye sor (Ollama)',
          '  "yükle: dosya.txt"        → .txt/.md dosyasından öğren',
          '  "çıkış" / "bb"            → güle güle',
        ].join('\n');
      }
      case 'anlamadım': {
        return '🤔 Anlamadım. Daha uzun bir cümle yaz veya "yardım" yaz.';
      }
      default:
        return '❌ Bilinmeyen komut.';
    }
  }

  start() {
    const readline = require('readline');
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      prompt: 'axiom> ',
    });

    console.log('🧠 AXIOM - Doğal dil ile konuş, öğret, sor');
    console.log('  "kedi balık yer"       | Bilgi öğret');
    console.log('  "kedi nedir"           | Soru sor');
    console.log('  "neden tavuk"          | Sebep analizi');
    console.log('  "tavuk mu yumurta mı"  | Karşılaştır');
    console.log('  "durum" / "nasılsın"   | Sistem durumu');
    console.log('  "açık düşün"           | Arka planda öğren');
    console.log('  "rüya"                 | Hipotez üret');
    console.log('  "optimize"             | Hafızayı temizle');
    console.log('  "llm-sor: soru"        | LLM\'ye sor (Ollama)');
    console.log('  "yükle: dosya.txt"     | .txt/.md dosyasından öğren');
    console.log('  "yardım"               | Komutlar');
    console.log('  "çıkış"                | Çıkış\n');

    rl.prompt();

    rl.on('line', async (line) => {
      const parsed = this.parse(line);
      if (parsed.command === 'kaydet') {
        this.kernel.graph.save();
        console.log('💾 Hafıza kaydedildi.');
      } else if (parsed.command === 'çıkış') {
        this.kernel.graph.save();
        console.log('💾 Hafıza kaydedildi. Güle güle.');
        rl.close();
        return;
      } else if (parsed.command === 'llm-sor') {
        // 1. AXIOM pre-check
        const dogrulamaResult = this.kernel.verify(parsed.args);
        const dogrulama = dogrulamaResult.data;
        const statusEmoji = { dogrulandi: '\u2705', celiski: '\u26A0\uFE0F', bilinmiyor: '\u2753' };
        console.log(`\u{1F50D} AXIOM: ${statusEmoji[dogrulama.status]} ${dogrulama.status} (g\u00fcven: ${dogrulama.confidence.toFixed(2)})`);
        if (dogrulamaResult.evidence.length > 0) console.log(`   Kan\u0131t: ${dogrulamaResult.evidence[0].text}`);
        // 2. LLM'ye sor
        console.log(`🤖 LLM'ye soruyorum (${this.llm.provider}/${this.llm.model})...`);
        const llmRes = await this.llm.ask(parsed.args);

        if (!llmRes.ok) {
          console.log(`❌ LLM hatası: ${llmRes.error}`);
          console.log(`   İpucu: Ollama çalışıyor mu? → ollama serve && ollama pull ${this.llm.model}`);
        } else {
          const llmText = llmRes.data.text;
          console.log(`\n💬 LLM: ${llmText}\n`);

          // 3. Verify LLM answer with AXIOM
          const llmCheckResult = this.kernel.verify(llmText.slice(0, 300));
          const llmCheck = llmCheckResult.data;
          if (llmCheck.status === 'celiski') {
            console.log(`\u26A0\uFE0F  AXIOM \u00e7eli\u015fki tespit etti: ${llmCheckResult.evidence[0]?.text || 'kan\u0131t yok'}`);
            console.log(`   Bu yan\u0131t haf\u0131zaya eklenmeyecek.`);
          } else if (llmCheck.status === 'dogrulandi') {
            console.log(`\u2705 AXIOM do\u011frulad\u0131 (g\u00fcven: ${llmCheck.confidence.toFixed(2)})`);
          }
          // 4. Otomatik öğren — çelişki yoksa
          if (llmCheck.status !== 'celiski') {
            const result = this.kernel.learnFromLLM(llmText, { skipConflicts: true, maxSentences: 15 });
            if (result.error) {
              console.log(`⛔ ${result.error.code}: ${result.error.message}`);
            } else if (result.learned > 0) {
              this.kernel.graph.save();
              console.log(`📚 ${result.learned} yeni bilgi hafızaya eklendi.`);
              if (result.conflicts.length > 0) {
                console.log(`   ⚠️  ${result.conflicts.length} çelişkili cümle atlandı.`);
              }
            }
          }
        }
      } else {
        const result = this.execute(parsed.command, parsed.args);
        console.log(result);
      }
      rl.prompt();
    });

    rl.on('close', () => process.exit(0));
  }
}

if (require.main === module) {
  const cli = new CLI();
  cli.kernel.graph.load();
  cli.start();
}

module.exports = CLI;
module.exports.createKernel = createKernel;
