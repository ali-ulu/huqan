# Issue Runner — Saatlik Issue→PR→Merge Otomasyonu

Issue Runner, her saat başında bu depoyu klonlar ve **sahibinin uygulanmaya
onayladığı tek bir issue'yu** uçtan uca teslim eder: feature dalı açar, minimal
düzeltmeyi ve testini yazar, pull request açar, zorunlu CI kontrollerini yeşile
getirir ve squash merge eder. `Closes #N` sayesinde merge ile issue kapanır.

Bu belge otomasyonun nasıl çalıştığını ve nasıl kurulduğunu anlatır. Otomasyonun
kendisi bu depoda çalışmaz; harici otomasyon servisinde tanımlıdır ve çalışma
anında bu depoyu klonlar.

## Diğer otomasyonlardan farkı

Depodaki dört günlük otomasyon (Daily Digest, Bug Hunter, Security Review, Docs
Maintainer) **salt-okunur**dur: issue veya advisory açar, PR **açmaz**. Issue
Runner tek yazma yetkili otomasyondur ve bir PR'ı merge edene kadar takip eder
(AGENTS.md §0a — PR sahipliği).

## Tetikleyici

Uygulama, bir issue'ya **`openhands-implement`** etiketi takılmasıyla başlar:

- Otomasyon yalnızca bu etiketli issue'ları işler; etiketsiz issue'ya PR açmaz.
  Böylece yanlış issue'nun dala dönüşmesi sahibin bilinçli kararına bağlanır.
- Etiket bilinçli bir kapıdır: hatalı bir bulgu (ör. Bug Hunter çıktısı) sahibin
  onayı olmadan otomatik PR'a dönüşmez.
- Uygulanamayan issue'da otomasyon etiketi kaldırır ve gerekçeyi issue'ya Türkçe
  yorum olarak yazar.

## Akış (calisma aninda)

1. **Kimlik:** `git remote -v`, `git status --short` ve
   `node scripts/agent-context.js` ile depo kimliğini doğrular.
2. **İş seçimi (öncelik sırası):**
   - Önce açık bir `automation/*` PR'ı varsa onu devam ettirir (yeşile getir +
     merge). Bir turda tek PR.
   - Yoksa `openhands-implement` etiketli, henüz PR'ı olmayan **en düşük
     numaralı** issue'yu seçer.
3. **Değişiklik:** `origin/main`'den `automation/issue-<N>-<slug>` dalı açar;
   issue'yü, yorumlarını ve bağlantılarını kendi okur; en küçük düzeltmeyi ve
   onu bağlayan testi yazar (AGENTS.md `ARCH-001`, `YAGNI-001`).
4. **PR:** `Closes #N` içeren, Türkçe açıklamalı bir PR açar. **AI imzası yok.**
5. **Yeşile getirme:** Zorunlu kontrolleri (ruleset 23629799) poll eder; gerçek
   hatayı kaynakta düzeltir, push eder. `lib/*`'e satır eklenmişse
   `node scripts/enforcement-coverage.js` ile `coverage-manifest.json`'ı yeniler.
   Architecture static gates zinciri bu manifest kaymasından kırılır.
6. **Merge:** Zorunlu kontroller yeşil ve PR mergeable iken squash merge eder,
   dalı siler. `required_signatures` engelinde GitHub REST merge uç noktasını
   kullanır (sunucu tarafı imzalı squash commit üretir). Issue otomatik kapanır.

## Sınırlar

- `main`'e asla doğrudan commit veya push yoktur; yalnız `automation/*` dalı ve
  PR üzerinden ilerler.
- Bir PR = bir amaç. Komşu borç düzeltilmez (AGENTS.md §8).
- Zorunlu bir kontrol, ajanın yetkisi dışında bir karar gerektiriyorsa otomasyon
  durur, PR'ı açık bırakır ve ne gerektiğini raporlar.
- Ürettiği commit, PR ve yorumlar AI imzası, "on behalf of" ifadesi veya
  `Co-authored-by: openhands` trailer'ı içermez (AGENTS.md §10).
- Tüm kullanıcıya dönük metin Türkçedir (AGENTS.md §1).

## Kurulum

Otomasyon, otomasyon servisinde saatlik (`0 * * * *`, UTC) bir cron ile tanımlanır
ve bu depoyu `main` üzerinden klonlar. Kurulum iki parçalıdır: tetikleyici etiketi
ve prompt-preset otomasyonu.

```bash
# 1) tetikleyici etiketi (bir kez)
gh label create openhands-implement -R ali-ulu/huqan \
  --color 0e8a16 \
  --description "Owner-approved for the hourly issue runner to implement"

# 2) otomasyonu olustur (prompt dosyadan gelir)
jq -n --rawfile prompt issue-runner.prompt.md '{
  name: "HUQAN Issue Runner (saatlik)",
  prompt: $prompt,
  trigger: { type: "cron", schedule: "0 * * * *", timezone: "UTC" },
  repos: [{ url: "https://github.com/ali-ulu/huqan", ref: "main" }]
}' > /tmp/issue-runner-automation.json

curl -X POST "https://app.all-hands.dev/api/automation/v1/preset/prompt" \
  -H "Authorization: Bearer ${OPENHANDS_API_KEY}" \
  -H "Content-Type: application/json" \
  --data @/tmp/issue-runner-automation.json
```

Otomasyon yalnızca bir GitHub kimliğine ihtiyaç duyar (`GITHUB_TOKEN` veya
`GITHUB_PERSONAL_ACCESS_TOKEN`); prompt bu değeri `GH_TOKEN` olarak `gh` CLI'ya
bağlar. Sandbox `GITHUB_TOKEN` ile `gh` komutlarında otomatik kullanır; başka bir
secret verilmemelidir.

Bir otomasyonun prompt'u oluşturulduğu anda sabitlenir. Prompt değişince `PATCH`
yerine otomasyonu yeni prompt'la yeniden oluştur ve eskisini devre dışı bırak;
böylece aynı anda iki canlı otomasyon kalmaz.

## Doğrulama

```bash
# elle tetikle
curl -X POST "https://app.all-hands.dev/api/automation/v1/<id>/dispatch" \
  -H "Authorization: Bearer ${OPENHANDS_API_KEY}"

# calismalari oku
curl -s "https://app.all-hands.dev/api/automation/v1/<id>/runs?limit=5" \
  -H "Authorization: Bearer ${OPENHANDS_API_KEY}"
```

`run_metadata.finish_tool_response.message` alanı otomasyonun son raporunu
taşır. Etiketli iş yokken bu alan tek satırdır:
`İşlenecek etiketli issue ve açık automation PR'ı yok.`
