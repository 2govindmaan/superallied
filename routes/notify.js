const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

router.get('/', (req, res) => {
  const uid = req.session.userId;
  const notifications = db.prepare(
    'SELECT * FROM notifications WHERE user_id=? ORDER BY created_at DESC LIMIT 50').all(uid);
  // Mark all as read
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(uid);
  res.render('notifications', { title: 'Notifications', notifications });
});

router.post('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE user_id=?').run(req.session.userId);
  res.json({ ok: true });
});

router.post('/:id/read', (req, res) => {
  db.prepare('UPDATE notifications SET is_read=1 WHERE id=? AND user_id=?')
    .run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

module.exports = router;
