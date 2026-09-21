'use strict';

function admissionReceiptDetails(admission) {
  if (!admission || typeof admission !== 'object') return {};
  const details = {};
  if (admission.receiptId) details.receiptId = admission.receiptId;
  if (admission.receipt && typeof admission.receipt === 'object') {
    details.receipt = JSON.parse(JSON.stringify(admission.receipt));
  }
  return details;
}

module.exports = { admissionReceiptDetails };
