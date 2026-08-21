# GitHub Actions ile PR Guardian webhook otomasyonu

Bu örnek, GitHub’daki `pull_request` olaylarını HUQAN PR Guardian webhook’una iletir. GitHub Actions workflow dosyalarının `.github/workflows` altında tutulması ve event filtrelerinin `on` alanında tanımlanması gerekir.[1] Workflow **pull request kodunu checkout etmez ve çalıştırmaz**. Depo yönetişimi gereği `pull_request_target` kullanılmaz; Actions yolu yalnızca head repository’si taban repository ile aynı olan PR’larda çalışır. Fork PR’ları için secret gerektirmeyen dış GitHub App/webhook boundary’si kullanılmalıdır.

## Dosya

```text
.github/workflows/pr-guardian-webhook.yml
```

Workflow şu event türlerinde çalışır:

| Event | Gönderilen amaç |
|---|---|
| `opened` | Yeni PR için ilk snapshot ve policy review |
| `synchronize` | PR head SHA değiştiğinde yeni immutable snapshot |
| `reopened` | Kapatılıp yeniden açılan PR’ın yeniden değerlendirilmesi |
| `ready_for_review` | Draft PR review’a hazır olduğunda değerlendirme |

Aynı PR üzerindeki hızlı güncellemelerde eski job’ın iptal edilmesi için PR başına `concurrency` grubu vardır. Workflow `contents: read`, `pull-requests: read` ve yalnızca block uyarı comment’i için `issues: write` izinlerine sahiptir. Job koşulu aynı repository kaynaklı PR’ları sınırlar; fork PR’larında repository secret’ları GitHub tarafından workflow’a verilmediği için bu Actions yolu bilinçli olarak skip edilir.

## Gerekli GitHub ayarları

Repository veya uygun environment altında aşağıdaki değerleri tanımlayın. GitHub, repository, organization ve environment seviyelerinde Actions secret’ları destekler; secret değerleri workflow’a `secrets.*` bağlamı üzerinden aktarılır.[2]

| Tür | Ad | Değer |
|---|---|---|
| Repository/Environment Variable | `PR_GUARDIAN_WEBHOOK_URL` | HUQAN server base URL’i; örneğin `https://huqan.example.com` |
| Repository/Environment Secret | `PR_GUARDIAN_WEBHOOK_SECRET` | HUQAN server’daki `GITHUB_APP_WEBHOOK_SECRET` ile aynı HMAC secret |
| Built-in Actions secret | `GITHUB_TOKEN` | GitHub tarafından workflow’a otomatik sağlanır; PR comment için job `issues: write` izni ister |

Variable veya secret oluşturmak için GitHub CLI ile:

```bash
gh secret set PR_GUARDIAN_WEBHOOK_SECRET
# URL secret değil, normal Actions variable olarak ayarlanabilir:
gh variable set PR_GUARDIAN_WEBHOOK_URL --body 'https://huqan.example.com'
```

Alternatif olarak repository **Settings → Secrets and variables → Actions** ekranından ekleyebilirsiniz.[2]

`PR_GUARDIAN_WEBHOOK_URL` tanımlı değilse job hiç çalışmaz, skip edilir. Webhook boundary'si ayrı bir deployment adımı olduğu için, henüz bir HUQAN server ayağa kaldırmamış bir repository'de her PR'ın var olmayan bir webhook yüzünden kırmızıya düşmesi istenmez. Variable tanımlandığı andan itibaren adım içi guard'lar fail-closed çalışmaya devam eder: secret eksikse, yanıt 2xx değilse veya karar tanınmıyorsa job başarısız olur.

## İstek akışı

Workflow, GitHub event metadata’sını `jq` ile yeni bir JSON payload’a çevirir. Payload doğrudan PR kodunu çalıştırmaz; yalnızca title, body, repository, PR number, base/head ref, head SHA ve actor metadata’sını içerir. Ardından aynı ham payload dosyası üzerinde:

```text
HMAC-SHA256(PR_GUARDIAN_WEBHOOK_SECRET, raw_payload)
```

hesaplanır ve `x-hub-signature-256: sha256=<hex>` header’ı ile gönderilir. Gönderimde `--data-binary` kullanılması, imzalanan byte dizisiyle HTTP body’sinin aynı kalmasını sağlar.

İstek şu endpoint’e gider:

```text
POST /api/v2/pr-guardian/webhooks/github
```

Workflow response içindeki kararı da kontrol eder:

| HUQAN kararı | Workflow davranışı |
|---|---|
| `allow` | Job başarılı olur; yalnızca izin verilen read-only/preview akışı devam eder |
| `review` | Job başarılı olur; Review Console’da operator approval beklenir |
| `dry_run_only` | Job warning ile tamamlanır; dış mutasyon yapılmadığı belirtilir |
| `block` | Job başarısız olur ve GitHub check’i başarısız olarak görünür; ardından aynı PR’a yönetilen uyarı yorumu oluşturulur veya güncellenir |
| Eksik/bilinmeyen karar | Job başarısız olur; workflow fail-closed davranır |

GitHub Actions event filtreleri, activity türleri ve branch/path kısıtları resmi workflow syntax ile tanımlanır.[1]

## Bilinçli güvenlik sınırları

Workflow `pull_request` kullandığı için PR branch’ini checkout etmez, `npm install` çalıştırmaz, test script’i çalıştırmaz ve PR’dan gelen bir dosyayı shell kodu olarak değerlendirmez. Bu nedenle webhook’a yalnızca güvenilir biçimde seçilmiş event metadata’sı gönderilir. Fork PR’larında otomatik değerlendirme istenirse, HMAC secret’ı Actions job’ına açmadan GitHub App installation token’ı ve ayrı webhook receiver kullanan bir production boundary önerilir.

HMAC secret log’a yazılmaz. Payload ve response dosyaları runner’ın geçici dizininde tutulur ve `umask 077` ile oluşturulur. Webhook HTTP response’u 2xx değilse job durur. HUQAN response’u `block` veya tanınmayan bir karar içeriyorsa job başarısız olur.

Workflow, HUQAN’ın operator approval’ını GitHub Actions içinde otomatik olarak taklit etmez. `review` kararı, Review Console’daki gerçek operator kararına bırakılır. Merge ve deploy eylemleri de PR Guardian MVP tarafından varsayılan olarak doğrudan çalıştırılmaz.

## Block uyarı yorumu

`block` kararı için `scripts/comment-pr-guardian-block.js` çalışır. Script, PR comment endpoint’ini kullanır; GitHub’da her pull request aynı zamanda bir issue olarak temsil edildiği için issue-comment API’si üzerinden yorum oluşturulur.[4] Yorum gövdesi `<!-- huqan-pr-guardian:block:v1 -->` marker’ını taşır. Script önce mevcut comment’leri listeler, aynı marker’ı taşıyan `github-actions[bot]` yorumunu bulursa `PATCH` ile günceller; yoksa `POST` ile yeni yorum oluşturur. Böylece her commit’te yeni bir uyarı spam’i üretilmez.

Yorum yalnızca webhook isteği başarılı olduktan sonra ve response kararı `block` olduğunda etkili olur. HUQAN response’u okunamazsa veya karar eksikse comment script’i başarısız olur; token yoksa veya GitHub API hata döndürürse hata gizlenmez. Workflow’un `issues: write` izni yalnızca bu comment mutation için eklenmiştir. GitHub Actions’ın `GITHUB_TOKEN` ile authenticated REST çağrıları yapabildiği ve minimum izinlerin `permissions` alanında tanımlanması gerektiği resmi belgelerde açıklanır.[5]

## Yerel doğrulama

Workflow dosyasının sözdizimini GitHub’a göndermeden önce bir YAML parser ile kontrol edin. GitHub tarafında ise workflow dosyası varsayılan branch’e ulaştıktan sonra Actions sekmesinden `pull_request` event’i için çalıştırma kaydını ve job log’undaki HTTP status/decision satırlarını inceleyin. Fork PR’larında job’ın koşullu olarak skip edilmesi beklenen davranıştır; bu PR’lar production GitHub App/webhook boundary’si üzerinden izlenmelidir.

Gerçek GitHub client’ı açıkça bağlanmamış HUQAN server’ında şu sonuç beklenir: webhook kabul edilir, review kaydı oluşur ve execute aşaması `GITHUB_EXECUTOR_UNAVAILABLE` ile fail-closed kalır. Bu davranış, workflow’un GitHub’da izinsiz mutation yapmasını engeller.

## References

[1]: https://docs.github.com/actions/using-workflows/workflow-syntax-for-github-actions "GitHub Actions workflow syntax"
[2]: https://docs.github.com/actions/security-guides/using-secrets-in-github-actions "Using secrets in GitHub Actions"
[3]: https://docs.github.com/actions/using-workflows/events-that-trigger-workflows "Events that trigger workflows"
[4]: https://docs.github.com/rest/issues/comments "REST API endpoints for issue comments"
[5]: https://docs.github.com/actions/reference/authentication-in-a-workflow "Use GITHUB_TOKEN for authentication in workflows"
