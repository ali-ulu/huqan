'use strict';
const { LABELS } = require('./semantic-teacher-contract');
const { digestOf } = require('./contradiction-eval-freeze-contract');

// Gold labels represent one teacher, never an invented independent quorum.
function adaptNliRows(rows, { sourceId, sourceVersion }) {
  if (!Array.isArray(rows) || ![sourceId, sourceVersion].every(v => typeof v === 'string' && v.trim())) throw new TypeError('nli_source_invalid');
  const records = [], teachers = [], excluded = [];
  const names = ['ENTAILMENT', 'NEUTRAL', 'CONTRADICTION'];
  for (const [index, row] of rows.entries()) {
    if (!row || ![row.premise, row.hypothesis].every(v => typeof v === 'string' && v.trim())) throw new TypeError('nli_row_invalid');
    if (row.label === -1) { excluded.push({ index, reason: 'unadjudicated' }); continue; }
    const label = Number.isInteger(row.label) ? names[row.label] : String(row.label).toUpperCase();
    if (!names.includes(label)) throw new TypeError('nli_label_invalid');
    const input = { stored: { text: row.premise }, incoming: { text: row.hypothesis } };
    const pairGroupId = `nli:${digestOf(row.premise.normalize('NFC').trim())}`;
    const bucket = Number.parseInt(digestOf(`3583|${pairGroupId}`).slice(0, 8), 16) % 100;
    records.push({ ...input, sourceId, pairGroupId, split: bucket < 80 ? 'train' : 'calibration' });
    teachers.push({ teacherId: `${sourceId}:gold`, teacherVersion: sourceVersion, input,
      distribution: Object.fromEntries(LABELS.map(name => [name, Number(name === label)])), latencyMs: 0 });
  }
  return { records, teachers, excluded };
}
module.exports = { adaptNliRows };
