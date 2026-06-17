const express = require('express');
const router  = express.Router();
const { db, formatINR, auditLog } = require('../db');

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const rows = db.prepare(`
    SELECT sp.*,
      COUNT(DISTINCT sq.id)  AS spare_count,
      COALESCE(SUM(sq.grand_total),0) AS spare_value,
      COUNT(DISTINCT q.id)   AS machine_count,
      COALESCE(SUM(q.total_price),0)  AS machine_value
    FROM salespersons sp
    LEFT JOIN spare_quotations sq ON sq.salesperson_id = sp.id
    LEFT JOIN quotations q        ON q.salesperson_id  = sp.id
    GROUP BY sp.id
    ORDER BY sp.active DESC, sp.name ASC
  `).all();
  res.render('salespersons/list', { title: 'Salespersons', rows, formatINR });
});

// ── New form ──────────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('salespersons/form', { title: 'Add Salesperson', sp: null });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.name?.trim()) {
    req.session.flash = { error: 'Name is required.' };
    return res.redirect('/salespersons/new');
  }
  const info = db.prepare(`INSERT INTO salespersons (name,phone,email,territory,target_monthly,notes,active)
    VALUES (?,?,?,?,?,?,1)`)
    .run(f.name.trim(), f.phone||'', f.email||'', f.territory||'',
         parseFloat(f.target_monthly)||0, f.notes||'');
  auditLog(req.session.userId, 'SP_CREATED', 'salespersons', info.lastInsertRowid, f.name.trim());
  req.session.flash = { success: `Salesperson "${f.name.trim()}" added.` };
  res.redirect(`/salespersons/${info.lastInsertRowid}`);
});

// ── Reports ───────────────────────────────────────────────────────────────────
router.get('/reports/summary', (req, res) => {
  const { from, to } = req.query;
  let dCond = '';
  const dp = [];
  if (from) { dCond += ' AND date(sq.created_at)>=?'; dp.push(from); }
  if (to)   { dCond += ' AND date(sq.created_at)<=?'; dp.push(to); }

  // Per-salesperson spare quotation stats
  const spareStats = db.prepare(`
    SELECT
      COALESCE(sp.name, sq.salesperson, 'Unassigned') AS sp_name,
      sp.id AS sp_id,
      COUNT(sq.id) AS total_count,
      COALESCE(SUM(sq.grand_total),0) AS total_value,
      SUM(CASE WHEN sq.status='draft'     THEN 1 ELSE 0 END) AS draft_count,
      SUM(CASE WHEN sq.status='sent'      THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN sq.status='confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
      SUM(CASE WHEN sq.status='cancelled' THEN 1 ELSE 0 END) AS cancelled_count,
      COALESCE(SUM(CASE WHEN sq.status='confirmed' THEN sq.grand_total ELSE 0 END),0) AS confirmed_value
    FROM spare_quotations sq
    LEFT JOIN salespersons sp ON sp.id=sq.salesperson_id
    WHERE 1=1 ${dCond}
    GROUP BY COALESCE(sp.id, sq.salesperson)
    ORDER BY total_value DESC
  `).all(...dp);

  // Per-salesperson machine quotation stats
  const machineStats = db.prepare(`
    SELECT
      COALESCE(sp.name, q.salesperson_name, 'Unassigned') AS sp_name,
      sp.id AS sp_id,
      COUNT(q.id) AS total_count,
      COALESCE(SUM(q.total_price),0) AS total_value,
      SUM(CASE WHEN q.status='draft'     THEN 1 ELSE 0 END) AS draft_count,
      SUM(CASE WHEN q.status='sent'      THEN 1 ELSE 0 END) AS sent_count,
      SUM(CASE WHEN q.status='confirmed' THEN 1 ELSE 0 END) AS confirmed_count
    FROM quotations q
    LEFT JOIN salespersons sp ON sp.id=q.salesperson_id
    GROUP BY COALESCE(sp.id, q.salesperson_name)
    ORDER BY total_value DESC
  `).all();

  // Monthly trend — all salespersons — spare
  const monthlyTrend = db.prepare(`
    SELECT
      strftime('%Y-%m', sq.created_at) AS month,
      COALESCE(sp.name, sq.salesperson, 'Unassigned') AS sp_name,
      COUNT(*) AS count,
      COALESCE(SUM(sq.grand_total),0) AS value
    FROM spare_quotations sq
    LEFT JOIN salespersons sp ON sp.id=sq.salesperson_id
    WHERE sq.created_at >= date('now','-6 months') ${dCond}
    GROUP BY month, COALESCE(sp.id, sq.salesperson)
    ORDER BY month ASC
  `).all(...dp);

  res.render('salespersons/report', {
    title: 'Salesperson Reports', spareStats, machineStats, monthlyTrend,
    from: from||'', to: to||'', formatINR
  });
});


// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const sp = db.prepare('SELECT * FROM salespersons WHERE id=?').get(req.params.id);
  if (!sp) return res.redirect('/salespersons');

  const { from, to, period } = req.query;
  let dateFilter = '';
  const dp = [];
  if (from) { dateFilter += ' AND date(sq.created_at)>=?'; dp.push(from); }
  if (to)   { dateFilter += ' AND date(sq.created_at)<=?'; dp.push(to); }

  // Spare quotations
  const spareQuotes = db.prepare(`
    SELECT sq.* FROM spare_quotations sq
    WHERE sq.salesperson_id=? ${dateFilter}
    ORDER BY sq.created_at DESC
  `).all(sp.id, ...dp);

  // Machine quotations
  const machineQuotes = db.prepare(`
    SELECT q.*, c.name AS customer_name, m.model AS machine_model
    FROM quotations q
    LEFT JOIN customers c ON c.id=q.customer_id
    LEFT JOIN machines m  ON m.id=q.machine_id
    WHERE q.salesperson_id=?
    ORDER BY q.created_at DESC
  `).all(sp.id);

  // Stats summary
  const spareTotals = spareQuotes.reduce((acc, q) => {
    acc.count++;
    acc.value += q.grand_total || 0;
    acc[q.status] = (acc[q.status] || 0) + 1;
    return acc;
  }, { count: 0, value: 0 });

  const machineTotals = machineQuotes.reduce((acc, q) => {
    acc.count++;
    acc.value += q.total_price || 0;
    acc[q.status] = (acc[q.status] || 0) + 1;
    return acc;
  }, { count: 0, value: 0 });

  // Monthly trend (last 12 months) — spare quotations
  const monthly = db.prepare(`
    SELECT strftime('%Y-%m', sq.created_at) AS month,
           COUNT(*) AS count,
           COALESCE(SUM(sq.grand_total),0) AS value
    FROM spare_quotations sq
    WHERE sq.salesperson_id=?
      AND sq.created_at >= date('now','-12 months')
    GROUP BY month ORDER BY month ASC
  `).all(sp.id);

  res.render('salespersons/profile', {
    title: sp.name, sp, spareQuotes, machineQuotes,
    spareTotals, machineTotals, monthly,
    from: from||'', to: to||'', formatINR
  });
});

// ── Edit form ─────────────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const sp = db.prepare('SELECT * FROM salespersons WHERE id=?').get(req.params.id);
  if (!sp) return res.redirect('/salespersons');
  res.render('salespersons/form', { title: 'Edit Salesperson', sp });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE salespersons SET
    name=?,phone=?,email=?,territory=?,target_monthly=?,notes=?,active=?,updated_at=CURRENT_TIMESTAMP
    WHERE id=?`)
    .run(f.name?.trim()||'', f.phone||'', f.email||'', f.territory||'',
         parseFloat(f.target_monthly)||0, f.notes||'',
         f.active === '1' ? 1 : 0, req.params.id);
  auditLog(req.session.userId, 'SP_UPDATED', 'salespersons', req.params.id, '');
  req.session.flash = { success: 'Salesperson updated.' };
  res.redirect(`/salespersons/${req.params.id}`);
});

// ── Toggle active ─────────────────────────────────────────────────────────────
router.post('/:id/toggle', (req, res) => {
  const sp = db.prepare('SELECT active FROM salespersons WHERE id=?').get(req.params.id);
  if (!sp) return res.redirect('/salespersons');
  db.prepare('UPDATE salespersons SET active=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
    .run(sp.active ? 0 : 1, req.params.id);
  res.redirect(`/salespersons/${req.params.id}`);
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  // Nullify FK references before deletion
  db.prepare('UPDATE spare_quotations SET salesperson_id=NULL WHERE salesperson_id=?').run(req.params.id);
  db.prepare('UPDATE quotations SET salesperson_id=NULL WHERE salesperson_id=?').run(req.params.id);
  db.prepare('DELETE FROM salespersons WHERE id=?').run(req.params.id);
  auditLog(req.session.userId, 'SP_DELETED', 'salespersons', req.params.id, '');
  req.session.flash = { success: 'Salesperson deleted.' };
  res.redirect('/salespersons');
});

module.exports = router;
