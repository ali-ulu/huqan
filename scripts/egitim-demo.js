// AXIOM demo: Türkçe kimlik külliyatını izole bir demo grafına işler.
//
// #363 (security): bu script kök dizinde egitim.js olarak duruyor ve npm
// paketinin "files" listesinde yayınlanıyordu. Yanlışlıkla çalıştırılırsa:
//   (a) demo tohumu admission bypass ile öğreniliyor,
//   (b) k.graph.save() çağrısı çalışma dizinindeki production memory.json'u eziyor,
//   (c) tüm mantık modül üst seviyesinde çalıştığı için yalnızca require()
//       edilmesi bile demo'yu koşturuyordu.
//
// Şimdi:
//   - scripts/ altında (npm "files" kapsamı dışında),
//   - yalnızca HUQAN_DEMO_MODE=1 veya `--demo` ile opt-in,
//   - yalnızca giriş modülü olarak çalışıyor (require etmek yan etkisiz),
//   - varsayılan olarak geçici/izole bir dizine yazar; production memory
//     (CWD memory.json / HUQAN_MEMORY_PATH) asla hedeflenmez.
'use strict';

const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('../lib/environment-compat');
validateEnvironmentCompatibility();

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');
const Dream = require('../dream');

const IDENTITY_SEED_PATH = path.join(__dirname, '..', 'docs', 'seed', 'axiom-identity.seed.json');
const DEMO_BYPASS_REASON = 'egitim demo seed';

// #363: izole dizin. Production memory'nin bulunduğu yere hiçbir koşulda
// dokunmaz; yalnızca açık `--persist-dir` flag'ı hedefi değiştirir.
function defaultPersistDir() {
  return path.join(os.tmpdir(), 'huqan-egitim-demo', String(process.pid));
}

// Opt-in demo modu: HUQAN_DEMO_MODE=1 ortam değişkeni VEYA açık `--demo` flag'ı.
function isDemoRequested(argv = process.argv.slice(2), env = process.env) {
  return readCompatibleEnvironmentVariable('DEMO_MODE', env) === '1' || argv.includes('--demo');
}

function resolvePersistDir(argv = process.argv.slice(2), cwd = process.cwd()) {
  const flagIndex = argv.indexOf('--persist-dir');
  if (flagIndex !== -1 && argv[flagIndex + 1]) {
    return path.resolve(cwd, argv[flagIndex + 1]);
  }
  return defaultPersistDir();
}

function loadIdentityFacts() {
  return JSON.parse(fs.readFileSync(IDENTITY_SEED_PATH, 'utf8'));
}

// Kimlik tohumu + statik Türkçe külliyat. Metinler orijinal egitim.js ile
// birebir aynıdır (UTF-8).
function buildDemoCorpus(identitySeed) {
  const identityFacts = Array.isArray(identitySeed.facts) ? identitySeed.facts.filter(Boolean) : [];
  const veriler = [
    ...identityFacts,

    // Mantik
    'her A Bdir',
    'bazı A Bdir',
    'hiçbir A B değildir',
    'mantık doğru düşünme yöntemidir',
    'önerme doğru veya yanlış olabilir',
    'çıkarım önermelerden sonuç bulmaktır',
    'tümdengelim genelden özele gider',
    'tümevarım özelden genele gider',
    'sebep sonuç ilişkisine neden denir',
    'A ise B ve A doğruysa B doğrudur',
    'A ise B ve B yanlışsa A yanlıştır',
    'çelişki aynı anda hem doğru hem yanlış olamaz',

    // Felsefe
    'felsefe bilgelik sevgisidir',
    'bilgi güçtür',
    'merak öğrenmenin temelidir',
    'şüphe düşüncenin başlangıcıdır',
    'soru cevaptan değerlidir',
    'her cevap yeni soru doğurur',
    'düşünce soyut kavramlar üretir',
    'kavram düşüncenin yapı taşıdır',
    'bağlantı kavramlar arası köprüdür',
    'anlamak bağlantıları görmektir',
    'gerçek kanıtlanabilir olgudur',
    'hipotez test edilebilir varsayımdır',
    'teori kanıtlanmış hipotezler bütünüdür',
    'paradoks kendisiyle çelişen ifadedir',
    'bilinmezlik öğrenme fırsatıdır',

    // Ogrenme
    'öğrenmek yeni bağlantılar kurmaktır',
    'öğrenme tekrarla güçlenir',
    'gözlem veri toplamaktır',
    'veri ham bilgidir',
    'bilgi işlenmiş veridir',
    'deneyim öğrenmenin en iyi yoludur',
    'hata öğrenme fırsatıdır',
    'benzerlik yeni kavramları anlamayı kolaylaştırır',
    'farklılık kavramları ayırt etmeyi sağlar',
    'kategorize etmek bilgiyi düzenlemektir',
    'karşılaştırma analizin temelidir',
    'sınıflandırma bilgiyi hiyerarşik düzenler',

    // Bilim
    'bilim gözlemle başlar',
    'deney hipotezi test eder',
    'veri analizi pattern bulur',
    'pattern düzenli tekrardır',
    'model gerçeğin basitleştirilmiş halidir',
    'simülasyon modelin çalıştırılmasıdır',
    'doğrulama teorinin test edilmesidir',
    'yanlışlama bilimsel ilerlemenin motorudur',
    'sebep sonuca neden olur',
    'sonuç sebebin etkisidir',

    // Matematik
    'küme nesneler topluluğudur',
    'Venn şeması kümeleri görselleştirir',
    'kesişim ortak özellikleri bulur',
    'birleşim tüm özellikleri toplar',
    'fonksiyon girdiyi çıktıya dönüştürür',
    'vektör yön ve büyüklük içerir',
    'matris sayıların dikdörtgen dizisidir',
    'dönüşüm bir şeyi başka şeye çevirir',
    'entropi düzensizlik ölçüsüdür',
    'olasılık belirsizlik ölçüsüdür',
    'eğilim olası en kısa yoldur',

    // Sistem
    'AXIOM bilgi grafiği motorudur',
    'düğüm kavramı temsil eder',
    'kenar ilişkiyi temsil eder',
    'weight ilişkinin gücünü gösterir',
    'rüya hipotez üretmektir',
    'doğruluk hipotezi test eder',
    'amplifikasyon doğru cevabı güçlendirir',
    'simülasyon hipotezleri karşılaştırır',
    'gömme vektör kavramı sayılarla temsil eder',
    'benzerlik vektörler arası açıdır',
    'unutma eğrisi zamanla zayıflamayı modeller',
    'budama gereksiz bağlantıları temizler',
    'plugin sistemi genişletilebilirlik sağlar',
    'Rust hızlandırıcı büyük grafikler için',
    'Bilmiyorum bilinmeyeni kabul etmektir',
    'bilinmeyeni kabul etmek öğrenmenin başlangıcıdır',
  ];
  return { identityFacts, veriler };
}

function main(argv = process.argv.slice(2), env = process.env) {
  if (!isDemoRequested(argv, env)) {
    console.error('egitim-demo: demo modu kapalı. Bilinçli demo için: HUQAN_DEMO_MODE=1 node scripts/egitim-demo.js');
    console.error("egitim-demo: (#363 güvenlik koruması) demo; production memory.json'a asla dokunmaz, varsayılan hedef izole geçici dizindir.");
    process.exitCode = 2;
    return;
  }

  const persistDir = resolvePersistDir(argv);
  fs.mkdirSync(persistDir, { recursive: true });
  const memoryPath = path.join(persistDir, 'memory.json');

  const identitySeed = loadIdentityFacts();
  const { identityFacts, veriler } = buildDemoCorpus(identitySeed);
  const k = new Kernel({ noLoad: true, memoryPath, useSQLite: false, loadPlugins: false });
  const d = new Dream(k);
  const DEMO_SEED_LEARN_BYPASS = Kernel.createAdmissionBypassOpts(DEMO_BYPASS_REASON);

  console.log(`AXIOM Egitim Basladi: ${veriler.length} bilgi (izole dizin: ${persistDir})`);
  for (let i = 0; i < veriler.length; i += 1) {
    const v = veriler[i];
    const provenance = i < identityFacts.length
      ? {
          provenanceId: `axiom-identity-seed-${i + 1}`,
          sourceRef: `${identitySeed.sourceRef}#${i + 1}`,
          sourceTitle: identitySeed.sourceTitle,
          sourceType: identitySeed.sourceType || 'system',
          sourceSubType: identitySeed.sourceSubType || 'identity-seed',
          actor: identitySeed.actor || 'system',
          workspaceId: identitySeed.workspaceId || 'default',
        }
      : null;
    k.learn(v, provenance
      ? { provenance, workspaceId: provenance.workspaceId, ...DEMO_SEED_LEARN_BYPASS }
      : DEMO_SEED_LEARN_BYPASS);
  }

  console.log(`Istatistik: ${Object.keys(k.graph._nodes).length} dugum, ${k.graph._edges.length} kenar`);
  console.log(`Entropi: ${k.entropy().toFixed(3)}`);

  const gaps = k.detectGaps();
  if (gaps.length > 0) console.log(`Baglantisiz: ${gaps.join(', ')}`);

  const cons = k.detectContradictions();
  if (cons.length > 0) {
    console.log('Celiskiler:');
    for (const c of cons) console.log(`  ${c.node}: ${c.targets.join(', ')}`);
  }

  console.log('\nRuya (Hipotezler):');
  const h = d.dream();
  if (h.length === 0) console.log('  Hipotez yok.');
  else for (const x of h.slice(0, 10)) {
    console.log(`  ${x.from} -> ${x.to} (${x.type}, guven: ${x.confidence.toFixed(3)})`);
  }

  console.log('\nOrnek Cikarimlar:');
  const sorular = ['HUQAN nedir', 'mantik nedir', 'felsefe nedir', 'öğrenmek nedir', 'bilim nedir', 'hipotez nedir', 'AXIOM nedir'];
  for (const s of sorular) {
    console.log(`  sor: "${s}" -> ${k.ask(s)?.data?.answer}`);
  }

  console.log('\nTest: bilinmeyen kavram:');
  console.log(`  sor: "uçan fil nedir" -> ${k.ask('uçan fil nedir')?.data?.answer}`);

  const emb = d.embedding({ dimensions: 64, walksPerNode: 8, walkLength: 15 });
  if (emb) console.log(`\nGomme: ${emb.dimensions} boyut, ${emb.nodes} dugum`);

  const similars = d.findSimilar('öğrenmek', 5);
  if (similars.length > 0) {
    console.log(`\n"öğrenmek"e en yakin kavramlar:`);
    for (const s of similars) console.log(`  ${s.id}: ${s.score.toFixed(3)}`);
  }

  k.graph.save();
  if (typeof k.graph.close === 'function') k.graph.close();
  console.log(`\nHafiza kaydedildi: ${memoryPath}`);
  console.log(`Demoyu konusmak icin: set HUQAN_MEMORY_PATH=${memoryPath} && node cli.js`);
  console.log('Egitim tamam.');
}

module.exports = {
  buildDemoCorpus,
  defaultPersistDir,
  isDemoRequested,
  loadIdentityFacts,
  resolvePersistDir,
};

if (require.main === module) {
  main();
}

