# Observability Dashboard Tool Usage Mix

Bu dilim, Observability dashboard’ındaki **Tool Usage Mix** grafiğinin veri yokluğu, tek araç, çoklu araç ve backend toplamı ile araç kırılımının uyuşmaması durumlarını açıkça göstermesini sağlar.

## Durum sözleşmesi

Dashboard metrics yanıtındaki `toolUsage` listesi pozitif ve sonlu sayımlara göre normalize edilir. Aynı araç adı birden fazla satırda gelirse tek legend satırında birleştirilir. `toolCallCount` geçerli ve negatif olmayan bir sayıysa gösterilen toplam olarak korunur; aksi halde pozitif araç sayımlarının toplamı kullanılır.

| Durum | Donut | Legend | Toplam |
| --- | --- | --- | --- |
| Araç çağrısı yok | Nötr boş donut | `No tool calls yet.` | `0` |
| Tek araç | Tek dilim, yüzde `100%` | Tek araç satırı | Backend toplamı |
| Birden fazla araç | Her araç için ayrı dilim | Her benzersiz araç bir kez | Backend toplamı |
| Araç toplamı ile raporlanan toplam farklı | Kırılım eksikliği açıkça işaretlenir | Fark, `Unattributed` dilimiyle gösterilir | Büyük olan toplam korunur |
| Pozitif toplam, araç ayrıntısı yok | Nötr belirsiz donut | `Tool usage breakdown unavailable.` | Raporlanan toplam |

Toplam uyuşmazlığında `obstoolmeta` alanına `total mismatch`, donut erişilebilir etiketine ise `breakdown incomplete` eklenir. Böylece grafik, eksik kırılımı tam araç dağılımı gibi sunmaz. `Unattributed` yalnızca raporlanan toplam araç kırılımından büyük olduğunda oluşturulur; araç kırılımı daha büyükse mevcut tüm pozitif sayımlar korunur ve toplam yine büyük değer olur.

## Erişilebilirlik ve güvenlik sınırı

Donut `role="img"` olarak kalır ve duruma göre `aria-label` üretir. Legend isimleri mevcut HTML escape yardımcıcısından geçirilir. Negatif, sonsuz veya sayısal olmayan araç sayımları dağılıma eklenmez; plaintext tool input/output, prompt, goal, secret veya credential bu görünümün parçası değildir.

Bu runbook yalnızca browser tarafındaki deterministik render davranışını ve mevcut authenticated metrics yanıtının okunmasını kapsar. Veri kaynağının eksik veya tutarsız olmasının nedenini teşhis etmez; backend metrics üretimini, event pagination’ını, hosted deployment’ı, external notification delivery’yi veya production SLA’yı kanıtlamaz.
