const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// ── Log a field visit (JSON API, called from dashboard tile) ──────────────────
router.post('/', (req, res) => {
  const { customer_name, remarks, lat, lng } = req.body;
  if (!customer_name?.trim()) return res.json({ ok: false, error: 'Customer name required' });

  db.prepare('INSERT INTO field_visits (user_id, customer_name, lat, lng, remarks) VALUES (?,?,?,?,?)')
    .run(req.session.userId, customer_name.trim(), lat||null, lng||null, remarks||'');

  res.json({ ok: true });
});

// ── My visits list ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid    = req.session.userId;
  const today  = new Date().toISOString().slice(0,10);
  const visits = db.prepare(`SELECT * FROM field_visits WHERE user_id=? ORDER BY visit_time DESC LIMIT 50`).all(uid);
  const todayCount = db.prepare(`SELECT COUNT(*) as c FROM field_visits WHERE user_id=? AND date(visit_time)=?`).get(uid, today).c;
  res.render('visits', { title: 'My Field Visits', visits, todayCount });
});

module.exports = router;
