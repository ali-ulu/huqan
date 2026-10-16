'use strict';

/**
 * Fitness dashboard grafik/parça üreticileri (#2244).
 *
 * scripts/fitness-dashboard.js'ten sorumluluk bazında ayrıldı: SVG zaman
 * serileri, kayıt tablosu ve eşik paneli burada; HTML sayfa kompozisyonu
 * ve CLI fitness-dashboard.js'te kalır. Dış bağımlılık yok — grafikler
 * inline SVG, panoya uzak kaynak yüklenmez.
 */

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

module.exports = {
  GRADE_BANDS,
  COMPONENT_LABELS,
  COMPONENT_ORDER,
  escapeHtml,
  gradeColor,
  gradeLabel,
  fmtTs,
  buildScoreSvg,
  buildComponentSvg,
  buildRecordsTable,
  buildThresholdsPanel,
};
