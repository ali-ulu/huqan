'use strict';

// `learn-review` is intentionally separate from the generic claim dispatcher:
// its successful outcome is a durable pending approval, never a canonical learn.
const LEARN_REVIEW_WORKFLOW = 'learn-review';
let learnReviewInFlight = false;

function isLearnReviewSelected() {
  return $('action').value === LEARN_REVIEW_WORKFLOW;
}

function toggleLearnReviewFields() {
  const selected = isLearnReviewSelected();
  $('learnsourcefield').hidden = !selected;
  $('learnreffield').hidden = !selected;
  $('learntitlefield').hidden = !selected;
  if (selected) {
    $('promptlabel').textContent = T('learnReview.promptLabel', 'Fact to propose');
    $('prompt').placeholder = T('learnReview.promptPlaceholder', 'Describe the fact to send for human review…');
    $('run').textContent = T('learnReview.submit', 'Send for human review');
    $('review').disabled = true;
  } else {
    $('run').textContent = T('verify.form.actions.run', 'Run');
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
  $('result').innerHTML = `<div class="item"><b>${esc(T('learnReview.pending', 'Pending human approval'))}</b>`
    + `<span class="tag">${esc(approvalId || 'queued')}</span>`
    + `<div class="sub">learned ${esc(learned)} · ${esc(T('learnReview.notCanonical', 'not canonical until a human approves'))}</div>`
    + `${candidateId ? `<div class="sub">candidate ${esc(candidateId)}</div>` : ''}</div>`
    + `<pre class="json">${esc(JSON.stringify(response, null, 2))}</pre>`;
  status(`pending human approval · ${approvalId || 'queued'}`, false, true);
}

async function submitLearnReview(event) {
  if (!isLearnReviewSelected()) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (learnReviewInFlight) return;
  const text = $('prompt').value.trim();
  if (!text) return status(T('learnReview.enterFact', 'Enter a fact to propose first.'), true);
  const capabilityEntry = capability(LEARN_REVIEW_WORKFLOW);
  if (!capabilityEntry?.availability?.ui) {
    return status('learn-review: capability_not_available', true);
  }
  learnReviewInFlight = true;
  $('run').disabled = true;
  $('run').setAttribute('aria-disabled', 'true');
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
    learnReviewInFlight = false;
    $('run').disabled = false;
    $('run').setAttribute('aria-disabled', 'false');
  }
}

const previousActionChange = $('action').onchange;
$('action').onchange = () => {
  previousActionChange?.();
  toggleLearnReviewFields();
};
$('run').addEventListener('click', submitLearnReview, true);
toggleLearnReviewFields();

// The submit button label is owned here, not by data-i18n: this module rewrites
// it whenever the workflow changes, so an annotation on the element would let
// applyTranslations put "Run" back on a button that submits a learn-review.
// Re-running the toggle is what localises it instead.
window.addEventListener('huqan-i18n-ready', toggleLearnReviewFields);
window.addEventListener('huqan-locale-change', toggleLearnReviewFields);
