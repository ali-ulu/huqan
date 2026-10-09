# Memory Core Smoke Test Planı

AXIOM v0.9.1 sürümü release edilmeden hemen önce veya release sonrasında sistemin sağlığını end-to-end kanıtlamak için yürütülecek minimal ve kanonik doğrulama adımlarıdır.

## 1. Clean Clone Smoke
Aşağıdaki standart komut dizisi her sürüm mühürlenirken çalıştırılır:
1. `git clone` (Taze bir klon oluşturma)
2. `npm run setup:sqlite` (Kilitli dependency kurulumu ve better-sqlite3 native probe)
3. `npm test` (Tüm paketlerin 682+ senaryoyu firesiz geçmesi)

## 2. Targeted Memory Core Tests
Sadece Memory mimarisini izole test etmek için:
`node --test test/memory-schema.test.js test/memory-store.test.js test/kernel-memory.test.js test/memory-store-sqlite.test.js`

## 3. In-memory Smoke
* Yeni bir kernel veya `MemoryStore` yaratılıp `store` ve `get` komutlarıyla cache tutarlılığı test edilmelidir.
* Restart simülasyonu olmaksızın RAM üzerindeki deterministik liste sıralaması gözlenmelidir.

## 4. SQLite Smoke
* MemoryStore bir `test.db` üzerinden başlatılmalı.
* Hafızaya 5 farklı kayıt girilmeli.
* Instance tamamen kapatılıp (`db.close()`) tekrar açılmalı.
* `store.list()` çağrıldığında 5 kaydın tamamen veri kaybı yaşanmadan geri yüklenmesi kanıtlanmalıdır.

## 5. kernel.memory Smoke
* Plugin sandbox üzerinden çalışan bir tool çağrısının `kernel.memory.store` veya `query` metotlarına erişip başarılı mutasyon yapması gözlenmelidir.

## 6. Workspace Isolation Smoke
* `workspaceA` ve `workspaceB` açılarak aynı id'ye sahip (örnek: "mem-1") kayıt atılmalı.
* `get("mem-1")` çağrılarının workspace spesifik değerleri getirdiği, asla diğer workspace'e sızmadığı test edilmelidir.

## 7. Provenance / Audit Smoke
* Bir hafıza objesi `supersede` komutuyla güncellendiğinde, eski verinin audit logları veya `causalChain` listesi içinde kalıcı iz bırakıp bırakmadığı incelenmelidir.

## 8. Query/Search Smoke
* Birden çok meta tag (örnek: `status: "active"`, `priority: "high"`) içeren sorgular çalıştırılıp karmaşık mantıksal filtrelemenin hatasız array döndürdüğü görülmelidir.

## 9. Graph Link + Temporal Query Smoke
* İki ayrı kayıt arasında `linkMemories("A", "B", "supports")` işlemi yapılmalı.
* İkinci kez aynı link atıldığında no-op olduğu görülmeli.
* `timeline()` metoduyla event akışı (zaman damgaları) kronolojik sırayla validate edilmelidir.

## 10. Çevre & Kalıntı Kontrolü
* `npm test` bitiminde repoda `package-lock.json` değişimi (drift) olmamalı.
* `*.db`, `*.db-wal`, `*.db-shm` gibi SQLite temp dosyaları otomatik temizlenmiş olmalıdır.
