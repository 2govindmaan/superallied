const express = require('express');
const router  = express.Router();
const { db, getSettings } = require('../db');

// ── GET /salespersons – List all salespersons ────────────────────────────────
router.get('/', (req, res) => {
  const salespersons = db.prepare(`
    SELECT * FROM salespersons ORDER BY name
  `).all();

  const settings = getSettings();
  const defaultSalesperson = settings.default_salesperson_id || '';

  res.render('salespersons/list', {
    title: 'Salespersons',
    salespersons,
    defaultSalesperson
  });
});

// ── GET /salespersons/new – Add new salesperson form ────────────────────────
router.get('/new', (req, res) => {
  res.render('salespersons/form', {
    title: 'Add Salesperson',
    salesperson: null
  });
});

// ── POST /salespersons – Create new salesperson ───────────────────────────────
router.post('/', (req, res) => {
  const { name, phone, email, territory, target_monthly, notes } = req.body;

  if (!name?.trim()) {
    req.session.flash = { error: 'Salesperson name is required.' };
    return res.redirect('/salespersons/new');
  }

  try {
    db.prepare(`
      INSERT INTO salespersons (name, phone, email, territory, target_monthly, notes, active)
      VALUES (?, ?, ?, ?, ?, ?, 1)
    `).run(
      name.trim(),
      phone || '',
      email || '',
      territory || '',
      parseFloat(target_monthly) || 0,
      notes || ''
    );

    req.session.flash = { success: `Salesperson "${name}" added successfully.` };
    res.redirect('/salespersons');
  } catch(e) {
    req.session.flash = { error: 'Error adding salesperson: ' + e.message };
    res.redirect('/salespersons/new');
  }
});

// ── GET /salespersons/:id/edit – Edit salesperson form ───────────────────────
router.get('/:id/edit', (req, res) => {
  const salesperson = db.prepare('SELECT * FROM salespersons WHERE id = ?').get(req.params.id);
  if (!salesperson) return res.redirect('/salespersons');

  res.render('salespersons/form', {
    title: 'Edit Salesperson',
    salesperson
  });
});

// ── POST /salespersons/:id – Update salesperson ──────────────────────────────
router.post('/:id', (req, res) => {
  const { name, phone, email, territory, target_monthly, notes, active } = req.body;

  if (!name?.trim()) {
    req.session.flash = { error: 'Salesperson name is required.' };
    return res.redirect(`/salespersons/${req.params.id}/edit`);
  }

  try {
    db.prepare(`
      UPDATE salespersons
      SET name=?, phone=?, email=?, territory=?, target_monthly=?, notes=?, active=?, updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      name.trim(),
      phone || '',
      email || '',
      territory || '',
      parseFloat(target_monthly) || 0,
      notes || '',
      active === 'on' ? 1 : 0,
      req.params.id
    );

    req.session.flash = { success: 'Salesperson updated successfully.' };
    res.redirect('/salespersons');
  } catch(e) {
    req.session.flash = { error: 'Error updating salesperson: ' + e.message };
    res.redirect(`/salespersons/${req.params.id}/edit`);
  }
});

// ── POST /salespersons/:id/delete – Toggle active status (deactivate/reactivate) ──────
router.post('/:id/delete', (req, res) => {
  try {
    const sp = db.prepare('SELECT name, active FROM salespersons WHERE id = ?').get(req.params.id);
    if (!sp) {
      req.session.flash = { error: 'Salesperson not found.' };
      return res.redirect('/salespersons');
    }

    // Toggle: deactivate if active, reactivate if inactive
    const newStatus = sp.active ? 0 : 1;
    const action = sp.active ? 'deactivated' : 'reactivated';
    db.prepare('UPDATE salespersons SET active=?, updated_at=CURRENT_TIMESTAMP WHERE id = ?').run(newStatus, req.params.id);

    if (newStatus === 0) {
      req.session.flash = { success: `Salesperson "${sp.name}" deactivated. (Data preserved for existing quotations)` };
    } else {
      req.session.flash = { success: `Salesperson "${sp.name}" reactivated.` };
    }
  } catch(e) {
    req.session.flash = { error: 'Error updating salesperson status: ' + e.message };
  }
  res.redirect('/salespersons');
});

// ── POST /salespersons/:id/set-default – Set as default salesperson ──────────
router.post('/:id/set-default', (req, res) => {
  try {
    const salesperson = db.prepare('SELECT id, name, phone FROM salespersons WHERE id = ?').get(req.params.id);
    if (salesperson) {
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default_salesperson_id', req.params.id);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default_salesperson_name', salesperson.name);
      db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run('default_salesperson_phone', salesperson.phone);
      req.session.flash = { success: `Default salesperson set to "${salesperson.name}".` };
    }
  } catch(e) {
    req.session.flash = { error: 'Error setting default salesperson: ' + e.message };
  }
  res.redirect('/salespersons');
});

module.exports = router;
