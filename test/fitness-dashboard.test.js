'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  buildFitnessDashboard,
  escapeHtml,
  gradeColor,
  gradeLabel,
} = require('../scripts/fitness-dashboard');

function sampleEntry(score, grade, ts = '2026-08-29T10:00:00.000Z') {
  return {
    type: 'fitness',
    ts,
    workspaceId: 'default',
    score,
    grade,
    components: [
      { name: 'evidenceCoverage', value: 0.5 },
      { name: 'hypothesisAccuracy', value: null },
      { name: 'connectivity', value: 0.75 },
      { name: 'consistency', value: 0.5 },
    ],
    meta: { nodeCount: 4, edgeCount: 3 },
  };
}

test('boş geçmiş: panoya "veri yok" işareti düşer', () => {
  const html = buildFitnessDashboard([], {});
  assert.ok(html.includes('<!doctype html>'));
  assert.ok(html.includes('Kayıtlı fitness verisi yok'));
});

test('score + grade + SVG panoya işlenir', () => {
  const html = buildFitnessDashboard([sampleEntry(0.9, 'A'), sampleEntry(0.4, 'F')], {});
  assert.ok(html.includes('<svg'));
  assert.ok(html.includes('0.90'));
  assert.ok(html.includes('0.40'));
  assert.ok(html.includes('A'));
  assert.ok(html.includes('F'));
  assert.ok(html.includes('Kanıt kapsamı'));
});

test('HTML kaçışı: workspaceId içindeki işaretler etkisizleşir', () => {
  const evil = sampleEntry(0.5, 'C');
  evil.workspaceId = '<script>alert(1)</script>';
  const html = buildFitnessDashboard([evil], {});
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('escapeHtml tekil-tırnak ve ve-işaretini de kaçar', () => {
  assert.strictEqual(escapeHtml(`<a href="x">'&</a>`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&lt;/a&gt;');
});

test('gradeColor/gradeLabel bantları doğru eşler', () => {
  assert.strictEqual(gradeColor(0.95), '#16a34a');
  assert.strictEqual(gradeColor(0.5), '#ef4444');
  assert.strictEqual(gradeColor(null), '#9ca3af');
  assert.strictEqual(gradeLabel(0.85), 'B');
  assert.strictEqual(gradeLabel(0.55), 'F');
  assert.strictEqual(gradeLabel(null), '—');
});

test('null score kaydı grafikte atlanır ama tabloda görünür', () => {
  const html = buildFitnessDashboard([sampleEntry(null, null)], {});
  assert.ok(html.includes('Kayıtlı fitness verisi yok'));
  assert.ok(html.includes('—'));
});
