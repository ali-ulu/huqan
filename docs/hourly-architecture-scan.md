# Saatlik HUQAN Mimari Taraması

## Amaç

Bu otomasyon, HUQAN deposundaki kaynak dosyalarını teker teker denetler. Her başarılı çalıştırma yalnızca **bir** JavaScript kaynak dosyasını seçer ve deterministik kuralları uygular. İlk sürüm; hassas değerlerin loglara yazılması, sabit kodlanmış olası gizli değerler, boş `catch` blokları, policy/admission referansı olmadan görünen doğrudan store yazımı ve aşırı büyümüş çekirdek dosyalar için sinyal üretir.

## Çalıştırma ve İzinler

`.github/workflows/architecture-scan.yml`, her saat başında çalışır ve Actions arayüzünden manuel olarak başlatılabilir. Workflow düzeyinde yalnızca aşağıdaki izinler tanımlanır:

| İzin | Kullanım amacı |
| --- | --- |
| `contents: read` | Kaynak dosyayı checkout edip denetlemek |
| `issues: write` | Kuyruk durumunu kalıcı olarak güncellemek ve doğrulanmış bulgular için issue açmak |

Varsayılan GitHub Actions belirteci (`GITHUB_TOKEN`) kullanılır; ayrıca bir Actions secret gerekmez. Repository veya organizasyon düzeyindeki iş akışı belirteci politikası issue yazmayı engellerse iş akışı başarısız olur ve taranan dosya kuyruğun başında kalır.

## Kalıcı Kuyruk, Tek Dosya ve Yeniden Deneme

Tarama kuyruğu, yalnızca otomasyonun kullandığı **`[HUQAN Scan] Queue State`** adlı açık GitHub issue'nun gövdesindeki sürümlü JSON durumunda tutulur. Bu yaklaşım ek bir `contents: write`, depo değişikliği veya kısa ömürlü cache gerektirmez. Durum issue'su kapatılır veya bozulursa otomasyon güvenli biçimde başarısız olur; kapatılmış/bozulmuş durumu elle düzenlemek yerine yeniden açın veya yeni bir workflow çalıştırmasıyla yeni durum issue'su oluşturun.

Bir çalışma başlamadan önce sıradaki dosya kuyruktan alınır. Issue sorgulama, issue oluşturma veya durum kaydetme başarısız olursa dosya tekrar kuyruğun başına yazılır. Durum güncellemesi başarısız olsa dahi sonraki çalıştırma önceki kuyruk durumunu kullanır; GitHub-side deduplikasyon aynı bulgu için ikinci açık issue açılmasını engeller.

## Yinelenen Issue Önleme

Her bulgu; dosya yolu, kural kimliği, satır ve özet üzerinden oluşturulmuş, kararlı bir SHA-256 parmak izi alır. Issue gövdesine `<!-- huqan-scan:<fingerprint> -->` işaretçisi eklenir. Yeni issue oluşturmadan önce açık issue'lar bu işaretçiyle kontrol edilir. Aynı bulgu zaten açıksa iş akışı onu tekrar açmaz ve dosyayı başarılı olarak tamamlar.

Tarama olası bir sır/anahtar sinyali algıladığında bulgunun kaynak değerini issue gövdesine kopyalamaz. Bulgu, dosya, kural, önem seviyesi, satır numarası ve kaynak revizyonu ile sınırlıdır.

## İşletim

Manuel tetikleme için GitHub'da **Actions → HUQAN Hourly Architecture Scan → Run workflow** yolunu kullanın. Zamanlanmış çalıştırmaların geçmişi aynı workflow ekranında görünür. Kuyruk ilerlemesi için durum issue'sunu, bulgular için `[HUQAN Scan]` ile başlayan açık issue'ları inceleyin.

| Durum | Operatör eylemi |
| --- | --- |
| Workflow başarısız | Çalışma günlüklerindeki GitHub API veya JSON durum hatasını inceleyin; sorun giderildikten sonra manuel tetikleyin. |
| Durum issue'su yanlışlıkla kapatıldı | Issue'yu yeniden açın, sonra iş akışını manuel başlatın. |
| Yanlış pozitif bulgu | İlgili issue'da teknik incelemeyi kaydedip issue'yu kapatın. Aynı parmak izi yalnızca açık issue'lara karşı deduplikasyona tabi olduğundan, kalıcı false-positive bastırma için kurala ayrı ve testli bir istisna ekleyin. |
| Beklenen yeni issue yok | İlgili parmak iziyle açık bir issue olup olmadığını kontrol edin; bulunmuyorsa iş akışı günlüğünü inceleyin. |

## Sınırlar

Bu sistem statik ve deterministik bir erken uyarı katmanıdır; tam güvenlik denetimi, kaynak kodun çalıştırılması veya production davranışının kanıtı değildir. GitHub Actions zamanlanmış iş akışları GitHub'ın planlama hizmetine bağlıdır; tam saat başında başlatılmaları garanti edilmez. Tarama sıradaki dosyayı yalnızca bir kez işler, bu nedenle depo büyüklüğüne göre tam tur birden fazla saat sürer.

## Yerel Doğrulama

```bash
python3 -m unittest discover -s scripts/architecture-scan -p 'test_*.py'
```

Bu testler kuyruk sıralaması, yeniden kuyruğa alma, kalıcı durum JSON'u, kararlı fingerprint ve kritik log bulgusunu doğrular.

