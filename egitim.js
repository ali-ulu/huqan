'use strict';
// #363 (security): egitim demo script'i scripts/egitim-demo.js altına taşındı,
// npm "files" kapsamından çıkarıldı ve yalnızca demo modunda (HUQAN_DEMO_MODE=1
// veya --demo) çalışacak biçimde güvenlikleştirildi. Bu eski kök konum artık
// production memory'ye dokunan hiçbir iş yapmaz; yalnızca kullanıcıyı yönlendirir.
console.error('egitim.js taşındı ve güvenlikleştirildi (#363). Yeni kullanım:');
console.error('  HUQAN_DEMO_MODE=1 node scripts/egitim-demo.js --demo');
console.error('Demo yalnızca izole/geçici bir dizine yazar; production memory.json\'a asla dokunmaz.');
process.exitCode = 2;
