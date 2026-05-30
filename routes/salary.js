const express = require('express');
const router  = express.Router();
const { db, formatINR, numberToWords, getSettings } = require('../db');
const { generatePDF } = require('../pdf');

// ── Employee: my salary history ───────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid = req.session.userId;

  const records = db.prepare(`
    SELECT sr.*, ir.amount as incentive, ir.reason as inc_reason
    FROM salary_records sr
    LEFT JOIN incentive_records ir ON ir.user_id=sr.user_id AND ir.month=sr.month
    WHERE sr.user_id=? ORDER BY sr.month DESC LIMIT 24`).all(uid);

  const totalIncentive = db.prepare(
    'SELECT COALESCE(SUM(amount),0) as t FROM incentive_records WHERE user_id=?').get(uid).t;

  res.render('salary', { title: 'My Salary', records, totalIncentive, formatINR });
});

// ── Employee: download my salary slip PDF ─────────────────────────────────────
router.get('/:month/pdf', async (req, res) => {
  const uid    = req.session.userId;
  const month  = req.params.month;
  const record = db.prepare('SELECT * FROM salary_records WHERE user_id=? AND month=?').get(uid, month);
  if (!record) { req.session.flash = { error: 'Salary record not found.' }; return res.redirect('/salary'); }

  const employee  = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const incentive = db.prepare('SELECT * FROM incentive_records WHERE user_id=? AND month=?').get(uid, month);
  const settings  = getSettings();

  const html = await new Promise((resolve, reject) =>
    res.app.render('salary-pdf', { record, employee, incentive, settings, formatINR, numberToWords },
      (err, h) => err ? reject(err) : resolve(h)));

  const pdfBuffer = await generatePDF(html);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="Salary-${month}.pdf"`);
  res.send(pdfBuffer);
});

module.exports = router;
