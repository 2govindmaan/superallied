const express = require('express');
const router  = express.Router();
const { db, auditLog } = require('../db');
const XLSX = require('xlsx');

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const q = req.query.q || '';
  let rows;
  if (q) {
    rows = db.prepare(`
      SELECT sm.*, COUNT(sq.id) as quotation_count
      FROM sold_machines sm
      LEFT JOIN spare_quotations sq ON sq.sold_machine_id = sm.id
      WHERE sm.machine_no LIKE ? OR sm.customer_name LIKE ? OR sm.chassis_number LIKE ?
         OR sm.engine_number LIKE ? OR sm.mobile_1 LIKE ? OR sm.mobile_2 LIKE ?
      GROUP BY sm.id ORDER BY sm.created_at DESC
    `).all(...Array(6).fill(`%${q}%`));
  } else {
    rows = db.prepare(`
      SELECT sm.*, COUNT(sq.id) as quotation_count
      FROM sold_machines sm
      LEFT JOIN spare_quotations sq ON sq.sold_machine_id = sm.id
      GROUP BY sm.id ORDER BY sm.created_at DESC
    `).all();
  }
  res.render('sold-machines/list', { title: 'Sold Machines Registry', rows, q });
});

// ── New form ──────────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  res.render('sold-machines/form', { title: 'Register Machine', machine: null });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.machine_no?.trim()) {
    req.session.flash = { error: 'Machine No is required.' };
    return res.redirect('/sold-machines/new');
  }
  if (db.prepare('SELECT id FROM sold_machines WHERE machine_no=?').get(f.machine_no.trim())) {
    req.session.flash = { error: `Machine No "${f.machine_no.trim()}" already exists.` };
    return res.redirect('/sold-machines/new');
  }
  const info = db.prepare(`INSERT INTO sold_machines
    (machine_no,chassis_number,engine_number,model,customer_name,customer_address,
     place_of_supply,contact_person,mobile_1,mobile_2,finance_type,financier,
     registration_no,gst_number,pan_number,dealer,date_of_sale,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(f.machine_no.trim(), f.chassis_number||'', f.engine_number||'', f.model||'',
         f.customer_name.trim(), f.customer_address||'', f.place_of_supply||'',
         f.contact_person||'', f.mobile_1||'', f.mobile_2||'',
         f.finance_type||'Cash', f.financier||'', f.registration_no||'',
         f.gst_number||'', f.pan_number||'', f.dealer||'',
         f.date_of_sale||null, req.session.userId);
  auditLog(req.session.userId, 'MACHINE_CREATED', 'sold_machines', info.lastInsertRowid, f.machine_no.trim());
  req.session.flash = { success: `Machine ${f.machine_no.trim()} registered.` };
  res.redirect(`/sold-machines/${info.lastInsertRowid}`);
});

// ── Profile ───────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const machine = db.prepare('SELECT * FROM sold_machines WHERE id=?').get(req.params.id);
  if (!machine) return res.redirect('/sold-machines');
  const quotations = db.prepare(`
    SELECT sq.*, COUNT(sqi.id) as item_count
    FROM spare_quotations sq
    LEFT JOIN spare_quotation_items sqi ON sqi.quotation_id = sq.id
    WHERE sq.sold_machine_id = ?
    GROUP BY sq.id ORDER BY sq.created_at DESC
  `).all(req.params.id);
  const { formatINR } = require('../db');
  res.render('sold-machines/profile', { title: `Machine: ${machine.machine_no}`, machine, quotations, formatINR });
});

// ── Edit form ─────────────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const machine = db.prepare('SELECT * FROM sold_machines WHERE id=?').get(req.params.id);
  if (!machine) return res.redirect('/sold-machines');
  res.render('sold-machines/form', { title: 'Edit Machine', machine });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE sold_machines SET
    chassis_number=?,engine_number=?,model=?,customer_name=?,customer_address=?,
    place_of_supply=?,contact_person=?,mobile_1=?,mobile_2=?,finance_type=?,
    financier=?,registration_no=?,gst_number=?,pan_number=?,dealer=?,
    date_of_sale=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(f.chassis_number||'', f.engine_number||'', f.model||'',
         f.customer_name||'', f.customer_address||'', f.place_of_supply||'',
         f.contact_person||'', f.mobile_1||'', f.mobile_2||'',
         f.finance_type||'Cash', f.financier||'', f.registration_no||'',
         f.gst_number||'', f.pan_number||'', f.dealer||'',
         f.date_of_sale||null, req.params.id);
  auditLog(req.session.userId, 'MACHINE_UPDATED', 'sold_machines', req.params.id, '');
  req.session.flash = { success: 'Machine record updated.' };
  res.redirect(`/sold-machines/${req.params.id}`);
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  db.prepare('DELETE FROM sold_machines WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Machine record deleted.' };
  res.redirect('/sold-machines');
});

// ── Excel import ──────────────────────────────────────────────────────────────
router.post('/import/excel', (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.json({ ok: false, error: 'No data received.' });
    const buf = Buffer.from(data, 'base64');
    const wb  = XLSX.read(buf, { type: 'buffer', cellDates: true });
    const ws  = wb.Sheets[wb.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

    let inserted = 0, skipped = 0, errors = [];

    const stmt = db.prepare(`INSERT OR IGNORE INTO sold_machines
      (machine_no,chassis_number,engine_number,model,customer_name,customer_address,
       place_of_supply,contact_person,mobile_1,mobile_2,finance_type,financier,
       registration_no,gst_number,pan_number,dealer,date_of_sale,created_by)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

    for (const row of rows) {
      const mno = String(row['Machine No'] || row['machine_no'] || '').trim();
      if (!mno) { skipped++; continue; }
      const cust = String(row['Customer Name'] || row['customer_name'] || '').trim();
      try {
        const info = stmt.run(mno, row['Chassis Number']||'', row['Engine Number']||'',
          row['Model']||'', cust, row['Customer Address']||'',
          row['Place of Supply']||'', row['Contact Person']||'',
          String(row['Mobile 1']||''), String(row['Mobile 2']||''),
          row['Finance Type']||'Cash', row['Financier']||'',
          row['Registration No']||'', row['GST Number']||'',
          row['PAN Number']||'', row['Dealer']||'',
          row['Date of Sale']||null, req.session.userId);
        if (info.changes > 0) inserted++; else skipped++;
      } catch(e) { errors.push(`${mno}: ${e.message}`); }
    }
    res.json({ ok: true, inserted, skipped, errors });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
