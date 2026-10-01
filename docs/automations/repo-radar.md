# Repo Radar — Saatlik Tersine Mühendislik Otomasyonu

Repo Radar, her saat başında HUQAN'a benzer bir açık kaynak repoyu tersine
mühendislikle inceler ve HUQAN için somut geliştirme önerileri üretir. Tur
başına tek bir repo seçilir ve sonuç, HUQAN deposunda tek bir issue olarak
açılır.

İki rotasyon vardır ve ikisi de aynı seçiciyi kullanır:

| Rotasyon | Config | Ne tarar |
| --- | --- | --- |
| Ekosistem | `config/repo-radar.targets.json` | Genel ajan çatıları, bellek, MCP, güven, mantık kütüphaneleri. |
| Öğrenme | `config/repo-radar-learn.targets.json` | Başka sistemlerin **öğrenme döngüsünü nasıl kapattığı**: öz-gelişim, prosedür çıkarımı, bellek konsolidasyonu/unutma, çelişki muhasebesi, değerlendirme/kalibrasyon. |

Öğrenme rotasyonu, HUQAN'ın kaynakta ölçülen beş öğrenme döngüsü boşluğuna
göre seçilir: deneyim zincirinin üretimde bağlı olmaması (G1), dream
hipotezlerinin prosedüre terfi etmemesi (G2), belief-revision çelişkisinin
öğrenmeyi beslememesi (G3), bellek konsolidasyonu/unutma olmaması (G4) ve
kalibrasyon yüzeyi olmaması (G5).

Bu belge, otomasyonun nasıl çalıştığını ve nasıl kurulduğunu anlatır.
Otomasyonun kendisi bu depoda çalışmaz; harici otomasyon servisinde
tanımlıdır ve çalışma anında bu depoyu klonlar.

## Bileşenler

| Dosya | Rol |
| --- | --- |
| `config/repo-radar.targets.json` | Ekosistem rotasyon listesi. Sürümlenmiş tek doğruluk kaynağı. |
| `config/repo-radar-learn.targets.json` | Öğrenme rotasyon listesi. Aynı şema, ayrı kapsam. |
| `scripts/repo-radar/pick-target.js` | Saate göre deterministik hedef seçer (`--json`) ve otomasyon prompt'unu üretir (`--prompt`). `--config` ile her iki listeyi de okur. |
| `.github/workflows/repo-radar-contract.yml` | Rotasyon listeleri veya script değiştiğinde aracın hâlâ çalıştığını doğrular. |
| `docs/automations/repo-radar.md` | Bu belge. |

## Rotasyon

Seçim, UTC saatine bağlı saf bir fonksiyondur:

```
index = floor(unixMillis / 3600000) % repoCount
```

Rastgelelik, durum dosyası veya ağ sonucuna göre sıralama yoktur. Bu sayede:

- Geç çalışan bir tur, zamanlandığı saate göre seçim yapar.
- Aynı saat için tekrar çalışan tur aynı repoyu seçer; çıktı denetlenebilir.

Liste fail-closed doğrulanır: bozuk bir kayıt, hedefi sessizce düşürmek yerine
turun çalışmasını reddeder; çünkü sessizce kısalan liste sonraki tüm saatlerin
seçimini kaydırır.

Listeler append-only büyütülür: yeni hedef sona eklenir, böylece mevcut
saatlerin eşlemesi değişmez.

Yerelde doğrulama:

```bash
node scripts/repo-radar/pick-target.js
node scripts/repo-radar/pick-target.js --at 2026-10-01T00:30:00Z --json
node scripts/repo-radar/pick-target.js --prompt
node scripts/repo-radar/pick-target.js --config config/repo-radar-learn.targets.json --json
```

## Otomasyon akışı

Her saat tetiklenen tur şu adımları izler:

1. Depo kimliğini doğrular (`git remote -v`, `node scripts/agent-context.js`).
2. Hedef repoyu derinlik-1 klonlar ve tam commit SHA'sını kaydeder.
3. Mimariyi çıkarır: giriş noktaları, ana modüller, veri akışı,
   sözleşmeler/şemalar, test stratejisi, CI.
4. Bulguları HUQAN'ın ilgili yüzeyleriyle karşılaştırır ve her bulguyu
   `yol:satır` kanıtına bağlar. Kanıtsız bulgu "doğrulanmadı" işaretlenir.
5. 3-7 somut öneri üretir; her öneri kanıt, ilgili HUQAN yüzeyi, önerilen
   değişiklik, beklenen kazanç, risk ve tahmini efor içerir.
6. HUQAN deposunda tek bir issue açar (başlık: `repo-radar: <repo> — <özet>`).
   Aynı repo için açık bir issue varsa yenisini açmak yerine ona yorum ekler.

Turlar kod değiştirmez, PR açmaz, `main`'e push etmez. Kapsam yalnızca analiz
ve issue'dur.

## Prompt'un üretilmesi

Otomasyonun prompt'u bir kez, otomasyon oluşturulurken üretilir ve her saat
aynı metin yeniden kullanılır. Bu yüzden prompt belirli bir repoyu sabitlemez;
hedef repo çalışma anında `pick-target.js --json` ile çözülür. Böylece prompt
statik bir şablon artı rotasyon listesidir ve tekrarlanabilir kalır.

Prompt'u üretmek veya değişiklik sonrası güncellemek için:

```bash
node scripts/repo-radar/pick-target.js --prompt
```

## Kurulum

Otomasyon, otomasyon servisinde saatlik bir cron tetikleyicisiyle
tanımlanır ve bu depoyu klonlar. Kurulum betiği, prompt'u `pick-target.js`
çıktısından üretir; bu yüzden prompt elle kopyalanmaz ve rotasyon listesiyle
senkron kalır:

```bash
node scripts/repo-radar/pick-target.js --prompt > /tmp/repo-radar-prompt.txt

jq -n --rawfile prompt /tmp/repo-radar-prompt.txt '{
  name: "HUQAN Repo Radar (saatlik tersine muhendislik)",
  prompt: $prompt,
  trigger: { type: "cron", schedule: "0 * * * *", timezone: "UTC" },
  repos: [{ url: "https://github.com/ali-ulu/huqan", ref: "main" }]
}' > /tmp/repo-radar-automation.json

curl -X POST "https://app.all-hands.dev/api/automation/v1/preset/prompt" \
  -H "Authorization: Bearer ${OPENHANDS_API_KEY}" \
  -H "Content-Type: application/json" \
  --data @/tmp/repo-radar-automation.json
```

Otomasyon yalnızca `GITHUB_TOKEN` benzeri bir GitHub kimliğine ihtiyaç duyar;
başka bir secret verilmemelidir.

### Öğrenme rotasyonu kurulumu

Öğrenme rotasyonu ayrı bir otomasyondur; aynı kurulum, yalnızca `--config` ve
prompt'un `--config` bayrağını içermesi farkıyla:

```bash
node scripts/repo-radar/pick-target.js \
  --config config/repo-radar-learn.targets.json --prompt > /tmp/repo-radar-learn-prompt.txt

jq -n --rawfile prompt /tmp/repo-radar-learn-prompt.txt '{
  name: "HUQAN Repo Radar (ogrenme odakli)",
  prompt: $prompt,
  trigger: { type: "cron", schedule: "30 * * * *", timezone: "UTC" },
  repos: [{ url: "https://github.com/ali-ulu/huqan", ref: "main" }]
}' > /tmp/repo-radar-learn-automation.json

curl -X POST "https://app.all-hands.dev/api/automation/v1/preset/prompt" \
  -H "Authorization: Bearer ${OPENHANDS_API_KEY}" \
  -H "Content-Type: application/json" \
  --data @/tmp/repo-radar-learn-automation.json
```

Öğrenme turu, ekosistem turuyla aynı saatte çakışmasın diye `30 * * * *`
(saat başının 30. dakikası) zamanlanır. Prompt'un içindeki `pick-target.js
--json` çağrısı `--config config/repo-radar-learn.targets.json` ile
eşleşmelidir; aksi hâlde tur yanlış rotasyondan hedef seçer. Bu yüzden öğrenme
prompt'u `--config` bayrağını taşıyan kendi şablonundan üretilir.

Bir otomasyonun prompt'u oluşturulduğu anda sabitlenir. Rotasyon listesi
değişince prompt'u `PATCH` ile güncellemek yerine otomasyonu yeni prompt'la
yeniden oluştur ve eskisini devre dışı bırak; böylece yürütme bağlamı yenilenir
ve aynı anda iki canlı otomasyon kalmaz.

## Sınırlar

- Otomasyon analiz ve issue üretir; doğrulanmamış bir bulguyu ürün iddiasına
  dönüştürmez.
- Kapalı veya ücretli API çağrısı yapmaz; yalnızca public repo klonu ve `gh`
  kullanır.
- Ürettiği issue'lar AI imzası, "on behalf of" ifadesi veya ajan ortak-yazar
  trailer'ı içermez (AGENTS.md §10).
