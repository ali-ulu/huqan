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
    if (!q || q.getTab() !== 'open') {
      clear();
    } else {
      // Drop anything the queue no longer offers before counting, so a decided
      // record cannot stay selected and a later batch cannot re-decide it.
      const open = new Set(q.openList().map((a) => a.id));
      for (const id of selected) if (!open.has(id)) selected.delete(id);
    }
    const count = selected.size;
    // The toolbar stays visible while the open queue has records, so "Select
    // all" is reachable before the first row is checked; only the actions wait.
    const available = Boolean(q) && q.getTab() === 'open' && q.openList().length > 0;
    toolbar.hidden = !available;
    if (!available) return;
    approveBtn.disabled = count === 0;
    rejectBtn.disabled = count === 0;
    countEl.textContent = `${count} selected`;
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
    if (!operatorKey) {
      // An empty key would let automatic mode grant the capability without the
      // operator token the batch module requires; fail closed before dispatch.
      $('#dd-error').textContent = 'Operator key is required.';
      return;
    }
    const reason = $('#dd-reason').value.trim();
    $('#dd-confirm').disabled = true;
    let succeeded = 0;
    const failed = [];
    await Promise.all(pending.ids.map((id) => q.submitDecision(id, pending.decision, reason, operatorKey)
      .then((result) => { if (result && result.ok) succeeded += 1; else failed.push(id); })
      .catch(() => { failed.push(id); /* submitDecision reports its own failure */ })));
    const verb = pending.decision === 'approved' ? 'approved' : 'rejected';
    if (succeeded > 0) toast(`${succeeded} approval${succeeded === 1 ? '' : 's'} ${verb}. Each generated its own Trust Receipt.`);
    if (failed.length > 0) {
      // Keep only the failures selected so the operator can retry them; the
      // dialog stays open so a corrected key can be re-submitted.
      selected.clear();
      failed.forEach((id) => selected.add(id));
      updateToolbar();
      $('#dd-error').textContent = `${failed.length} approval${failed.length === 1 ? '' : 's'} could not be ${verb}. They stay selected so you can retry.`;
      $('#dd-confirm').disabled = false;
      return;
    }
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
