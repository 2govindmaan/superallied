const express = require('express');
const router  = express.Router();
const { db, getSettings, nextSolarQuotationNumber, formatINR, numberToWords, auditLog } = require('../db');
const { generatePDF } = require('../pdf');

// ── Solar Customers ───────────────────────────────────────────────────────────
router.get('/customers', (req, res) => {
  const { q } = req.query;
  let sql = 'SELECT * FROM solar_customers WHERE 1=1';
  const params = [];
  if (q) { sql += ' AND (name LIKE ? OR phone LIKE ? OR consumer_number LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY name ASC';
  const customers = db.prepare(sql).all(...params);
  const flash = req.session.flash || {}; delete req.session.flash;
  res.render('solar-quotations/customers', { title: 'Solar Customers', customers, q: q||'', flash, formatINR });
});

router.post('/customers', (req, res) => {
  const f = req.body;
  if (!f.name?.trim()) { req.session.flash = { error: 'Customer name required.' }; return res.redirect('/solar-quotations/customers'); }
  db.prepare(`INSERT INTO solar_customers (name,address,phone,consumer_number,consumer_type,sanction_load,email,notes)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(f.name.trim(), f.address||'', f.phone||'', f.consumer_number||'', f.consumer_type||'', f.sanction_load||'', f.email||'', f.notes||'');
  req.session.flash = { success: 'Customer added.' };
  res.redirect('/solar-quotations/customers');
});

router.post('/customers/:id/update', (req, res) => {
  const f = req.body;
  db.prepare(`UPDATE solar_customers SET name=?,address=?,phone=?,consumer_number=?,consumer_type=?,sanction_load=?,email=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(f.name||'', f.address||'', f.phone||'', f.consumer_number||'', f.consumer_type||'', f.sanction_load||'', f.email||'', f.notes||'', req.params.id);
  req.session.flash = { success: 'Customer updated.' };
  res.redirect('/solar-quotations/customers');
});

router.post('/customers/:id/delete', (req, res) => {
  db.prepare('DELETE FROM solar_customers WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Customer deleted.' };
  res.redirect('/solar-quotations/customers');
});

// API: customer lookup for autofill
router.get('/api/customers', (req, res) => {
  const { q } = req.query;
  const rows = db.prepare('SELECT * FROM solar_customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name ASC LIMIT 10')
    .all(`%${q}%`, `%${q}%`);
  res.json(rows);
});

// ── Quotation List ────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { q, status, from, to } = req.query;
  let sql = `SELECT sq.*, u.full_name as creator_name FROM solar_quotations sq
    LEFT JOIN users u ON u.id=sq.created_by WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND sq.status=?'; params.push(status); }
  if (from)   { sql += ' AND date(sq.created_at)>=?'; params.push(from); }
  if (to)     { sql += ' AND date(sq.created_at)<=?'; params.push(to); }
  if (q)      { sql += ' AND (sq.quotation_no LIKE ? OR sq.customer_name LIKE ? OR sq.customer_phone LIKE ?)'; params.push(`%${q}%`,`%${q}%`,`%${q}%`); }
  sql += ' ORDER BY sq.created_at DESC';
  const quotations = db.prepare(sql).all(...params);
  const flash = req.session.flash || {}; delete req.session.flash;
  res.render('solar-quotations/list', { title: 'Solar Quotations', quotations, q: q||'', status: status||'', from: from||'', to: to||'', flash, formatINR });
});

// ── New Form ──────────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  const s = getSettings();
  const { customer_id } = req.query;
  let prefillCustomer = null;
  if (customer_id) prefillCustomer = db.prepare('SELECT * FROM solar_customers WHERE id=?').get(customer_id);
  res.render('solar-quotations/form', {
    title: 'New Solar Quotation', quotation: null, items: [], s, prefillCustomer, formatINR
  });
});

// ── Create ────────────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const f = req.body;
  if (!f.customer_name?.trim()) {
    req.session.flash = { error: 'Customer name is required.' };
    return res.redirect('/solar-quotations/new');
  }
  let items = [];
  try { items = JSON.parse(f.items_json || '[]'); } catch(e) {}

  const { quotationNo, financialYear, serialNumber } = nextSolarQuotationNumber();

  let customerId = null;
  if (f.save_customer === 'on' && f.customer_name?.trim()) {
    const existing = db.prepare('SELECT id FROM solar_customers WHERE name=? AND phone=?').get(f.customer_name.trim(), f.customer_phone||'');
    if (existing) {
      customerId = existing.id;
    } else {
      const ins = db.prepare(`INSERT INTO solar_customers (name,address,phone,consumer_number,consumer_type,sanction_load,email)
        VALUES (?,?,?,?,?,?,?)`).run(f.customer_name.trim(), f.customer_address||'', f.customer_phone||'', f.consumer_number||'', f.consumer_type||'', f.sanction_load||'', f.customer_email||'');
      customerId = ins.lastInsertRowid;
    }
  }
  if (f.solar_customer_id) customerId = parseInt(f.solar_customer_id) || null;

  const totalAmount   = parseFloat(f.total_amount) || 0;
  const discountAmount = parseFloat(f.discount_amount) || 0;
  const grandTotal    = parseFloat(f.grand_total) || 0;

  const info = db.prepare(`INSERT INTO solar_quotations
    (quotation_no,serial_number,financial_year,solar_customer_id,customer_name,customer_address,
     customer_phone,consumer_number,consumer_type,sanction_load,customer_email,
     system_type,system_capacity,quotation_date,total_amount,discount_amount,grand_total,notes,status,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(quotationNo, serialNumber, financialYear, customerId,
         f.customer_name.trim(), f.customer_address||'', f.customer_phone||'',
         f.consumer_number||'', f.consumer_type||'', f.sanction_load||'', f.customer_email||'',
         f.system_type||'ONGRID', parseFloat(f.system_capacity)||0,
         f.quotation_date || new Date().toISOString().slice(0,10),
         totalAmount, discountAmount, grandTotal, f.notes||'', 'draft', req.session.userId);

  const qid = info.lastInsertRowid;
  if (items.length) {
    const ins2 = db.prepare('INSERT INTO solar_quotation_items (quotation_id,srn,part_no,description,qty,rate,gst_rate,amount) VALUES (?,?,?,?,?,?,?,?)');
    items.forEach((it, i) => ins2.run(qid, i+1, it.part_no||'', it.description||'', it.qty||1, it.rate||0, it.gst_rate||18, it.amount||0));
  }

  auditLog(req.session.userId, 'SOLAR_QTN_CREATED', 'solar_quotations', qid, quotationNo);
  req.session.flash = { success: `Quotation ${quotationNo} created.` };
  res.redirect(`/solar-quotations/${qid}`);
});

// ── View ──────────────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const q = db.prepare(`SELECT sq.*, u.full_name as creator_name FROM solar_quotations sq
    LEFT JOIN users u ON u.id=sq.created_by WHERE sq.id=?`).get(req.params.id);
  if (!q) return res.redirect('/solar-quotations');
  const items = db.prepare('SELECT * FROM solar_quotation_items WHERE quotation_id=? ORDER BY srn ASC').all(req.params.id);
  const flash = req.session.flash || {}; delete req.session.flash;
  const s = getSettings();
  const isAdmin = req.session.userRole === 'admin';
  res.render('solar-quotations/view', { title: `Solar Quotation ${q.quotation_no}`, q, items, s, flash, formatINR, numberToWords, isAdmin, user: req.session });
});

// ── Edit Form ─────────────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const quotation = db.prepare('SELECT * FROM solar_quotations WHERE id=?').get(req.params.id);
  if (!quotation) return res.redirect('/solar-quotations');
  const items = db.prepare('SELECT * FROM solar_quotation_items WHERE quotation_id=? ORDER BY srn ASC').all(req.params.id);
  const s = getSettings();
  res.render('solar-quotations/form', { title: `Edit ${quotation.quotation_no}`, quotation, items, s, prefillCustomer: null, formatINR });
});

// ── Update ────────────────────────────────────────────────────────────────────
router.post('/:id/update', (req, res) => {
  const f = req.body;
  let items = [];
  try { items = JSON.parse(f.items_json || '[]'); } catch(e) {}

  db.prepare(`UPDATE solar_quotations SET customer_name=?,customer_address=?,customer_phone=?,
    consumer_number=?,consumer_type=?,sanction_load=?,customer_email=?,system_type=?,
    system_capacity=?,quotation_date=?,total_amount=?,discount_amount=?,grand_total=?,notes=?,
    status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(f.customer_name||'', f.customer_address||'', f.customer_phone||'',
         f.consumer_number||'', f.consumer_type||'', f.sanction_load||'', f.customer_email||'',
         f.system_type||'ONGRID', parseFloat(f.system_capacity)||0,
         f.quotation_date||new Date().toISOString().slice(0,10),
         parseFloat(f.total_amount)||0, parseFloat(f.discount_amount)||0, parseFloat(f.grand_total)||0,
         f.notes||'', f.status||'draft', req.params.id);

  db.prepare('DELETE FROM solar_quotation_items WHERE quotation_id=?').run(req.params.id);
  if (items.length) {
    const ins = db.prepare('INSERT INTO solar_quotation_items (quotation_id,srn,part_no,description,qty,rate,gst_rate,amount) VALUES (?,?,?,?,?,?,?,?)');
    items.forEach((it, i) => ins.run(req.params.id, i+1, it.part_no||'', it.description||'', it.qty||1, it.rate||0, it.gst_rate||18, it.amount||0));
  }

  req.session.flash = { success: 'Quotation updated.' };
  res.redirect(`/solar-quotations/${req.params.id}`);
});

// ── Status Update ─────────────────────────────────────────────────────────────
router.post('/:id/status', (req, res) => {
  db.prepare('UPDATE solar_quotations SET status=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.body.status, req.params.id);
  req.session.flash = { success: 'Status updated.' };
  res.redirect(`/solar-quotations/${req.params.id}`);
});

// ── Delete ────────────────────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const isAdmin = req.session.userRole === 'admin';
  if (!isAdmin) { req.session.flash = { error: 'Not authorised.' }; return res.redirect(`/solar-quotations/${req.params.id}`); }
  db.prepare('DELETE FROM solar_quotations WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Quotation deleted.' };
  res.redirect('/solar-quotations');
});

// ── PDF ───────────────────────────────────────────────────────────────────────
router.get('/:id/pdf', async (req, res) => {
  try {
    const q = db.prepare('SELECT * FROM solar_quotations WHERE id=?').get(req.params.id);
    if (!q) return res.status(404).send('Not found');
    const items = db.prepare('SELECT * FROM solar_quotation_items WHERE quotation_id=? ORDER BY srn ASC').all(req.params.id);
    const s = getSettings();
    const html = await new Promise((resolve, reject) => {
      res.app.render('solar-quotations/pdf', { q, items, s, formatINR, numberToWords }, (err, html) => {
        if (err) reject(err); else resolve(html);
      });
    });
    const pdf = await generatePDF(html);
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `inline; filename="Solar-${q.quotation_no.replace(/\//g,'-')}.pdf"` });
    res.send(pdf);
  } catch(e) {
    console.error('Solar PDF error:', e);
    res.status(500).send('PDF generation failed');
  }
});

module.exports = router;
