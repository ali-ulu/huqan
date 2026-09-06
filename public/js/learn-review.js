'use strict';

// `learn-review` is intentionally separate from the generic claim dispatcher:
// its successful outcome is a durable pending approval, never a canonical learn.
const LEARN_REVIEW_WORKFLOW = 'learn-review';

function isLearnReviewSelected() {
  return $('action').value === LEARN_REVIEW_WORKFLOW;
}

function toggleLearnReviewFields() {
  const selected = isLearnReviewSelected();
  $('learnsourcefield').hidden = !selected;
  $('learnreffield').hidden = !selected;
  $('learntitlefield').hidden = !selected;
  if (selected) {
    $('promptlabel').textContent = 'Fact to propose';
    $('prompt').placeholder = 'Describe the fact to send for human review…';
    $('run').textContent = 'Send for human review';
    $('review').disabled = true;
  } else {
    $('run').textContent = 'Run';
    $('review').disabled = !state.lastPrompt;
  }
}

function learnReviewBody(text) {
  const body = { workspaceId: state.ws, text };
  const sourceType = $('learnsource').value.trim();
  const sourceRef = $('learnref').value.trim();
  const sourceTitle = $('learntitle').value.trim();
  if (sourceType) body.sourceType = sourceType;
  if (sourceRef) body.sourceRef = sourceRef;
  if (sourceTitle) body.sourceTitle = sourceTitle;
  return body;
}

function renderPendingLearn(response) {
  const approvalId = response.data?.approvalId || response.approval?.id || '';
  const candidateId = response.data?.candidateId || '';
  const learned = response.data?.learned ?? 0;
  $('result').innerHTML = `<div class="item"><b>Pending human approval</b>`
    + `<span class="tag">${esc(approvalId || 'queued')}</span>`
    + `<div class="sub">learned ${esc(learned)} · not canonical until a human approves</div>`
    + `${candidateId ? `<div class="sub">candidate ${esc(candidateId)}</div>` : ''}</div>`
    + `<pre class="json">${esc(JSON.stringify(response, null, 2))}</pre>`;
  status(`pending human approval · ${approvalId || 'queued'}`, false, true);
}

async function submitLearnReview(event) {
  if (!isLearnReviewSelected()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  const text = $('prompt').value.trim();
  if (!text) return status('Enter a fact to propose first.', true);
  const capabilityEntry = capability(LEARN_REVIEW_WORKFLOW);
  if (!capabilityEntry?.availability?.ui) {
    return status('learn-review: capability_not_available', true);
  }
  $('run').disabled = true;
  status('learn-review: sending for human review…');
  try {
    const { r, d } = await json(capabilityEntry.route, {
      method: capabilityEntry.method,
      headers: headers(true),
      body: JSON.stringify(learnReviewBody(text)),
    });
    const pending = r.ok && d.status === 'review_required'
      && d.data?.learned === 0 && d.approval?.persisted === true
      && Boolean(d.data?.approvalId || d.approval?.id);
    if (!pending) throw Error(d?.error?.message || d?.status || `HTTP ${r.status}`);
    state.lastPrompt = text;
    renderPendingLearn(d);
    await loadApprovals();
  } catch (error) {
    $('result').innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    status(`failed: ${error.message}`, true);
  } finally {
    $('run').disabled = false;
  }
}

const previousActionChange = $('action').onchange;
$('action').onchange = () => {
  previousActionChange?.();
  toggleLearnReviewFields();
};
$('run').addEventListener('click', submitLearnReview, true);
toggleLearnReviewFields();
