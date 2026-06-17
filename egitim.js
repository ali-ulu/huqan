const fs = require('fs');
const path = require('path');
const Kernel = require('./kernel');
const Dream = require('./dream');

const identitySeedPath = path.join(__dirname, 'docs', 'seed', 'axiom-identity.seed.json');
const identitySeed = JSON.parse(fs.readFileSync(identitySeedPath, 'utf8'));

// Egitim: temiz baslat, mevcut hafizayi karistirma.
const k = new Kernel({ noLoad: true, useSQLite: true });
const d = new Dream(k);

const identityFacts = Array.isArray(identitySeed.facts) ? identitySeed.facts.filter(Boolean) : [];

const veriler = [
  ...identityFacts,

  // Mantik
  'her A Bdir',
  'baz\u0131 A Bdir',
  'hi\u00e7bir A B de\u011fildir',
  'mant\u0131k do\u011fru d\u00fc\u015f\u00fcnme y\u00f6ntemidir',
  '\u00f6nerme do\u011fru veya yanl\u0131\u015f olabilir',
  '\u00e7\u0131kar\u0131m \u00f6nermelerden sonu\u00e7 bulmakt\u0131r',
  't\u00fcmdengelim genelden \u00f6zele gider',
  't\u00fcmevar\u0131m \u00f6zelden genele gider',
  'sebep sonu\u00e7 ili\u015fkisine neden denir',
  'A ise B ve A do\u011fruysa B do\u011frudur',
  'A ise B ve B yanl\u0131\u015fsa A yanl\u0131\u015ft\u0131r',
  '\u00e7eli\u015fki ayn\u0131 anda hem do\u011fru hem yanl\u0131\u015f olamaz',

  // Felsefe
  'felsefe bilgelik sevgisidir',
  'bilgi g\u00fc\u00e7t\u00fcr',
  'merak \u00f6\u011frenmenin temelidir',
  '\u015f\u00fcphe d\u00fc\u015f\u00fcncenin ba\u015flang\u0131c\u0131d\u0131r',
  'soru cevaptan de\u011ferlidir',
  'her cevap yeni soru do\u011furur',
  'd\u00fc\u015f\u00fcnce soyut kavramlar \u00fcretir',
  'kavram d\u00fc\u015f\u00fcncenin yap\u0131 ta\u015f\u0131d\u0131r',
  'ba\u011flant\u0131 kavramlar aras\u0131 k\u00f6pr\u00fcd\u00fcr',
  'anlamak ba\u011flant\u0131lar\u0131 g\u00f6rmektir',
  'ger\u00e7ek kan\u0131tlanabilir olgudur',
  'hipotez test edilebilir varsay\u0131md\u0131r',
  'teori kan\u0131tlanm\u0131\u015f hipotezler b\u00fct\u00fcn\u00fcd\u00fcr',
  'paradoks kendisiyle \u00e7eli\u015fen ifadedir',
  'bilinmezlik \u00f6\u011frenme f\u0131rsat\u0131d\u0131r',

  // Ogrenme
  '\u00f6\u011frenmek yeni ba\u011flant\u0131lar kurmakt\u0131r',
  '\u00f6\u011frenme tekrarla g\u00fc\u00e7lenir',
  'g\u00f6zlem veri toplamakt\u0131r',
  'veri ham bilgidir',
  'bilgi i\u015flenmi\u015f veridir',
  'deneyim \u00f6\u011frenmenin en iyi yoludur',
  'hata \u00f6\u011frenme f\u0131rsat\u0131d\u0131r',
  'benzerlik yeni kavramlar\u0131 anlamay\u0131 kolayla\u015ft\u0131r\u0131r',
  'farkl\u0131l\u0131k kavramlar\u0131 ay\u0131rt etmeyi sa\u011flar',
  'kategorize etmek bilgiyi d\u00fczenlemektir',
  'kar\u015f\u0131la\u015ft\u0131rma analizin temelidir',
  's\u0131n\u0131fland\u0131rma bilgiyi hiyerar\u015fik d\u00fczenler',

  // Bilim
  'bilim g\u00f6zlemle ba\u015flar',
  'deney hipotezi test eder',
  'veri analizi pattern bulur',
  'pattern d\u00fczenli tekrard\u0131r',
  'model ger\u00e7e\u011fin basitle\u015ftirilmi\u015f halidir',
  'sim\u00fclasyon modelin \u00e7al\u0131\u015ft\u0131r\u0131lmas\u0131d\u0131r',
  'do\u011frulama teorinin test edilmesidir',
  'yanl\u0131\u015flama bilimsel ilerlemenin motorudur',
  'sebep sonuca neden olur',
  'sonu\u00e7 sebebin etkisidir',

  // Matematik
  'k\u00fcme nesneler toplulu\u011fudur',
  'Venn \u015femas\u0131 k\u00fcmeleri g\u00f6rselle\u015ftirir',
  'kesi\u015fim ortak \u00f6zellikleri bulur',
  'birle\u015fim t\u00fcm \u00f6zellikleri toplar',
  'fonksiyon girdiyi \u00e7\u0131kt\u0131ya d\u00f6n\u00fc\u015ft\u00fcr\u00fcr',
  'vekt\u00f6r y\u00f6n ve b\u00fcy\u00fckl\u00fck i\u00e7erir',
  'matris say\u0131lar\u0131n dikd\u00f6rtgen dizisidir',
  'd\u00f6n\u00fc\u015f\u00fcm bir \u015feyi ba\u015fka \u015feye \u00e7evirir',
  'entropi d\u00fczensizlik \u00f6l\u00e7\u00fcs\u00fcd\u00fcr',
  'olas\u0131l\u0131k belirsizlik \u00f6l\u00e7\u00fcs\u00fcd\u00fcr',
  'e\u011filim olas\u0131 en k\u0131sa yoldur',

  // Sistem
  'AXIOM bilgi grafi\u011fi motorudur',
  'd\u00fc\u011f\u00fcm kavram\u0131 temsil eder',
  'kenar ili\u015fkiyi temsil eder',
  'weight ili\u015fkinin g\u00fcc\u00fcn\u00fc g\u00f6sterir',
  'r\u00fcuya hipotez \u00fcretmektir',
  'do\u011fruluk hipotezi test eder',
  'amplifikasyon do\u011fru cevab\u0131 g\u00fc\u00e7lendirir',
  'sim\u00fclasyon hipotezleri kar\u015f\u0131la\u015ft\u0131r\u0131r',
  'g\u00f6mme vekt\u00f6r kavram\u0131 say\u0131larla temsil eder',
  'benzerlik vekt\u00f6rler aras\u0131 a\u00e7\u0131d\u0131r',
  'unutma e\u011frisi zamanla zay\u0131flamay\u0131 modeller',
  'budama gereksiz ba\u011flant\u0131lar\u0131 temizler',
  'plugin sistemi geni\u015fletilebilirlik sa\u011flar',
  'Rust h\u0131zland\u0131r\u0131c\u0131 b\u00fcy\u00fck grafikler i\u00e7in',
  'Bilmiyorum bilinmeyeni kabul etmektir',
  'bilinmeyeni kabul etmek \u00f6\u011frenmenin ba\u015flang\u0131c\u0131d\u0131r',
];

console.log(`AXIOM Egitim Basladi: ${veriler.length} bilgi`);
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
  k.learn(v, provenance ? { provenance, workspaceId: provenance.workspaceId } : undefined);
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
const sorular = ['HUQAN nedir', 'mantik nedir', 'felsefe nedir', '\u00f6\u011frenmek nedir', 'bilim nedir', 'hipotez nedir', 'AXIOM nedir'];
for (const s of sorular) {
  console.log(`  sor: "${s}" -> ${k.ask(s)}`);
}

console.log('\nTest: bilinmeyen kavram:');
console.log(`  sor: "u\u00e7an fil nedir" -> ${k.ask('u\u00e7an fil nedir')}`);

const emb = d.embedding({ dimensions: 64, walksPerNode: 8, walkLength: 15 });
if (emb) console.log(`\nGomme: ${emb.dimensions} boyut, ${emb.nodes} dugum`);

const similars = d.findSimilar('\u00f6\u011frenmek', 5);
if (similars.length > 0) {
  console.log(`\n"\u00f6\u011frenmek"e en yakin kavramlar:`);
  for (const s of similars) console.log(`  ${s.id}: ${s.score.toFixed(3)}`);
}

k.graph.save();
console.log('\nHafiza kaydedildi.');
console.log('Egitim tamam. node cli.js ile konusmaya devam et.');
