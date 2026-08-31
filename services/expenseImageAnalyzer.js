// ── Expense receipt image analyzer ────────────────────────────────────────────
// Extension point for a real OCR/AI provider. No such provider is configured
// in this codebase today, so this always returns an empty, zero-confidence
// result — it must never be swapped for hard-coded/fake values. Whatever a
// future provider returns here is a *suggestion* for the salesperson to
// review and correct; callers must never write these fields directly into
// travel_expenses without going through the normal save/submit validation.
//
// Expected future shape from a real provider:
//   { fuel_station, date, fuel_type, quantity, amount, receipt_number,
//     vehicle_number, odometer_reading, confidence }
async function analyzeImage(filePath) {
  return {
    fuel_station: null,
    date: null,
    fuel_type: null,
    quantity: null,
    amount: null,
    receipt_number: null,
    vehicle_number: null,
    odometer_reading: null,
    confidence: 0,
    note: 'OCR/AI extraction is not configured. Enter values manually.',
  };
}

module.exports = { analyzeImage };
