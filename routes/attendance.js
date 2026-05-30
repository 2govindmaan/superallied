const express = require('express');
const path    = require('path');
const fs      = require('fs');
const router  = express.Router();
const { db, createNotification } = require('../db');

// ── Helpers ───────────────────────────────────────────────────────────────────
function today() { return new Date().toISOString().slice(0, 10); }

function savePhoto(base64, folder, uploadsDir) {
  if (!base64 || !base64.startsWith('data:image')) return null;
  const buf = Buffer.from(base64.split(',')[1], 'base64');
  const dir = path.join(uploadsDir, folder);
  fs.mkdirSync(dir, { recursive: true });
  const fname = `${Date.now()}-${Math.random().toString(36).slice(2)}.jpg`;
  fs.writeFileSync(path.join(dir, fname), buf);
  return `/uploads/${folder}/${fname}`;
}

// ── Employee: my attendance page ──────────────────────────────────────────────
router.get('/', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();

  const todayRec = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);

  const history = db.prepare(`
    SELECT * FROM attendance WHERE user_id=? ORDER BY date DESC LIMIT 30
  `).all(uid);

  const stats = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status='present' THEN 1 ELSE 0 END) as present,
      SUM(CASE WHEN check_in_time IS NOT NULL AND check_out_time IS NULL THEN 1 ELSE 0 END) as open
    FROM attendance WHERE user_id=? AND date >= date('now','-30 days')
  `).get(uid);

  res.render('attendance', { title: 'My Attendance', todayRec, history, stats, todayStr: todayR });
});

// ── API: check-in ─────────────────────────────────────────────────────────────
router.post('/api/checkin', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();
  const { lat, lng, photo } = req.body;

  // photo is already uploaded via /api/upload — use path directly
  const photoPath = (photo && photo.startsWith('/uploads/')) ? photo : savePhoto(photo, 'attendance', res.app.locals.UPLOADS_DIR);

  const existing = db.prepare('SELECT id, check_in_time FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);

  if (existing?.check_in_time) {
    return res.json({ ok: false, message: 'Already checked in today.' });
  }

  const now = new Date().toISOString();
  if (existing) {
    db.prepare(`UPDATE attendance SET check_in_time=?, check_in_lat=?, check_in_lng=?, check_in_photo=? WHERE id=?`)
      .run(now, lat||null, lng||null, photoPath, existing.id);
  } else {
    db.prepare(`INSERT INTO attendance (user_id,date,check_in_time,check_in_lat,check_in_lng,check_in_photo)
                VALUES (?,?,?,?,?,?)`)
      .run(uid, todayR, now, lat||null, lng||null, photoPath);
  }
  res.json({ ok: true, time: now });
});

// ── API: check-out ────────────────────────────────────────────────────────────
router.post('/api/checkout', (req, res) => {
  const uid    = req.session.userId;
  const todayR = today();
  const { lat, lng, photo } = req.body;

  const photoPath = (photo && photo.startsWith('/uploads/')) ? photo : savePhoto(photo, 'attendance', res.app.locals.UPLOADS_DIR);

  const rec = db.prepare('SELECT * FROM attendance WHERE user_id=? AND date=?').get(uid, todayR);

  if (!rec?.check_in_time) {
    return res.json({ ok: false, message: 'You have not checked in today.' });
  }
  if (rec.check_out_time) {
    return res.json({ ok: false, message: 'Already checked out today.' });
  }

  const now = new Date().toISOString();
  db.prepare(`UPDATE attendance SET check_out_time=?, check_out_lat=?, check_out_lng=?, check_out_photo=? WHERE id=?`)
    .run(now, lat||null, lng||null, photoPath, rec.id);

  res.json({ ok: true, time: now });
});

module.exports = router;
