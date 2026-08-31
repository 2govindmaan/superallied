const express = require('express');
const path    = require('path');
const router  = express.Router();
const { db, auditLog, createNotification, nextExpenseNumber } = require('../db');
const { analyzeImage } = require('../services/expenseImageAnalyzer');

function today() { return new Date().toISOString().slice(0, 10); }
function isApprover(res) { return res.locals.user?.role === 'admin' || res.locals.hasPerm('expense_approval'); }
function canClaim(res) { return res.locals.user?.role === 'admin' || res.locals.hasPerm('expense_claim'); }

function requireClaimAccess(req, res, next) {
  if (canClaim(res)) return next();
  req.session.flash = { error: `You don't have permission to access Travel Expenses.` };
  res.redirect('/');
}
function requireApprover(req, res, next) {
  if (isApprover(res)) return next();
  req.session.flash = { error: `You don't have permission to approve expenses.` };
  res.redirect('/');
}

// ── Recalculate distance / amounts server-side — never trust the client ──────
function recalc({ start_odo, end_odo, travel_type, fuel_amount, toll_amount, parking_amount, other_amount }) {
  const s = parseFloat(start_odo) || 0;
  const e = parseFloat(end_odo) || 0;
  const distance_km = Math.max(0, e - s);
  const rateRow = db.prepare('SELECT rate_per_km FROM expense_rates WHERE vehicle_type=?').get(travel_type);
  const rate_per_km = rateRow ? rateRow.rate_per_km : 0;
  const travel_amount = Math.round(distance_km * rate_per_km * 100) / 100;
  const fuel = parseFloat(fuel_amount) || 0;
  const toll = parseFloat(toll_amount) || 0;
  const parking = parseFloat(parking_amount) || 0;
  const other = parseFloat(other_amount) || 0;
  const total_claim = travel_amount + fuel + toll + parking + other;
  return { distance_km, rate_per_km, travel_amount, total_claim };
}

router.get('/', (req, res) => res.redirect('/travel-expenses/my'));

// ── New expense form ──────────────────────────────────────────────────────────
router.get('/new', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const journey = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, today());
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  const todaysVisits = db.prepare("SELECT * FROM field_visits WHERE user_id=? AND date(visit_time)=? ORDER BY visit_time").all(uid, today());

  res.render('travel-expenses/new', {
    title: 'New Travel Expense', expense: null, docs: [], linkedVisitIds: [],
    user, journey, rates, todaysVisits, todayStr: today(),
  });
});

// ── Edit an existing draft/rejected expense ───────────────────────────────────
router.get('/:id/edit', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.user_id !== uid) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/travel-expenses/my'); }
  if (!['draft','rejected'].includes(expense.status)) {
    req.session.flash = { error: `This expense is ${expense.status} and can no longer be edited.` };
    return res.redirect('/travel-expenses/' + expense.id);
  }
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(uid);
  const journey = db.prepare('SELECT * FROM expense_journeys WHERE user_id=? AND date=?').get(uid, expense.date);
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  const todaysVisits = db.prepare("SELECT * FROM field_visits WHERE user_id=? AND date(visit_time)=? ORDER BY visit_time").all(uid, expense.date);
  const docs = db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY uploaded_at').all(expense.id);
  const linkedVisitIds = db.prepare('SELECT visit_id FROM expense_visit_links WHERE expense_id=?').all(expense.id).map(r => r.visit_id);

  res.render('travel-expenses/new', {
    title: 'Edit Travel Expense', expense, docs, linkedVisitIds,
    user, journey, rates, todaysVisits, todayStr: expense.date,
  });
});

// ── Create / update (always saved as draft) ───────────────────────────────────
router.post('/', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const { id, date, travel_type, vehicle_number, purpose, start_odo, end_odo,
          fuel_type, fuel_qty, fuel_amount, toll_amount, parking_amount, other_amount, other_desc,
          remarks, visit_ids } = req.body;

  const s = parseFloat(start_odo) || 0;
  const e = parseFloat(end_odo) || 0;
  if (e < s) {
    req.session.flash = { error: 'Ending odometer cannot be lower than starting odometer.' };
    return res.redirect(id ? `/travel-expenses/${id}/edit` : '/travel-expenses/new');
  }

  const { distance_km, rate_per_km, travel_amount, total_claim } = recalc({
    start_odo: s, end_odo: e, travel_type, fuel_amount, toll_amount, parking_amount, other_amount,
  });

  let expenseId = id ? +id : null;

  if (expenseId) {
    const existing = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(expenseId);
    if (!existing || existing.user_id !== uid || !['draft','rejected'].includes(existing.status)) {
      req.session.flash = { error: 'This expense can no longer be edited.' };
      return res.redirect('/travel-expenses/my');
    }
    db.prepare(`UPDATE travel_expenses SET date=?,travel_type=?,vehicle_number=?,purpose=?,
      start_odo=?,end_odo=?,distance_km=?,rate_per_km=?,travel_amount=?,
      fuel_type=?,fuel_qty=?,fuel_amount=?,toll_amount=?,parking_amount=?,other_amount=?,other_desc=?,
      total_claim=?,remarks=?,status='draft' WHERE id=?`)
      .run(date||today(), travel_type||'Own Two Wheeler', vehicle_number||'', purpose||'',
        s, e, distance_km, rate_per_km, travel_amount,
        fuel_type||'', parseFloat(fuel_qty)||0, parseFloat(fuel_amount)||0,
        parseFloat(toll_amount)||0, parseFloat(parking_amount)||0, parseFloat(other_amount)||0, other_desc||'',
        total_claim, remarks||'', expenseId);
  } else {
    const result = db.prepare(`INSERT INTO travel_expenses
      (expense_number,user_id,date,travel_type,vehicle_number,purpose,start_odo,end_odo,distance_km,rate_per_km,
       travel_amount,fuel_type,fuel_qty,fuel_amount,toll_amount,parking_amount,other_amount,other_desc,total_claim,remarks,status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'draft')`)
      .run(nextExpenseNumber(), uid, date||today(), travel_type||'Own Two Wheeler', vehicle_number||'', purpose||'',
        s, e, distance_km, rate_per_km, travel_amount,
        fuel_type||'', parseFloat(fuel_qty)||0, parseFloat(fuel_amount)||0,
        parseFloat(toll_amount)||0, parseFloat(parking_amount)||0, parseFloat(other_amount)||0, other_desc||'',
        total_claim, remarks||'');
    expenseId = result.lastInsertRowid;
    auditLog(uid, 'expense_created', 'travel_expenses', expenseId, `Distance ${distance_km}km`);
  }

  // Re-link selected site visits
  db.prepare('DELETE FROM expense_visit_links WHERE expense_id=?').run(expenseId);
  const ids = Array.isArray(visit_ids) ? visit_ids : (visit_ids ? [visit_ids] : []);
  const linkStmt = db.prepare('INSERT OR IGNORE INTO expense_visit_links (expense_id, visit_id) VALUES (?,?)');
  ids.forEach(vid => { if (+vid) linkStmt.run(expenseId, +vid); });

  if (distance_km > 300) {
    req.session.flash = { success: `Draft saved. Note: ${distance_km}km is a large single-day distance — please double-check your odometer readings before submitting.` };
  } else {
    req.session.flash = { success: 'Draft saved.' };
  }
  res.redirect('/travel-expenses/' + expenseId);
});

// ── Upload a receipt/document for an expense ──────────────────────────────────
router.post('/:id/documents', requireClaimAccess, async (req, res) => {
  const uid = req.session.userId;
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.user_id !== uid) return res.json({ ok: false, error: 'Expense not found.' });
  if (!['draft','rejected'].includes(expense.status)) return res.json({ ok: false, error: 'This expense can no longer be edited.' });

  const { doc_type, file_path } = req.body;
  if (!file_path) return res.json({ ok: false, error: 'No file uploaded.' });

  const result = db.prepare('INSERT INTO expense_documents (expense_id, doc_type, file_path) VALUES (?,?,?)')
    .run(expense.id, doc_type||'other', file_path);

  const UPLOADS_DIR = res.app.locals.UPLOADS_DIR;
  const localPath = path.join(UPLOADS_DIR, file_path.replace('/uploads/', ''));
  const extracted = await analyzeImage(localPath);
  db.prepare('UPDATE expense_documents SET ocr_json=? WHERE id=?').run(JSON.stringify(extracted), result.lastInsertRowid);

  res.json({ ok: true, docId: result.lastInsertRowid, extracted });
});

router.post('/documents/:docId/delete', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const doc = db.prepare('SELECT ed.*, te.user_id, te.status FROM expense_documents ed JOIN travel_expenses te ON te.id=ed.expense_id WHERE ed.id=?').get(req.params.docId);
  if (!doc || doc.user_id !== uid) return res.json({ ok: false });
  if (!['draft','rejected'].includes(doc.status)) return res.json({ ok: false, error: 'Cannot modify a submitted expense.' });
  db.prepare('DELETE FROM expense_documents WHERE id=?').run(doc.id);
  res.json({ ok: true });
});

// ── Submit for approval ───────────────────────────────────────────────────────
router.post('/:id/submit', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.user_id !== uid) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/travel-expenses/my'); }
  if (!['draft','rejected'].includes(expense.status)) {
    req.session.flash = { error: `This expense is already ${expense.status}.` };
    return res.redirect('/travel-expenses/' + expense.id);
  }

  db.prepare(`UPDATE travel_expenses SET status='submitted', submitted_at=CURRENT_TIMESTAMP,
    approved_by=NULL, approved_at=NULL, approval_remarks='' WHERE id=?`).run(expense.id);
  auditLog(uid, 'expense_submitted', 'travel_expenses', expense.id, expense.expense_number);

  const user = db.prepare('SELECT full_name, manager_id FROM users WHERE id=?').get(uid);
  if (user?.manager_id) {
    createNotification(user.manager_id, `Travel Expense Submitted — ${expense.expense_number}`,
      `${user.full_name} submitted a travel expense claim of ₹${expense.total_claim.toFixed(0)}.`, 'expense', '/travel-expenses/queue');
  }

  req.session.flash = { success: `Expense ${expense.expense_number} submitted for approval.` };
  res.redirect('/travel-expenses/' + expense.id);
});

// ── My Expenses (tabs) ────────────────────────────────────────────────────────
router.get('/my', requireClaimAccess, (req, res) => {
  const uid = req.session.userId;
  const { status } = req.query;
  let sql = 'SELECT * FROM travel_expenses WHERE user_id=?';
  const params = [uid];
  if (status && status !== 'all') { sql += ' AND status=?'; params.push(status); }
  sql += ' ORDER BY date DESC, id DESC';
  const expenses = db.prepare(sql).all(...params);

  const counts = db.prepare(`SELECT status, COUNT(*) as c FROM travel_expenses WHERE user_id=? GROUP BY status`).all(uid)
    .reduce((a, r) => { a[r.status] = r.c; return a; }, {});

  const monthStart = new Date().toISOString().slice(0, 7);
  const monthRows = db.prepare(`SELECT status, SUM(distance_km) as km, SUM(travel_amount) as travel, SUM(fuel_amount) as fuel,
      SUM(toll_amount+parking_amount+other_amount) as other, SUM(total_claim) as total
    FROM travel_expenses WHERE user_id=? AND date LIKE ? GROUP BY status`).all(uid, monthStart + '%');

  const monthSummary = { km: 0, travel: 0, fuel: 0, other: 0, total: 0, submitted: 0, approved: 0, pending: 0 };
  monthRows.forEach(r => {
    monthSummary.km += r.km || 0; monthSummary.travel += r.travel || 0;
    monthSummary.fuel += r.fuel || 0; monthSummary.other += r.other || 0; monthSummary.total += r.total || 0;
    if (r.status === 'submitted') monthSummary.submitted += r.total || 0;
    if (r.status === 'approved')  monthSummary.approved  += r.total || 0;
    if (r.status === 'submitted') monthSummary.pending    += r.total || 0;
  });

  res.render('travel-expenses/list', { title: 'My Travel Expenses', expenses, counts, statusFilter: status||'all', monthSummary });
});

// ── Approval queue (must be registered before the generic /:id route below) ──
router.get('/queue', requireApprover, (req, res) => {
  const rows = db.prepare(`SELECT te.*, u.full_name, u.employee_code
    FROM travel_expenses te JOIN users u ON u.id=te.user_id
    WHERE te.status='submitted' ORDER BY te.submitted_at ASC`).all();
  res.render('travel-expenses/queue', { title: 'Expense Approvals', rows });
});

// ── Rate configuration — also registered before /:id (two segments is safe,
// but keeping it here for readability alongside /queue) ──────────────────────
router.get('/admin/rates', (req, res) => {
  const role = res.locals.user?.role;
  if (role !== 'admin' && role !== 'manager') { req.session.flash = { error: 'Admin or Manager access required.' }; return res.redirect('/'); }
  const rates = db.prepare('SELECT * FROM expense_rates ORDER BY vehicle_type').all();
  res.render('travel-expenses/rates', { title: 'Expense Rate Configuration', rates });
});

router.post('/admin/rates', (req, res) => {
  const role = res.locals.user?.role;
  if (role !== 'admin' && role !== 'manager') { req.session.flash = { error: 'Admin or Manager access required.' }; return res.redirect('/'); }
  const { vehicle_type, rate_per_km } = req.body;
  const types = Array.isArray(vehicle_type) ? vehicle_type : [vehicle_type];
  const rateVals = Array.isArray(rate_per_km) ? rate_per_km : [rate_per_km];
  types.forEach((vt, i) => {
    db.prepare('UPDATE expense_rates SET rate_per_km=?, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE vehicle_type=?')
      .run(parseFloat(rateVals[i])||0, req.session.userId, vt);
  });
  auditLog(req.session.userId, 'expense_rates_updated', 'expense_rates', '', JSON.stringify(req.body));
  req.session.flash = { success: 'Reimbursement rates updated.' };
  res.redirect('/travel-expenses/admin/rates');
});

// ── Detail (generic :id — must stay below every literal-segment route above) ─
router.get('/:id', requireClaimAccess, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense) { req.session.flash = { error: 'Expense not found.' }; return res.redirect('/travel-expenses/my'); }
  const isOwner = expense.user_id === req.session.userId;
  if (!isOwner && !isApprover(res)) {
    req.session.flash = { error: `You don't have permission to view this expense.` };
    return res.redirect('/travel-expenses/my');
  }

  const owner = db.prepare('SELECT full_name, employee_code, mobile FROM users WHERE id=?').get(expense.user_id);
  const docs = db.prepare('SELECT * FROM expense_documents WHERE expense_id=? ORDER BY uploaded_at').all(expense.id)
    .map(d => ({ ...d, ocr: d.ocr_json ? JSON.parse(d.ocr_json) : null }));
  const visits = db.prepare(`SELECT fv.* FROM field_visits fv
    JOIN expense_visit_links l ON l.visit_id=fv.id WHERE l.expense_id=?`).all(expense.id);
  const approver = expense.approved_by ? db.prepare('SELECT full_name FROM users WHERE id=?').get(expense.approved_by) : null;

  res.render('travel-expenses/detail', { title: expense.expense_number, expense, owner, docs, visits, approver, isOwner, isApprover: isApprover(res) });
});

router.post('/:id/approve', requireApprover, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.status !== 'submitted') { req.session.flash = { error: 'This expense is not pending approval.' }; return res.redirect('/travel-expenses/queue'); }

  db.prepare(`UPDATE travel_expenses SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=? WHERE id=?`)
    .run(req.session.userId, req.body.comment||'', expense.id);
  auditLog(req.session.userId, 'expense_approved', 'travel_expenses', expense.id, expense.expense_number);
  createNotification(expense.user_id, `Expense Approved — ${expense.expense_number}`,
    `Your travel expense claim of ₹${expense.total_claim.toFixed(0)} has been approved.`, 'expense', '/travel-expenses/' + expense.id);

  req.session.flash = { success: `${expense.expense_number} approved.` };
  res.redirect('/travel-expenses/queue');
});

router.post('/:id/reject', requireApprover, (req, res) => {
  const expense = db.prepare('SELECT * FROM travel_expenses WHERE id=?').get(req.params.id);
  if (!expense || expense.status !== 'submitted') { req.session.flash = { error: 'This expense is not pending approval.' }; return res.redirect('/travel-expenses/queue'); }

  db.prepare(`UPDATE travel_expenses SET status='rejected', approved_by=?, approved_at=CURRENT_TIMESTAMP, approval_remarks=? WHERE id=?`)
    .run(req.session.userId, req.body.comment||'', expense.id);
  auditLog(req.session.userId, 'expense_rejected', 'travel_expenses', expense.id, req.body.comment||'');
  createNotification(expense.user_id, `Expense Rejected — ${expense.expense_number}`,
    req.body.comment || 'Your travel expense claim was rejected.', 'expense', '/travel-expenses/' + expense.id);

  req.session.flash = { success: `${expense.expense_number} rejected.` };
  res.redirect('/travel-expenses/queue');
});

module.exports = router;
