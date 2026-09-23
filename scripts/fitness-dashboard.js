'use strict';

/**
 * HUQAN fitness dashboard — .fitness-history.jsonl dosyasını okuyup
 * kendi kendine yeten (self-contained) bir HTML panoya çevirir.
 *
 * Sorumluluklar #2244 ile ikiye ayrıldı:
 *   - scripts/fitness-dashboard-charts.js: SVG zaman serileri, kayıt
 *     tablosu, eşik paneli ve ortak kaçış/grade yardımcıları
 *   - bu dosya: HTML sayfa kompozisyonu ve CLI girişi
 *
 * Dış bağımlılık yok: grafikler inline SVG, stiller inline CSS. Panoya
 * hiçbir uzak font, script veya kaynak yüklenmez; tamamen kapalı bir
 * HTML dosyası üretir.
 *
 * Girdi: lib/fitness-history.js#readFitnessHistory çıktısı (entry listesi).
 */

const fs = require('node:fs');
const { readFitnessHistory } = require('../lib/fitness-history');
const {
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  buildComponentSvg,
  buildRecordsTable,
  buildScoreSvg,
  buildThresholdsPanel,
  escapeHtml,
  fmtTs,
  gradeColor,
  gradeLabel,
} = require('./fitness-dashboard-charts');

function buildFitnessDashboard(entries, opts = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const title = escapeHtml(opts.title || 'HUQAN Fitness Geçmişi');
  const last = list.length ? list[list.length - 1] : null;
  const lastScore = last && typeof last.score === 'number' ? last.score : null;

  const metricCards = `
    <div class="metrics">
      <div class="metric"><div class="metric-label">Kayıt</div><div class="metric-value">${list.length}</div></div>
      <div class="metric"><div class="metric-label">Son skor</div><div class="metric-value" style="color:${gradeColor(lastScore)}">${lastScore === null ? '—' : lastScore.toFixed(2)}</div></div>
      <div class="metric"><div class="metric-label">Son not</div><div class="metric-value">${escapeHtml((last && last.grade) || '—')}</div></div>
      <div class="metric"><div class="metric-label">Son kayıt</div><div class="metric-value metric-sm">${escapeHtml(last ? fmtTs(last.ts) : '—')}</div></div>
    </div>`;

  const componentCards = COMPONENT_ORDER
    .map((name) => `<section class="card"><h2>${escapeHtml(COMPONENT_LABELS[name] || name)}</h2>${buildComponentSvg(list, name)}</section>`)
    .join('\n');

  return `<!doctype html>
<html lang="tr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif; background: #f1f5f9; color: #0f172a; padding: 24px; }
  .wrap { max-width: 1080px; margin: 0 auto; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .sub { color: #64748b; font-size: 13px; margin-bottom: 20px; }
  .metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 20px; }
  .metric { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 10px; padding: 14px 16px; }
  .metric-label { font-size: 12px; color: #64748b; text-transform: uppercase; letter-spacing: .04em; }
  .metric-value { font-size: 26px; font-weight: 700; margin-top: 2px; }
  .metric-sm { font-size: 14px; font-weight: 500; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(360px, 1fr)); gap: 16px; }
  .card { background: #ffffff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px; }
  .card h2 { font-size: 14px; margin: 0 0 12px; color: #334155; }
  .records { width: 100%; border-collapse: collapse; font-size: 13px; background: #ffffff; border-radius: 12px; overflow: hidden; border: 1px solid #e2e8f0; }
  .records th, .records td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #eef2f7; white-space: nowrap; }
  .records th { background: #f8fafc; color: #475569; font-weight: 600; font-size: 12px; }
  .records tr:last-child td { border-bottom: none; }
  .grade { display: inline-block; min-width: 22px; text-align: center; color: #ffffff; border-radius: 6px; padding: 1px 6px; font-weight: 700; }
  .mono { font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #475569; }
  .muted { color: #94a3b8; }
  .thr-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
  .thr { background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 12px; display: flex; justify-content: space-between; }
  .thr span { color: #475569; font-size: 13px; }
  .thr strong { font-size: 15px; }
  section.card { margin-bottom: 16px; }
</style>
</head>
<body>
<div class="wrap">
  <h1>${title}</h1>
  <div class="sub">Kendi kendine yeten panoya — fitness geçmişi zaman serisi (lib/fitness-history.js)</div>
  ${metricCards}
  ${buildThresholdsPanel(opts.thresholds)}
  <section class="card"><h2>Skor zaman serisi</h2>${buildScoreSvg(list)}</section>
  <div class="grid">${componentCards}</div>
  <h2 style="font-size:14px;color:#334155;margin:20px 0 8px;">Kayıtlar (son ${escapeHtml(String(opts.limit || 20))})</h2>
  ${buildRecordsTable(list, opts.limit || 20)}
</div>
</body>
</html>`;
}

function loadThresholdsFile(path) {
  if (!path) return undefined;
  try {
    return JSON.parse(fs.readFileSync(path, 'utf8'));
  } catch (_e) {
    return undefined;
  }
}

function main(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--input' || a === '-i') { args.input = argv[++i]; }
    else if (a === '--output' || a === '-o') { args.output = argv[++i]; }
    else if (a === '--title') { args.title = argv[++i]; }
    else if (a === '--thresholds') { args.thresholds = loadThresholdsFile(argv[++i]); }
    else if (a === '--limit') { args.limit = Number(argv[++i]) || 20; }
  }
  if (!args.input || !args.output) {
    process.stderr.write('Kullanım: node scripts/fitness-dashboard.js --input <history.jsonl> --output <dashboard.html> [--title "..."] [--thresholds <thresholds.json>] [--limit N]\n');
    process.exitCode = 2;
    return;
  }
  const entries = readFitnessHistory(args.input, args.limit || 200);
  const html = buildFitnessDashboard(entries, {
    title: args.title,
    thresholds: args.thresholds,
    limit: args.limit || 20,
  });
  fs.writeFileSync(args.output, html, 'utf8');
  process.stdout.write(`Yazıldı: ${args.output} (${entries.length} kayıt)\n`);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  buildFitnessDashboard,
  buildScoreSvg,
  buildComponentSvg,
  buildRecordsTable,
  buildThresholdsPanel,
  escapeHtml,
  gradeColor,
  gradeLabel,
};
