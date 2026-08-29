'use strict';

/**
 * HUQAN fitness dashboard — .fitness-history.jsonl dosyasını okuyup
 * kendi kendine yeten (self-contained) bir HTML panoya çevirir.
 *
 * Dış bağımlılık yok: grafikler inline SVG, stiller inline CSS. Panoya
 * hiçbir uzak font, script veya kaynak yüklenmez; tamamen kapalı bir
 * HTML dosyası üretir.
 *
 * Girdi: lib/fitness-history.js#readFitnessHistory çıktısı (entry listesi).
 */

const fs = require('node:fs');
const { readFitnessHistory } = require('../lib/fitness-history');

const GRADE_BANDS = [
  { min: 0.9, grade: 'A', color: '#16a34a' },
  { min: 0.8, grade: 'B', color: '#84cc16' },
  { min: 0.7, grade: 'C', color: '#eab308' },
  { min: 0.6, grade: 'D', color: '#f97316' },
  { min: 0.0, grade: 'F', color: '#ef4444' },
];

const COMPONENT_LABELS = {
  evidenceCoverage: 'Kanıt kapsamı',
  hypothesisAccuracy: 'Hipotez isabeti',
  connectivity: 'Bağlantılılık',
  consistency: 'Tutarlılık',
};

const COMPONENT_ORDER = [
  'evidenceCoverage',
  'hypothesisAccuracy',
  'connectivity',
  'consistency',
];

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function gradeColor(score) {
  if (score === null || score === undefined) return '#9ca3af';
  for (const band of GRADE_BANDS) {
    if (score >= band.min) return band.color;
  }
  return '#ef4444';
}

function gradeLabel(score) {
  if (score === null || score === undefined) return '—';
  for (const band of GRADE_BANDS) {
    if (score >= band.min) return band.grade;
  }
  return 'F';
}

/** Sıralı (ts artan) entry listesini sayısal değerli kayıtlara indirger. */
function numericSeries(entries, field) {
  return entries
    .filter((e) => typeof e[field] === 'number')
    .map((e) => e[field]);
}

function fmtTs(ts) {
  if (typeof ts !== 'string') return '—';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return escapeHtml(ts);
  return d.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * score zaman serisini SVG'ye çizer. Grade bantları arka planda yatay
 * şeritler halinde gösterilir; çizgi + noktalar score gidişini verir.
 */
function buildScoreSvg(entries) {
  const scored = entries.filter((e) => typeof e.score === 'number');
  const width = 800;
  const height = 320;
  const padL = 46;
  const padR = 20;
  const padT = 18;
  const padB = 40;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const xOf = (i) => (scored.length <= 1 ? padL + plotW / 2 : padL + (i / (scored.length - 1)) * plotW);
  const yOf = (score) => padT + (1 - score) * plotH;

  let bandRects = '';
  for (const band of GRADE_BANDS) {
    const yTop = yOf(Math.min(1, band.min));
    const yBot = band.grade === 'F' ? padT + plotH : yOf(Math.min(1, band.min + 0.1));
    bandRects += `<rect x="${padL}" y="${yTop.toFixed(1)}" width="${plotW}" height="${Math.max(0, yBot - yTop).toFixed(1)}" fill="${band.color}" opacity="0.10"></rect>`;
  }

  // Y ekseni: 0.0 .. 1.0 kademe
  let yTicks = '';
  for (let v = 0; v <= 10; v += 1) {
    const score = v / 10;
    const y = yOf(score);
    yTicks += `<line x1="${padL - 5}" y1="${y.toFixed(1)}" x2="${padL}" y2="${y.toFixed(1)}" stroke="#cbd5e1"></line>`;
    yTicks += `<text x="${padL - 9}" y="${(y + 4).toFixed(1)}" text-anchor="end" font-size="11" fill="#64748b">${score.toFixed(1)}</text>`;
  }

  let points = '';
  let polyline = '';
  scored.forEach((e, i) => {
    const x = xOf(i);
    const y = yOf(e.score);
    points += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4" fill="${gradeColor(e.score)}" stroke="#ffffff" stroke-width="1.5"><title>${escapeHtml(fmtTs(e.ts))} — score ${e.score}</title></circle>`;
    polyline += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  });

  const last = scored.length ? scored[scored.length - 1] : null;
  const lastScoreText = last ? `<text x="${padL + plotW - 6}" y="${padT + 16}" text-anchor="end" font-size="14" font-weight="700" fill="${gradeColor(last.score)}">${last.score} · ${gradeLabel(last.score)}</text>` : '';

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="Fitness skoru zaman serisi">
  ${bandRects}
  ${yTicks}
  <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#cbd5e1"></line>
  ${polyline ? `<polyline points="${polyline.trim()}" fill="none" stroke="#0f172a" stroke-width="2"></polyline>` : ''}
  ${points}
  ${lastScoreText}
  ${scored.length === 0 ? `<text x="${padL + plotW / 2}" y="${padT + plotH / 2}" text-anchor="middle" font-size="14" fill="#94a3b8">Kayıtlı fitness verisi yok</text>` : ''}
</svg>`;
}

/** Bir bileşenin değer serisini mini SVG olarak çizer. */
function buildComponentSvg(entries, name) {
  const rows = entries.filter((e) => {
    const c = (e.components || []).find((x) => x.name === name);
    return c && typeof c.value === 'number';
  });
  const width = 360;
  const height = 110;
  const padL = 34;
  const padR = 8;
  const padT = 10;
  const padB = 20;
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;
  const xOf = (i) => (rows.length <= 1 ? padL + plotW / 2 : padL + (i / (rows.length - 1)) * plotW);
  const yOf = (v) => padT + (1 - v) * plotH;

  let polyline = '';
  let points = '';
  rows.forEach((row, i) => {
    const c = row.components.find((x) => x.name === name);
    const x = xOf(i);
    const y = yOf(c.value);
    points += `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="#0ea5e9"><title>${escapeHtml(fmtTs(row.ts))} — ${escapeHtml(COMPONENT_LABELS[name] || name)} ${c.value}</title></circle>`;
    polyline += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)} `;
  });

  return `<svg viewBox="0 0 ${width} ${height}" width="100%" height="auto" role="img" aria-label="${escapeHtml(COMPONENT_LABELS[name] || name)} zaman serisi">
  <line x1="${padL}" y1="${padT + plotH}" x2="${padL + plotW}" y2="${padT + plotH}" stroke="#e2e8f0"></line>
  <line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + plotH}" stroke="#e2e8f0"></line>
  ${polyline ? `<polyline points="${polyline.trim()}" fill="none" stroke="#0ea5e9" stroke-width="1.8"></polyline>` : ''}
  ${points}
  ${rows.length === 0 ? `<text x="${padL + plotW / 2}" y="${padT + plotH / 2}" text-anchor="middle" font-size="12" fill="#94a3b8">veri yok</text>` : ''}
</svg>`;
}

function buildRecordsTable(entries, limit) {
  const rows = entries.slice(-limit).reverse();
  const body = rows
    .map((e) => {
      const score = typeof e.score === 'number' ? e.score : null;
      const comps = COMPONENT_ORDER.map((name) => {
        const c = (e.components || []).find((x) => x.name === name);
        return c && typeof c.value === 'number' ? c.value.toFixed(2) : '·';
      }).join('</td><td>');
      return `<tr>
        <td class="mono">${escapeHtml(fmtTs(e.ts))}</td>
        <td>${escapeHtml(e.workspaceId)}</td>
        <td><strong>${score === null ? '—' : score.toFixed(2)}</strong></td>
        <td><span class="grade" style="background:${gradeColor(score)}">${escapeHtml(e.grade || '—')}</span></td>
        <td>${comps}</td>
      </tr>`;
    })
    .join('\n');
  const header = `<tr><th>Zaman</th><th>Workspace</th><th>Skor</th><th>Not</th><th>${COMPONENT_ORDER.map((n) => escapeHtml(COMPONENT_LABELS[n] || n)).join('</th><th>')}</th></tr>`;
  return `<table class="records"><thead>${header}</thead><tbody>${body || '<tr><td colspan="9" class="muted">Kayıt yok</td></tr>'}</tbody></table>`;
}

function buildThresholdsPanel(thresholds) {
  if (!thresholds || typeof thresholds !== 'object') return '';
  const keys = [
    ['confidenceFloor', 'Güven tabanı'],
    ['criticalInDegree', 'Kritik giriş derecesi'],
    ['smallComponentSize', 'Küçük bileşen boyutu'],
    ['minScore', 'Min skor'],
    ['entropyFloor', 'Entropi tabanı'],
  ];
  const rows = keys
    .filter(([k]) => typeof thresholds[k] === 'number')
    .map(([k, label]) => `<div class="thr"><span>${escapeHtml(label)}</span><strong>${thresholds[k]}</strong></div>`)
    .join('\n');
  return rows ? `<section class="card"><h2>Güncel eşikler (autoTune)</h2><div class="thr-grid">${rows}</div></section>` : '';
}

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
  escapeHtml,
  gradeColor,
  gradeLabel,
};
