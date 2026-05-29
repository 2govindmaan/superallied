require('dotenv').config();
const express  = require('express');
const session  = require('express-session');
const bcrypt   = require('bcryptjs');
const path     = require('path');
const fs       = require('fs');
const { db, getSettings, nextQuotationNumber, calcQuotation, formatINR, numberToWords } = require('./db');
const { generatePDF } = require('./pdf');

// Pre-encode images once at startup
const LOGO_PATH = path.join(__dirname, 'public', 'bull-logo.jpg');
const BULL_LOGO_B64 = fs.existsSync(LOGO_PATH)
  ? `data:image/jpeg;base64,${fs.readFileSync(LOGO_PATH).toString('base64')}` : '';

const QR_PATH = path.join(__dirname, 'public', 'payment-qr.jpg');
const PAYMENT_QR_B64 = fs.existsSync(QR_PATH)
  ? `data:image/jpeg;base64,${fs.readFileSync(QR_PATH).toString('base64')}` : '';

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Middleware ────────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'superallied-secret-2026',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 8 * 60 * 60 * 1000 }, // 8 hours
}));

// Flash messages
app.use((req, res, next) => {
  res.locals.flash = req.session.flash || {};
  delete req.session.flash;
  next();
});

// Auth guard
function requireLogin(req, res, next) {
  if (req.session.userId) return next();
  req.session.flash = { error: 'Please login to continue.' };
  res.redirect('/login');
}

// Inject current user + settings into all views
app.use((req, res, next) => {
  res.locals.user = req.session.userId
    ? db.prepare('SELECT id, username, full_name, role FROM users WHERE id = ?').get(req.session.userId)
    : null;
  res.locals.settings = getSettings();
  next();
});

// ── Auth ──────────────────────────────────────────────────────────────────────
app.get('/login', (req, res) => {
  if (req.session.userId) return res.redirect('/');
  res.render('login', { title: 'Login' });
});

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    req.session.flash = { error: 'Invalid username or password.' };
    return res.redirect('/login');
  }
  req.session.userId = user.id;
  res.redirect('/');
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ── Dashboard ─────────────────────────────────────────────────────────────────
app.get('/', requireLogin, (req, res) => {
  const stats = {
    customers: db.prepare('SELECT COUNT(*) as c FROM customers').get().c,
    quotations: db.prepare('SELECT COUNT(*) as c FROM quotations').get().c,
    thisMonth: db.prepare("SELECT COUNT(*) as c FROM quotations WHERE strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now')").get().c,
    machines: db.prepare('SELECT COUNT(*) as c FROM machines WHERE active = 1').get().c,
  };
  const recent = db.prepare(`
    SELECT q.*, c.name as customer_name, m.display_name as machine_name
    FROM quotations q
    JOIN customers c ON c.id = q.customer_id
    JOIN machines m  ON m.id = q.machine_id
    ORDER BY q.created_at DESC LIMIT 8
  `).all();
  res.render('dashboard', { title: 'Dashboard', stats, recent, formatINR });
});

// ── Customers ─────────────────────────────────────────────────────────────────
app.get('/customers', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const customers = q
    ? db.prepare("SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? OR gstin LIKE ? ORDER BY name").all(`%${q}%`, `%${q}%`, `%${q}%`)
    : db.prepare('SELECT * FROM customers ORDER BY name').all();
  res.render('customers', { title: 'Customers', customers, q });
});

app.get('/customers/new', requireLogin, (req, res) => {
  res.render('customer-form', { title: 'New Customer', customer: null });
});

app.post('/customers', requireLogin, (req, res) => {
  const { name, phone, address, city, state, gstin, hp_with, notes } = req.body;
  if (!name?.trim()) {
    req.session.flash = { error: 'Customer name is required.' };
    return res.redirect('/customers/new');
  }
  db.prepare(`INSERT INTO customers (name,phone,address,city,state,gstin,hp_with,notes)
              VALUES (?,?,?,?,?,?,?,?)`)
    .run(name.trim(), phone||'', address||'', city||'', state||'', gstin||'', hp_with||'', notes||'');
  req.session.flash = { success: `Customer "${name}" created.` };
  res.redirect('/customers');
});

app.get('/customers/:id/edit', requireLogin, (req, res) => {
  const customer = db.prepare('SELECT * FROM customers WHERE id = ?').get(req.params.id);
  if (!customer) return res.redirect('/customers');
  res.render('customer-form', { title: 'Edit Customer', customer });
});

app.post('/customers/:id', requireLogin, (req, res) => {
  const { name, phone, address, city, state, gstin, hp_with, notes } = req.body;
  db.prepare(`UPDATE customers SET name=?,phone=?,address=?,city=?,state=?,gstin=?,hp_with=?,notes=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(name, phone||'', address||'', city||'', state||'', gstin||'', hp_with||'', notes||'', req.params.id);
  req.session.flash = { success: 'Customer updated.' };
  res.redirect('/customers');
});

app.post('/customers/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM customers WHERE id = ?').run(req.params.id);
  req.session.flash = { success: 'Customer deleted.' };
  res.redirect('/customers');
});

// ── Quotations ────────────────────────────────────────────────────────────────
app.get('/quotations', requireLogin, (req, res) => {
  const { status, q } = req.query;
  let sql = `SELECT qo.*, c.name as customer_name, m.display_name as machine_name
             FROM quotations qo
             JOIN customers c ON c.id = qo.customer_id
             JOIN machines m  ON m.id = qo.machine_id`;
  const params = [];
  const conds = [];
  if (status) { conds.push('qo.status = ?'); params.push(status); }
  if (q) { conds.push('(c.name LIKE ? OR qo.quotation_number LIKE ?)'); params.push(`%${q}%`, `%${q}%`); }
  if (conds.length) sql += ' WHERE ' + conds.join(' AND ');
  sql += ' ORDER BY qo.created_at DESC';
  const quotations = db.prepare(sql).all(...params);
  res.render('quotations', { title: 'Quotations', quotations, status: status||'', q: q||'', formatINR, calcQuotation });
});

app.get('/quotations/new', requireLogin, (req, res) => {
  const machines  = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const prefill   = req.query.customer_id || '';
  const s         = getSettings();
  res.render('quotation-form', { title: 'New Quotation', quotation: null, machines, customers, prefill, formatINR,
    defaultSalesperson: s.contact_name || '', defaultSalespersonPhone: s.contact_phone || '' });
});

app.post('/quotations', requireLogin, (req, res) => {
  const {
    customer_id, machine_id, quantity, basic_price, transit_insurance,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance, trc, hp_with, notes,
    salesperson_name, salesperson_phone,
  } = req.body;

  if (!customer_id || !machine_id || !basic_price) {
    req.session.flash = { error: 'Customer, machine and price are required.' };
    return res.redirect('/quotations/new');
  }

  const { quotationNumber, financialYear, serialNumber } = nextQuotationNumber();
  db.prepare(`INSERT INTO quotations
    (quotation_number,financial_year,serial_number,customer_id,machine_id,user_id,
     quantity,basic_price,transit_insurance,tax_mode,cgst_rate,sgst_rate,igst_rate,
     has_tcs,tcs_rate,insurance,trc,hp_with,notes,salesperson_name,salesperson_phone)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(
      quotationNumber, financialYear, serialNumber,
      +customer_id, +machine_id, req.session.userId,
      +quantity||1, +basic_price, +transit_insurance||2000,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      insurance||'INCLUSIVE', trc||'INCLUSIVE',
      hp_with||'', notes||'',
      salesperson_name||'', salesperson_phone||''
    );
  req.session.flash = { success: `Quotation ${quotationNumber} created.` };
  res.redirect('/quotations');
});

app.get('/quotations/:id', requireLogin, (req, res) => {
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    WHERE qo.id = ?`).get(req.params.id);
  if (!q) return res.redirect('/quotations');
  const calc = calcQuotation(q);
  res.render('quotation-view', { title: `Quotation ${q.quotation_number}`, q, calc, formatINR });
});

app.get('/quotations/:id/edit', requireLogin, (req, res) => {
  const quotation = db.prepare('SELECT * FROM quotations WHERE id = ?').get(req.params.id);
  if (!quotation) return res.redirect('/quotations');
  const machines  = db.prepare('SELECT * FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  const customers = db.prepare('SELECT * FROM customers ORDER BY name').all();
  const s         = getSettings();
  res.render('quotation-form', { title: 'Edit Quotation', quotation, machines, customers, prefill: '', formatINR,
    defaultSalesperson: s.contact_name || '', defaultSalespersonPhone: s.contact_phone || '' });
});

app.post('/quotations/:id', requireLogin, (req, res) => {
  const {
    customer_id, machine_id, quantity, basic_price, transit_insurance,
    tax_mode, cgst_rate, sgst_rate, igst_rate,
    has_tcs, tcs_rate, insurance, trc, hp_with, notes, status,
    salesperson_name, salesperson_phone,
  } = req.body;
  db.prepare(`UPDATE quotations SET
    customer_id=?,machine_id=?,quantity=?,basic_price=?,transit_insurance=?,
    tax_mode=?,cgst_rate=?,sgst_rate=?,igst_rate=?,has_tcs=?,tcs_rate=?,
    insurance=?,trc=?,hp_with=?,notes=?,status=?,
    salesperson_name=?,salesperson_phone=?
    WHERE id=?`)
    .run(
      +customer_id, +machine_id, +quantity||1, +basic_price, +transit_insurance||2000,
      tax_mode||'CGST_SGST', +cgst_rate||9, +sgst_rate||9, +igst_rate||18,
      has_tcs === 'on' ? 1 : 0, +tcs_rate||1,
      insurance||'INCLUSIVE', trc||'INCLUSIVE',
      hp_with||'', notes||'', status||'draft',
      salesperson_name||'', salesperson_phone||'',
      req.params.id
    );
  req.session.flash = { success: 'Quotation updated.' };
  res.redirect(`/quotations/${req.params.id}`);
});

app.post('/quotations/:id/delete', requireLogin, (req, res) => {
  db.prepare('DELETE FROM quotations WHERE id = ?').run(req.params.id);
  req.session.flash = { success: 'Quotation deleted.' };
  res.redirect('/quotations');
});

app.get('/quotations/:id/pdf', requireLogin, async (req, res) => {
  const q = db.prepare(`
    SELECT qo.*, c.name as customer_name, c.phone as customer_phone,
           c.address as customer_address, c.city as customer_city,
           c.state as customer_state, c.gstin as customer_gstin,
           m.display_name as machine_name, m.model_code, m.hsn_code,
           m.engine, m.transmission, m.rear_axle, m.pump,
           m.front_tyre, m.rear_tyre, m.battery, m.weight,
           m.bucket, m.warranty, m.model_series
    FROM quotations qo
    JOIN customers c ON c.id = qo.customer_id
    JOIN machines m  ON m.id = qo.machine_id
    WHERE qo.id = ?`).get(req.params.id);
  if (!q) return res.status(404).send('Not found');

  const calc = calcQuotation(q);
  const s    = getSettings();
  const html = await new Promise((resolve, reject) => {
    res.app.render('quotation-pdf', { q, calc, settings: s, formatINR, numberToWords, bullLogoB64: BULL_LOGO_B64, paymentQrB64: PAYMENT_QR_B64 }, (err, html) => {
      if (err) reject(err); else resolve(html);
    });
  });

  try {
    const pdfBuffer = await generatePDF(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Quotation-${q.quotation_number.replace('/', '-')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('PDF error:', err);
    req.session.flash = { error: 'PDF generation failed. Is Puppeteer installed?' };
    res.redirect(`/quotations/${req.params.id}`);
  }
});

// ── Machines ──────────────────────────────────────────────────────────────────
app.get('/machines', requireLogin, (req, res) => {
  const machines = db.prepare('SELECT * FROM machines ORDER BY model_series, display_name').all();
  res.render('machines', { title: 'Machine Catalog', machines, formatINR });
});

app.post('/machines/:id', requireLogin, (req, res) => {
  const { basic_price, display_name, engine, transmission, front_tyre, rear_tyre,
          battery, weight, bucket, warranty, active } = req.body;
  db.prepare(`UPDATE machines SET basic_price=?,display_name=?,engine=?,transmission=?,
              front_tyre=?,rear_tyre=?,battery=?,weight=?,bucket=?,warranty=?,active=? WHERE id=?`)
    .run(+basic_price, display_name, engine||'', transmission||'', front_tyre||'',
         rear_tyre||'', battery||'', weight||'', bucket||'', warranty||'',
         active === 'on' ? 1 : 0, req.params.id);
  req.session.flash = { success: 'Machine updated.' };
  res.redirect('/machines');
});

// ── Calculator ────────────────────────────────────────────────────────────────
app.get('/calculator', requireLogin, (req, res) => {
  const machines = db.prepare('SELECT id, display_name, model_series, basic_price FROM machines WHERE active = 1 ORDER BY model_series, display_name').all();
  res.render('calculator', { title: 'Profit Calculator', machines, formatINR });
});

// ── Settings ──────────────────────────────────────────────────────────────────
app.get('/settings', requireLogin, (req, res) => {
  res.render('settings', { title: 'Settings', s: getSettings() });
});

app.post('/settings', requireLogin, (req, res) => {
  const fields = ['company_name','company_gstin','company_address','dealer_of',
                  'contact_name','contact_phone','bank_beneficiary','bank_account','bank_ifsc','bank_branch'];
  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key,value) VALUES (?,?)');
  fields.forEach(k => { if (req.body[k] != null) upsert.run(k, req.body[k]); });
  req.session.flash = { success: 'Settings saved.' };
  res.redirect('/settings');
});

// Change password
app.post('/settings/password', requireLogin, (req, res) => {
  const { current, newpwd, confirm } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
  if (!bcrypt.compareSync(current, user.password_hash)) {
    req.session.flash = { error: 'Current password is wrong.' };
    return res.redirect('/settings');
  }
  if (newpwd !== confirm || newpwd.length < 6) {
    req.session.flash = { error: 'Passwords do not match or too short (min 6).' };
    return res.redirect('/settings');
  }
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(newpwd, 10), user.id);
  req.session.flash = { success: 'Password changed.' };
  res.redirect('/settings');
});

// ── API ───────────────────────────────────────────────────────────────────────
app.get('/api/machines/:id', requireLogin, (req, res) => {
  const m = db.prepare('SELECT * FROM machines WHERE id = ?').get(req.params.id);
  res.json(m || {});
});

app.get('/api/customers/search', requireLogin, (req, res) => {
  const q = req.query.q || '';
  const rows = db.prepare("SELECT id, name, phone, gstin FROM customers WHERE name LIKE ? OR phone LIKE ? LIMIT 10").all(`%${q}%`, `%${q}%`);
  res.json(rows);
});

// ── Start ──────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   SUPER ALLIED — Quotation & CRM App             ║');
  console.log('╠══════════════════════════════════════════════════╣');
  console.log(`║   Open: http://localhost:${PORT}                     ║`);
  console.log('║   Login: admin / admin123                        ║');
  console.log('║   (Change password in Settings after login)      ║');
  console.log('╚══════════════════════════════════════════════════╝\n');
});
