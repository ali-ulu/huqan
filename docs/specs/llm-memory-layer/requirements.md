# Requirements Document

## Introduction

Bu özellik, AXIOM bilgi grafiği motorunu bir **LLM doğrulama ve kişisel hafıza katmanı** haline getirir. Kullanıcı bir LLM'e (Ollama veya OpenAI) soru sorduğunda, AXIOM üretilen cevabı kendi bilgi grafiğiyle karşılaştırır ve "Doğrulandı / Çelişki var / Bilmiyorum" şeklinde bir doğrulama sonucu döner. Kullanıcı yeni bilgileri AXIOM'a öğreterek hafızayı büyütebilir. Ayrıca metin dosyaları (`.txt`, `.md`) yükleyerek AXIOM'un otomatik öğrenmesi sağlanabilir. Tüm bu işlevler mevcut AXIOM plugin sistemi üzerine inşa edilir.

## Glossary

- **LLM_Adapter**: Ollama veya OpenAI API'sine bağlanan, istek gönderip yanıt alan bileşen.
- **Verifier**: LLM yanıtını AXIOM bilgi grafiğiyle karşılaştıran ve doğrulama kararı üreten bileşen.
- **Document_Loader**: `.txt` ve `.md` dosyalarını okuyup AXIOM'a cümle cümle öğreten bileşen.
- **LLM_Memory_Plugin**: Tüm bu bileşenleri AXIOM plugin sistemi aracılığıyla birleştiren ana plugin.
- **Doğrulama_Sonucu**: Verifier'ın ürettiği üç değerden biri: `doğrulandı`, `çelişki`, `bilinmiyor`.
- **Güven_Skoru**: Doğrulama kararının 0.0–1.0 arasındaki sayısal güvenilirlik değeri.
- **Hafıza**: AXIOM'un `graph.js` üzerinde sakladığı bilgi grafiği.

---

## Requirements

### Requirement 1: LLM Adaptör Entegrasyonu

**User Story:** Bir geliştirici olarak, AXIOM'un Ollama ve OpenAI API'lerine bağlanabilmesini istiyorum; böylece yerel veya bulut tabanlı LLM'lerden yanıt alabileyim.

#### Acceptance Criteria

1. WHEN bir kullanıcı Ollama ile sorgu gönderdiğinde, THE LLM_Adapter SHALL `http://localhost:11434/api/generate` adresine POST isteği göndererek yanıt döndürür.
2. WHEN bir kullanıcı OpenAI ile sorgu gönderdiğinde, THE LLM_Adapter SHALL `OPENAI_API_KEY` ortam değişkenini kullanarak OpenAI Chat Completions API'sine istek gönderir.
3. IF LLM_Adapter bir ağ hatası veya zaman aşımı alırsa, THEN THE LLM_Adapter SHALL hata mesajını içeren bir nesne döndürür, exception fırlatmaz ve işlemi durdurmaz.
4. THE LLM_Adapter SHALL sağlayıcı adını (`ollama` veya `openai`) ve model adını yapılandırılabilir parametre olarak kabul eder.
5. WHERE OpenAI entegrasyonu etkinleştirilmişse, THE LLM_Adapter SHALL `OPENAI_API_KEY` ortam değişkeni tanımlı değilse hata fırlatır.

---

### Requirement 2: LLM Yanıt Doğrulama

**User Story:** Bir kullanıcı olarak, LLM'in ürettiği yanıtın AXIOM'un bilgi grafiğiyle tutarlı olup olmadığını görmek istiyorum; böylece yanlış bilgileri fark edebileyim.

#### Acceptance Criteria

1. WHEN Verifier bir LLM yanıtı ve bir soru alırsa, THE Verifier SHALL yanıttaki anahtar kavramları AXIOM bilgi grafiğindeki düğümlerle karşılaştırır.
2. WHEN karşılaştırma tamamlandığında, THE Verifier SHALL `doğrulandı`, `çelişki` veya `bilinmiyor` değerlerinden birini ve 0.0–1.0 arasında bir Güven_Skoru döndürür.
3. WHEN AXIOM bilgi grafiğinde ilgili düğüm veya kenar bulunmadığında, THE Verifier SHALL `bilinmiyor` kararını ve 0.0 Güven_Skoru'nu döndürür.
4. WHEN LLM yanıtındaki bir kavram AXIOM'daki bir kavramla çelişen bir ilişki içeriyorsa, THE Verifier SHALL `çelişki` kararını ve çelişen düğümlerin listesini döndürür.
5. THE Verifier SHALL doğrulama kararını, Güven_Skoru'nu ve bulunan eşleşen veya çelişen düğümleri (hangisi mevcutsa) içeren yapılandırılmış bir nesne döndürür.

---

### Requirement 3: Kişisel Hafıza Büyütme

**User Story:** Bir kullanıcı olarak, LLM'in ürettiği yeni ve doğru bilgileri AXIOM'a öğretebilmek istiyorum; böylece hafıza zamanla büyüsün.

#### Acceptance Criteria

1. WHEN bir kullanıcı `öğret-llm:` komutuyla bir LLM yanıtını onaylarsa, THE LLM_Memory_Plugin SHALL yanıttaki cümleleri ayrıştırarak AXIOM Kernel'inin `learn()` metoduna iletir.
2. WHEN yeni bilgi AXIOM'a eklendikten sonra, THE LLM_Memory_Plugin SHALL `graph.save()` metodunu çağırarak hafızayı kalıcı hale getirir.
3. IF öğretilmeye çalışılan bilgi AXIOM'da zaten mevcutsa, THEN THE LLM_Memory_Plugin SHALL mevcut düğümün ağırlığını artırır ve yinelenen düğüm oluşturmaz.
4. THE LLM_Memory_Plugin SHALL öğrenilen cümle sayısını ve eklenen düğüm/kenar sayısını içeren bir özet döndürür.

---

### Requirement 4: Belge ve Not Yükleme

**User Story:** Bir kullanıcı olarak, `.txt` ve `.md` dosyalarını AXIOM'a yükleyerek içeriklerini otomatik olarak öğretmek istiyorum; böylece büyük bilgi tabanlarını hızlıca aktarabileyim.

#### Acceptance Criteria

1. WHEN Document_Loader bir `.txt` veya `.md` dosyası yolu alırsa, THE Document_Loader SHALL dosyayı satır satır okuyarak her satırı AXIOM Kernel'inin `learn()` metoduna iletir.
2. WHEN Document_Loader bir `.md` dosyası işlerken, THE Document_Loader SHALL Markdown başlık işaretlerini (`#`, `##`, `###`) ve kod bloklarını temizler.
3. IF belirtilen dosya yolu mevcut değilse veya okunamıyorsa, THEN THE Document_Loader SHALL açıklayıcı bir hata mesajı döndürür ve işlemi durdurmaz.
4. THE Document_Loader SHALL yükleme tamamlandığında işlenen satır sayısını, öğrenilen cümle sayısını ve atlanan satır sayısını içeren bir özet döndürür.
5. WHILE Document_Loader büyük bir dosyayı işlerken, THE Document_Loader SHALL her 100 satırda bir ilerleme bilgisi yayınlar.

---

### Requirement 5: Plugin Entegrasyonu

**User Story:** Bir geliştirici olarak, LLM hafıza katmanının mevcut AXIOM plugin sistemiyle uyumlu olmasını istiyorum; böylece mevcut kodu değiştirmeden özelliği etkinleştirebileyim.

#### Acceptance Criteria

1. THE LLM_Memory_Plugin SHALL `plugin.js` içindeki `PluginManager` tarafından tanınan `name`, `init`, `afterAsk` ve `afterLearn` alanlarını içerir.
2. WHEN LLM_Memory_Plugin yüklendiğinde, THE LLM_Memory_Plugin SHALL `plugins/` dizinine yerleştirilerek `Kernel` tarafından otomatik olarak yüklenir.
3. WHEN `afterAsk` olayı tetiklendiğinde, THE LLM_Memory_Plugin SHALL soruyu LLM'e iletir, yanıtı alır ve Verifier aracılığıyla doğrulama sonucunu üretir.
4. THE LLM_Memory_Plugin SHALL LLM sağlayıcısını, model adını ve doğrulama eşiğini yapılandırılabilir seçenekler olarak kabul eder.
5. IF LLM_Memory_Plugin devre dışı bırakılırsa, THEN THE LLM_Memory_Plugin SHALL AXIOM'un diğer işlevlerini etkilemez.

---

### Requirement 6: CLI ve Web Arayüzü Entegrasyonu

**User Story:** Bir kullanıcı olarak, mevcut AXIOM CLI ve web arayüzünden LLM doğrulama ve belge yükleme özelliklerini kullanabilmek istiyorum.

#### Acceptance Criteria

1. WHEN bir kullanıcı CLI'da `llm-sor: <soru>` komutunu girdiğinde, THE CLI SHALL soruyu LLM'e iletir, yanıtı alır ve Verifier sonucuyla birlikte ekrana yazdırır.
2. WHEN bir kullanıcı CLI'da `yükle: <dosya_yolu>` komutunu girdiğinde, THE CLI SHALL Document_Loader'ı çağırır ve yükleme özetini ekrana yazdırır.
3. WHEN web arayüzünde `/api` endpoint'ine `llm-sor:` önekiyle istek geldiğinde, THE Server SHALL LLM yanıtını ve doğrulama sonucunu JSON formatında döndürür.
4. THE CLI SHALL `llm-sor:` ve `yükle:` komutlarını `parse()` metoduna ekler ve mevcut komutlarla çakışmaz.
5. IF LLM_Adapter yapılandırılmamışsa, THEN THE CLI SHALL kullanıcıya yapılandırma talimatlarını içeren bir mesaj gösterir.
