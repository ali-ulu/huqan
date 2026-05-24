const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const CLI = require('./cli');
const Kernel = require('./kernel');
const KernelV2 = require('./kernel.v2');
const Dream = require('./dream');

function freshCLI() {
  const cli = new CLI();
  cli.kernel = new Kernel({ noLoad: true });
  cli.dream = new Dream(cli.kernel);
  return cli;
}

describe('CLI - Komut Çözümleme', () => {
  it('parse: "öğret:" komutunu tanır', () => {
    const cli = freshCLI();
    const result = cli.parse('öğret: Köpek hayvandır');
    assert.strictEqual(result.command, 'öğret');
    assert.strictEqual(result.args, 'Köpek hayvandır');
  });

  it('parse: "sor:" komutunu tanır', () => {
    const cli = freshCLI();
    const result = cli.parse('sor: Köpek nedir');
    assert.strictEqual(result.command, 'sor');
    assert.strictEqual(result.args, 'Köpek nedir');
  });

  it('parse: "durum" komutunu tanır', () => {
    const cli = freshCLI();
    const result = cli.parse('durum');
    assert.strictEqual(result.command, 'durum');
    assert.strictEqual(result.args, '');
  });

  it('parse: "rüya" komutunu tanır', () => {
    const cli = freshCLI();
    const result = cli.parse('rüya');
    assert.strictEqual(result.command, 'rüya');
  });

  it('parse: bilinmeyen komut öğret varsayılır', () => {
    const cli = freshCLI();
    const result = cli.parse('gecersiz komut');
    assert.strictEqual(result.command, 'öğret');
  });

  it('parse: doğal dil soru tanır', () => {
    const cli = freshCLI();
    assert.strictEqual(cli.parse('kedi nedir').command, 'sor');
    assert.strictEqual(cli.parse('köpek nasıl hayvan').command, 'sor');
  });

  it('parse: doğal dil öğret tanır', () => {
    const cli = freshCLI();
    assert.strictEqual(cli.parse('kedi balık yer').command, 'öğret');
    assert.strictEqual(cli.parse('köpek hayvandır').command, 'öğret');
  });

  it('parse: selam ve yardım', () => {
    const cli = freshCLI();
    assert.strictEqual(cli.parse('merhaba').command, 'selam');
    assert.strictEqual(cli.parse('yardım').command, 'yardım');
    assert.strictEqual(cli.parse('nasılsın').command, 'durum');
  });
});

describe('CLI - Komut Çalıştırma', () => {
  it('execute: öğret komutu kernel.learn çağırır', () => {
    const cli = freshCLI();
    const result = cli.execute('öğret', 'Köpek hayvandır');
    assert.ok(result.includes('öğrendim'));
    const node = cli.kernel.graph.getNode('köpek');
    assert.ok(node);
  });

  it('execute: sor komutu cevap döndürür', () => {
    const cli = freshCLI();
    cli.execute('öğret', 'Köpek hayvandır');
    const result = cli.execute('sor', 'Köpek nedir');
    assert.ok(result.includes('köpek'));
  });

  it('execute: durum komutu istatistik gösterir', () => {
    const cli = freshCLI();
    cli.execute('öğret', 'Köpek hayvandır');
    cli.execute('öğret', 'Kedi hayvandır');
    const result = cli.execute('durum', '');
    assert.ok(result.includes('düğüm'));
    assert.ok(result.includes('kenar'));
  });

  it('execute: rüya komutu hipotez üretir', () => {
    const cli = freshCLI();
    cli.execute('öğret', 'Köpek memelidir');
    cli.execute('öğret', 'Kedi memelidir');
    const result = cli.execute('rüya', '');
    assert.ok(result);
  });

  it('parse: "llm-sor:" komutunu tanır', () => {
    const cli = freshCLI();
    const result = cli.parse('llm-sor: kediler balık yer mi');
    assert.strictEqual(result.command, 'llm-sor');
    assert.strictEqual(result.args, 'kediler balık yer mi');
  });

  it('parse: "yükle:" komutunu tanır', () => {
    const cli = freshCLI();
    const result = cli.parse('yükle: bilgi.txt');
    assert.strictEqual(result.command, 'yükle');
    assert.strictEqual(result.args, 'bilgi.txt');
  });

  it('execute: "yükle:" dosyadan öğrenir', () => {
    const tmp = path.join(os.tmpdir(), 'axiom-test-' + Date.now() + '.txt');
    fs.writeFileSync(tmp, 'kedi balık yer\nköpek kemik sever\nkuş uçar', 'utf-8');
    const cli = freshCLI();
    const result = cli.execute('yükle', tmp);
    assert.ok(result.includes('3 bilgi öğrenildi'));
    assert(cli.kernel.ask('kedi balık yer').data.answer !== 'Bilmiyorum');
    fs.unlinkSync(tmp);
  });

  it('execute: "yükle:" olmayan dosya için hata döndürür', () => {
    const cli = freshCLI();
    const result = cli.execute('yükle', 'yok.txt');
    assert.ok(result.includes('Dosya okunamadı'));
  });

  it('execute: "llm-sor:" AXIOM cevabı döndürür', () => {
    const cli = freshCLI();
    cli.execute('öğret', 'Kedi hayvandır');
    const result = cli.execute('llm-sor', 'Kedi nedir');
    assert.ok(result.includes('AXIOM'));
    assert.ok(result.includes('kedi'));
  });

  it('constructor: v2 kernel flag opens KernelV2 without breaking CLI flow', () => {
    const cli = new CLI({ kernel: { noLoad: true, useSQLite: false, version: 'v2' } });
    assert.ok(cli.kernel instanceof KernelV2);
    cli.kernel.learn('kus ucmaz');
    const result = cli.kernel.verify('kus ucar');
    assert.strictEqual(result.data.status, 'celiski');
    assert.strictEqual(result.data.contradictionReason, 'opposite_predicate_conflict');
  });
});
