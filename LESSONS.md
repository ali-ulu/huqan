# LESSONS

## KALICI KURALLAR

- Bir modülün "çalıştığını" söylemeden önce ÇAĞIRANINI oku. Modülü izole
  ölçmek, o modülün üründe iş gördüğüne kanıt değildir. Çağıranı okumadıysan
  cümleyi "ölçmedim" diye kur. Aranabilir: CAGIRAN-KONTROL.

- Kullanıcının sorusunu yeniden etiketleme. Verdict/başlık/özet cümlelerinde
  kullanıcının kendi terimini birebir kullan; repo dokümanlarından okunan
  benzer ama daha dar/geniş etiketi onun yerine geçirme. Terim farkı kapsam
  farkı demektir; kapsam belirsizse varsayma, sor.

## 2026-08-18 — HUQAN / agent action firewall hazırlık değerlendirmesi

- HATA: Kullanıcının "agent action firewall" sorusu, cevabın verdict bölümünde
  "coding agent action firewall" olarak yeniden etiketlendi.
- KÖK NEDEN: `docs/v4/v4-pr-plan.md:146` içindeki "Coding Agent Action Firewall"
  demo adı, kullanıcının sorusunun etiketi sanılıp verdict başlığına taşındı.
- KURAL: Değerlendirme/rapor çıktısında kapsam etiketini kullanıcının cümlesinden
  al; repo dokümanından gelen etiketi kullanacaksan kaynağını açıkça yaz ve
  kullanıcının terimiyle karıştırma.
- KAPSAM: Tüm repo; özellikle hazırlık/readiness, audit ve değerlendirme raporları.

## 2026-08-18 — HUQAN / agent-action-gate hook (env sözleşmesi)

- HATA: Yeni hook `process.env.HUQAN_*` değişkenlerini doğrudan okudu; commit
  "tamam" diye raporlandıktan sonra repo'nun kendi testi yakaladı.
- KÖK NEDEN: `lib/environment-compat.js` sözleşmesi (AXIOM_ fallback + çakışma
  kontrolü) okunmadan yeni bir production entry point yazıldı.
- KURAL: Yeni bir runtime dosyası eklerken, o dosyanın dokunduğu her ortak
  kaynak için (env, path, log, config) repo'da zaten bir sözleşme modülü olup
  olmadığını `grep` ile ara; varsa onu kullan.
- KAPSAM: Tüm repo; özellikle yeni `scripts/` ve `lib/` runtime dosyaları.

## 2026-08-18 — HUQAN / AB11 cross-workspace (yanlış teşhis)

- HATA: "AB11 workspace metadata gelmezse sessizce atlanıyor, fail-closed
  olmalı" denip yama yazıldı; yama merge edilseydi `workspaceId` alan her
  şemaya uygun MCP çağrısı bloklanacaktı.
- KÖK NEDEN: Gate ve adaptör izole ölçüldü, çağıran ölçülmedi. `mcpServer.js`
  gate'i her zaman `metadata: {}` ile çağırıyor, yani aktör tarafı üretim
  yolunda hiçbir zaman beyan edilmiyor. Mevcut bir test de bu davranışı zaten
  kilitliyordu.
- KURAL: Bir gate'in girdisini "eksik geliyor" diye nitelemeden önce, o girdiyi
  üreten üretim çağrısını oku ve girdinin tatmin edilebilir olup olmadığını
  göster. Tatmin edilemiyorsa sorun adaptörde değil çağırandadır.
- KAPSAM: `lib/mcp-gate-adapter.js` ve tüm AB gate bağlantıları.
