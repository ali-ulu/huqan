# Repo Radar — Saatlik Tersine Mühendislik Otomasyonu

Repo Radar, her saat başında HUQAN'a benzer bir açık kaynak repoyu tersine
mühendislikle inceler ve HUQAN için somut geliştirme önerileri üretir. Tur
başına tek bir repo seçilir ve sonuç, HUQAN deposunda tek bir issue olarak
açılır.

Bu belge, otomasyonun nasıl çalıştığını ve nasıl kurulduğunu anlatır.
Otomasyonun kendisi bu depoda çalışmaz; harici otomasyon servisinde
tanımlıdır ve çalışma anında bu depoyu klonlar.

## Bileşenler

| Dosya | Rol |
| --- | --- |
| `config/repo-radar.targets.json` | Rotasyon listesi. Hedef repoların sürümlenmiş tek doğruluk kaynağı. |
| `scripts/repo-radar/pick-target.js` | Saate göre deterministik hedef seçer (`--json`) ve otomasyon prompt'unu üretir (`--prompt`). |
| `.github/workflows/repo-radar-contract.yml` | Rotasyon listesi veya script değiştiğinde aracın hâlâ çalıştığını doğrular. |
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

Yerelde doğrulama:

```bash
node scripts/repo-radar/pick-target.js
node scripts/repo-radar/pick-target.js --at 2026-10-01T00:30:00Z --json
node scripts/repo-radar/pick-target.js --prompt
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

## Sınırlar

- Otomasyon analiz ve issue üretir; doğrulanmamış bir bulguyu ürün iddiasına
  dönüştürmez.
- Kapalı veya ücretli API çağrısı yapmaz; yalnızca public repo klonu ve `gh`
  kullanır.
- Ürettiği issue'lar AI imzası, "on behalf of" ifadesi veya ajan ortak-yazar
  trailer'ı içermez (AGENTS.md §10).
