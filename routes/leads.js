const express = require('express');
const router = express.Router();
const { db } = require('../db');

const STAGES = {
  1: { label: 'Initial Enquiry', color: 'primary' },
  2: { label: 'Finance Investigation', color: 'info' },
  3: { label: 'Loan Processing', color: 'warning' },
  4: { label: 'Delivery Order', color: 'orange' },
  5: { label: 'Post Delivery', color: 'success' },
};

function nextLeadNumber() {
  const ym = new Date().toISOString().slice(0, 7).replace('-', '');
  const count = db.prepare("SELECT COUNT(*) as c FROM leads WHERE lead_number LIKE ?").get(`LM-${ym}-%`).c;
  return `LM-${ym}-${String(count + 1).padStart(4, '0')}`;
}

function canSeeAll(user) {
  return user && ['admin', 'manager'].includes(user.role);
}

function getLeads(user, filters = {}) {
  const uid = user.id;
  const allAccess = canSeeAll(user);
  let sql = `SELECT l.*, u.full_name as creator_name
    FROM leads l LEFT JOIN users u ON u.id = l.created_by WHERE 1=1`;
  const params = [];

  if (!allAccess) { sql += ' AND l.created_by = ?'; params.push(uid); }
  if (filters.stage) { sql += ' AND l.current_stage = ?'; params.push(filters.stage); }
  if (filters.status) { sql += ' AND l.status = ?'; params.push(filters.status); }
  if (filters.q) {
    sql += ' AND (l.customer_name LIKE ? OR l.customer_phone LIKE ? OR l.lead_number LIKE ?)';
    params.push(`%${filters.q}%`, `%${filters.q}%`, `%${filters.q}%`);
  }
  if (filters.model) { sql += ' AND l.model_required LIKE ?'; params.push(`%${filters.model}%`); }
  sql += ' ORDER BY l.updated_at DESC LIMIT 200';
  return db.prepare(sql).all(...params);
}

// ── List ──────────────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const user = res.locals.user;
  const { q = '', stage = '', status = 'active', model = '' } = req.query;
  const leads = getLeads(user, { q, stage, status: status || undefined, model });

  const allAccess = canSeeAll(user);
  const stageCounts = {};
  for (let s = 1; s <= 5; s++) {
    const where = allAccess ? '' : `AND created_by = ${user.id}`;
    stageCounts[s] = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE current_stage=? AND status='active' ${where}`).get(s).c;
  }
  const wonCount  = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE status='won'  ${allAccess ? '' : `AND created_by=${user.id}`}`).get().c;
  const lostCount = db.prepare(`SELECT COUNT(*) as c FROM leads WHERE status='lost' ${allAccess ? '' : `AND created_by=${user.id}`}`).get().c;

  res.render('leads', { title: 'Lead Management', leads, STAGES, q, stage, status, model, stageCounts, wonCount, lostCount, allAccess });
});

// ── Pipeline (Kanban) ─────────────────────────────────────────────────────────
router.get('/pipeline', (req, res) => {
  const user = res.locals.user;
  const allAccess = canSeeAll(user);
  const uid = user.id;
  const where = allAccess ? "status='active'" : `status='active' AND created_by=${uid}`;

  const pipeline = {};
  for (let s = 1; s <= 5; s++) {
    pipeline[s] = db.prepare(`SELECT l.*, u.full_name as creator_name FROM leads l LEFT JOIN users u ON u.id=l.created_by WHERE current_stage=? AND ${where} ORDER BY updated_at DESC LIMIT 50`).all(s);
  }
  pipeline.won  = db.prepare(`SELECT l.*, u.full_name as creator_name FROM leads l LEFT JOIN users u ON u.id=l.created_by WHERE ${where.replace("status='active'","status='won'")} ORDER BY updated_at DESC LIMIT 20`).all();
  pipeline.lost = db.prepare(`SELECT l.*, u.full_name as creator_name FROM leads l LEFT JOIN users u ON u.id=l.created_by WHERE ${where.replace("status='active'","status='lost'")} ORDER BY updated_at DESC LIMIT 20`).all();

  res.render('lead-pipeline', { title: 'Lead Pipeline', pipeline, STAGES, allAccess });
});

// ── Dashboard (summary / analytics) ──────────────────────────────────────────
router.get('/dashboard', (req, res) => {
  const user = res.locals.user;
  const allAccess = canSeeAll(user);
  const uid = user.id;
  const wr = allAccess ? '' : `AND l.created_by = ${uid}`;

  const totalActive = db.prepare(`SELECT COUNT(*) as c FROM leads l WHERE status='active' ${wr}`).get().c;
  const totalWon    = db.prepare(`SELECT COUNT(*) as c FROM leads l WHERE status='won' ${wr}`).get().c;
  const totalLost   = db.prepare(`SELECT COUNT(*) as c FROM leads l WHERE status='lost' ${wr}`).get().c;
  const totalLeads  = totalActive + totalWon + totalLost;

  const byStageSql = `SELECT current_stage, COUNT(*) as c FROM leads l WHERE status='active' ${wr} GROUP BY current_stage`;
  const byStage = db.prepare(byStageSql).all();

  const byModelSql = `SELECT model_required, COUNT(*) as c FROM leads l WHERE status='active' ${wr} AND model_required != '' GROUP BY model_required ORDER BY c DESC LIMIT 10`;
  const byModel = db.prepare(byModelSql).all();

  let byMember = [];
  if (allAccess) {
    byMember = db.prepare(`SELECT u.full_name, l.created_by,
      SUM(CASE WHEN l.status='active' THEN 1 ELSE 0 END) as active,
      SUM(CASE WHEN l.status='won' THEN 1 ELSE 0 END) as won,
      SUM(CASE WHEN l.status='lost' THEN 1 ELSE 0 END) as lost,
      COUNT(*) as total
      FROM leads l LEFT JOIN users u ON u.id=l.created_by GROUP BY l.created_by ORDER BY total DESC`).all();
  }

  const recentLeads = db.prepare(`SELECT l.*, u.full_name as creator_name FROM leads l LEFT JOIN users u ON u.id=l.created_by WHERE 1=1 ${wr} ORDER BY l.updated_at DESC LIMIT 10`).all();

  const thisMonth = new Date().toISOString().slice(0, 7);
  const newThisMonth = db.prepare(`SELECT COUNT(*) as c FROM leads l WHERE strftime('%Y-%m', created_at)=? ${wr}`).get(thisMonth).c;

  res.render('lead-dashboard', { title: 'Leads Dashboard', totalLeads, totalActive, totalWon, totalLost, byStage, byModel, byMember, recentLeads, STAGES, allAccess, newThisMonth });
});

// ── New lead form ─────────────────────────────────────────────────────────────
router.get('/new', (req, res) => {
  const machines = db.prepare('SELECT model_code, display_name FROM machines WHERE active=1 ORDER BY display_name').all();
  const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
  res.render('lead-form', { title: 'New Lead', lead: null, machines, staff, STAGES, errors: {} });
});

// ── Create lead ───────────────────────────────────────────────────────────────
router.post('/', (req, res) => {
  const user = res.locals.user;
  const b = req.body;

  if (!b.customer_name?.trim()) {
    const machines = db.prepare('SELECT model_code, display_name FROM machines WHERE active=1 ORDER BY display_name').all();
    const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
    return res.render('lead-form', { title: 'New Lead', lead: b, machines, staff, STAGES, errors: { customer_name: 'Customer name is required' } });
  }

  const leadNum = nextLeadNumber();
  const createdBy = canSeeAll(user) && b.created_by ? parseInt(b.created_by) : user.id;

  db.prepare(`INSERT INTO leads (lead_number, created_by, sh_name, team_member, state, dealer_location,
    district, tehsil, village_city, customer_name, customer_phone, model_required, who_visited,
    visit1_date, visit2_date, visit3_date, demo_seen, expected_purchase_date, customer_interested,
    margin_money_available, customer_category, current_stage, remarks, customer_assets, other_income, work_order)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?)`)
    .run(leadNum, createdBy,
      b.sh_name||'', b.team_member||'', b.state||'', b.dealer_location||'',
      b.district||'', b.tehsil||'', b.village_city||'',
      b.customer_name.trim(), b.customer_phone||'', b.model_required||'', b.who_visited||'',
      b.visit1_date||null, b.visit2_date||null, b.visit3_date||null,
      b.demo_seen ? 1 : 0, b.expected_purchase_date||null, b.customer_interested ? 1 : 0,
      b.margin_money_available||'', b.customer_category||'FTB',
      b.remarks||'', b.customer_assets||'', b.other_income||'', b.work_order ? 1 : 0
    );

  const lead = db.prepare('SELECT id FROM leads WHERE lead_number=?').get(leadNum);
  req.session.flash = { success: `Lead ${leadNum} created successfully.` };
  res.redirect(`/leads/${lead.id}`);
});

// ── Lead detail ───────────────────────────────────────────────────────────────
router.get('/:id', (req, res) => {
  const user = res.locals.user;
  const lead = db.prepare('SELECT l.*, u.full_name as creator_name FROM leads l LEFT JOIN users u ON u.id=l.created_by WHERE l.id=?').get(req.params.id);
  if (!lead) { req.session.flash = { error: 'Lead not found.' }; return res.redirect('/leads'); }
  if (!canSeeAll(user) && lead.created_by !== user.id) {
    req.session.flash = { error: 'Access denied.' }; return res.redirect('/leads');
  }
  res.render('lead-detail', { title: `Lead ${lead.lead_number}`, lead, STAGES });
});

// ── Edit form ─────────────────────────────────────────────────────────────────
router.get('/:id/edit', (req, res) => {
  const user = res.locals.user;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) { req.session.flash = { error: 'Lead not found.' }; return res.redirect('/leads'); }
  if (!canSeeAll(user) && lead.created_by !== user.id) {
    req.session.flash = { error: 'Access denied.' }; return res.redirect('/leads');
  }
  const machines = db.prepare('SELECT model_code, display_name FROM machines WHERE active=1 ORDER BY display_name').all();
  const staff = db.prepare("SELECT id, full_name FROM users WHERE role NOT IN ('admin') ORDER BY full_name").all();
  res.render('lead-form', { title: `Edit Lead ${lead.lead_number}`, lead, machines, staff, STAGES, errors: {} });
});

// ── Update lead ───────────────────────────────────────────────────────────────
router.post('/:id', (req, res) => {
  const user = res.locals.user;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) { req.session.flash = { error: 'Lead not found.' }; return res.redirect('/leads'); }
  if (!canSeeAll(user) && lead.created_by !== user.id) {
    req.session.flash = { error: 'Access denied.' }; return res.redirect('/leads');
  }

  const b = req.body;
  const stage = parseInt(b.current_stage) || lead.current_stage;

  db.prepare(`UPDATE leads SET
    sh_name=?, team_member=?, state=?, dealer_location=?, district=?, tehsil=?, village_city=?,
    customer_name=?, customer_phone=?, model_required=?, who_visited=?,
    visit1_date=?, visit2_date=?, visit3_date=?,
    demo_seen=?, expected_purchase_date=?, customer_interested=?,
    margin_money_available=?, customer_category=?,
    current_stage=?,
    docs_submitted=?, guarantor_docs_submitted=?, guarantor_name=?, cibil_customer=?, cibil_guarantor=?,
    fi_done=?, fi_result=?, financier_name=?, financier_exec_name=?, exec_contact=?,
    loan_amount_required=?, credit_query_resolved=?, credit_approval_raised=?, loan_sanctioned=?, loan_amount=?,
    do_expected_date=?, do_issued=?, margin_money_status=?, billing_done=?, invoice_done=?, insurance_done=?, form_21_22=?,
    margin_money_receipt=?, ltt_receipt=?, rc_submitted=?,
    customer_assets=?, other_income=?, work_order=?, remarks=?,
    updated_at=CURRENT_TIMESTAMP
    WHERE id=?`)
    .run(
      b.sh_name||'', b.team_member||'', b.state||'', b.dealer_location||'', b.district||'', b.tehsil||'', b.village_city||'',
      b.customer_name?.trim()||lead.customer_name, b.customer_phone||'', b.model_required||'', b.who_visited||'',
      b.visit1_date||null, b.visit2_date||null, b.visit3_date||null,
      b.demo_seen ? 1 : 0, b.expected_purchase_date||null, b.customer_interested ? 1 : 0,
      b.margin_money_available||'', b.customer_category||'FTB',
      stage,
      b.docs_submitted ? 1 : 0, b.guarantor_docs_submitted ? 1 : 0, b.guarantor_name||'', b.cibil_customer||'', b.cibil_guarantor||'',
      b.fi_done ? 1 : 0, b.fi_result||'', b.financier_name||'', b.financier_exec_name||'', b.exec_contact||'',
      b.loan_amount_required||'', b.credit_query_resolved ? 1 : 0, b.credit_approval_raised ? 1 : 0, b.loan_sanctioned ? 1 : 0, b.loan_amount||'',
      b.do_expected_date||null, b.do_issued ? 1 : 0, b.margin_money_status||'', b.billing_done ? 1 : 0, b.invoice_done ? 1 : 0, b.insurance_done ? 1 : 0, b.form_21_22 ? 1 : 0,
      b.margin_money_receipt ? 1 : 0, b.ltt_receipt ? 1 : 0, b.rc_submitted ? 1 : 0,
      b.customer_assets||'', b.other_income||'', b.work_order ? 1 : 0, b.remarks||'',
      lead.id
    );

  req.session.flash = { success: 'Lead updated successfully.' };
  res.redirect(`/leads/${lead.id}`);
});

// ── Change status (won/lost/reopen) ──────────────────────────────────────────
router.post('/:id/status', (req, res) => {
  const user = res.locals.user;
  const lead = db.prepare('SELECT * FROM leads WHERE id=?').get(req.params.id);
  if (!lead) return res.json({ ok: false, error: 'Not found' });
  if (!canSeeAll(user) && lead.created_by !== user.id) return res.json({ ok: false, error: 'Access denied' });

  const { status } = req.body;
  if (!['active', 'won', 'lost'].includes(status)) return res.json({ ok: false, error: 'Invalid status' });

  db.prepare('UPDATE leads SET status=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, lead.id);
  res.json({ ok: true });
});

// ── Delete (admin only) ───────────────────────────────────────────────────────
router.post('/:id/delete', (req, res) => {
  const user = res.locals.user;
  if (user.role !== 'admin') {
    req.session.flash = { error: 'Admin only.' }; return res.redirect('/leads');
  }
  db.prepare('DELETE FROM leads WHERE id=?').run(req.params.id);
  req.session.flash = { success: 'Lead deleted.' };
  res.redirect('/leads');
});

module.exports = router;
