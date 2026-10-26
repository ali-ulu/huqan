'use strict';

// Batch approval selection and its bulk-decision dialog (#4293).
//
// The queue and the single-decision dialog stay in control-room-approvals.js;
// this module owns only the selection set and the one dialog that applies a
// decision to every selected record. It reads the queue's primitives through
// window.HuqanControlRoomApprovals.batch, so a bulk decision reuses the same
// submitDecision path -- and therefore the same per-record Trust Receipt -- as a
// single decision. Model self-approval stays impossible: the operator key is
// still required and each record is decided on its own.

if (typeof window !== 'undefined') {
(function () {
  const UI = window.HuqanControlRoomUI;
  const { $, esc, toast } = UI;

  const selected = new Set();
  const queue = () => (window.HuqanControlRoomApprovals && window.HuqanControlRoomApprovals.batch) || null;

  function renderSelect(id) {
    return `<div class="ticket-select"><input type="checkbox" class="approval-select" data-id="${esc(id)}" ${selected.has(id) ? 'checked' : ''} data-role-hide="viewer" aria-label="Select approval"></div>`;
  }

  function clear() { selected.clear(); }

  function updateToolbar() {
    const toolbar = $('#appr-toolbar');
    const approveBtn = $('#batch-approve');
    const rejectBtn = $('#batch-reject');
    const countEl = $('#batch-count');
    if (!toolbar || !approveBtn || !rejectBtn || !countEl) return;
    const q = queue();
    if (!q || q.getTab() !== 'open') clear();
    const count = selected.size;
    if (count > 0 && q) {
      toolbar.hidden = false;
      approveBtn.disabled = false;
      rejectBtn.disabled = false;
      countEl.textContent = `${count} selected`;
    } else {
      toolbar.hidden = true;
    }
  }

  function openBatchDialog(decision) {
    const q = queue();
    const ids = Array.from(selected);
    if (!q || ids.length === 0) return;
    q.setPending({ id: '__batch__', decision, purpose: 'batch', ids });
    const action = decision === 'approved' ? 'Approve' : 'Reject';
    $('#dd-title').textContent = `Batch ${action} ${ids.length} approval${ids.length > 1 ? 's' : ''}?`;
    $('#dd-summary').textContent = 'Each will generate its own Trust Receipt.';
    $('#dd-reason-field').hidden = decision !== 'rejected';
    $('#dd-key-field').hidden = false;
    $('#dd-reason').value = '';
    $('#dd-key').value = '';
    $('#dd-error').textContent = '';
    const confirm = $('#dd-confirm');
    confirm.textContent = action;
    confirm.className = `btn ${decision === 'rejected' ? 'danger' : 'primary'}`;
    confirm.disabled = false;
    $('#decide-dialog').hidden = false;
    $('#scrim').classList.add('on');
    $('#dd-key').focus();
  }

  // The confirm button is the dialog form's submit button, so the bulk path
  // calls preventDefault to keep the queue's single-decision submit handler out
  // of it. The check runs first so the same listener leaves a single decision
  // (purpose 'decide'/'enable-auto') to the form's own submit untouched.
  async function confirmBatch(e) {
    const q = queue();
    const pending = q && q.pending();
    if (!q || !pending || pending.purpose !== 'batch') return;
    e.preventDefault();
    const operatorKey = $('#dd-key').value;
    const reason = $('#dd-reason').value.trim();
    $('#dd-confirm').disabled = true;
    let succeeded = 0;
    await Promise.all(pending.ids.map((id) => q.submitDecision(id, pending.decision, reason, operatorKey)
      .then((result) => { if (result && result.ok) succeeded += 1; })
      .catch(() => { /* submitDecision reports its own failure */ })));
    toast(`${succeeded} approval${succeeded === 1 ? '' : 's'} ${pending.decision === 'approved' ? 'approved' : 'rejected'}. Each generated its own Trust Receipt.`);
    clear();
    updateToolbar();
    q.closeDialog();
  }

  document.addEventListener('click', (e) => {
    const q = queue();
    if (!q) return;
    const checkbox = e.target.closest('.approval-select');
    if (checkbox) {
      if (checkbox.checked) selected.add(checkbox.dataset.id);
      else selected.delete(checkbox.dataset.id);
      updateToolbar();
      return;
    }
    if (e.target.id === 'batch-select-all') {
      if (e.target.checked) q.openList().forEach((a) => selected.add(a.id));
      else clear();
      q.renderQueue();
      updateToolbar();
      return;
    }
    if (e.target.id === 'batch-approve') { openBatchDialog('approved'); return; }
    if (e.target.id === 'batch-reject') { openBatchDialog('rejected'); }
  });

  $('#dd-confirm')?.addEventListener('click', confirmBatch);

  window.HuqanControlRoomApprovalsBatch = { renderSelect, clear, updateToolbar };
})();
}
