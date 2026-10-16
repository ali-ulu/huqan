'use strict';

function createPilotReceiptArchive(records) {
  const snapshot = records.map((record) => Object.freeze({
    receipt: record.receipt,
    publicProjection: record.publicProjection,
    verification: Object.freeze({ ...record.verification }),
  }));
  const successfulTrustSignals = snapshot.filter(({ receipt, verification }) => verification.valid && receipt.verdict === 'allow').length;
  const report = Object.freeze({
    totalEvents: snapshot.length,
    verifiedEvents: snapshot.filter(({ verification }) => verification.valid).length,
    successfulTrustSignals,
    withheldTrustSignals: snapshot.length - successfulTrustSignals,
  });
  return Object.freeze({
    report,
    list: () => Object.freeze([...snapshot]),
    getByReceiptId: (receiptId) => snapshot.find(({ receipt }) => receipt.receiptId === receiptId) || null,
  });
}

module.exports = { createPilotReceiptArchive };
