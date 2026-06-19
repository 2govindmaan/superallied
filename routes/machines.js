const express = require('express');
const router  = express.Router();
const { db }  = require('../db');

// ── GET /machines/price-update – Update selling prices table ────────────────
router.get('/price-update', (req, res) => {
  const machines = db.prepare(`
    SELECT id, display_name, model_series, basic_price
    FROM machines WHERE active=1 ORDER BY display_name
  `).all();

  res.render('machines/price-update', { title: 'Update Machine Selling Prices', machines });
});

// ── PUT /machines/:id/selling-price – Update selling price ───────────────────
router.put('/:id/selling-price', (req, res) => {
  const { basic_price } = req.body;

  if (basic_price === undefined || basic_price === null) {
    return res.json({ ok: false, error: 'basic_price required' });
  }

  const price = parseInt(basic_price) || 0;
  if (price <= 0) {
    return res.json({ ok: false, error: 'Price must be greater than 0' });
  }

  try {
    db.prepare('UPDATE machines SET basic_price=? WHERE id=?')
      .run(price, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── GET /machines – Admin machine management console ─────────────────────────
router.get('/', (req, res) => {
  const machines = db.prepare(`
    SELECT m.*, COUNT(s.id) as spec_count
    FROM machines m
    LEFT JOIN machine_specs s ON m.id=s.machine_id
    GROUP BY m.id
    ORDER BY m.display_name
  `).all();

  res.render('machines/list', { title: 'Machine Management', machines });
});

// ── GET /machines/:id – View machine details ───────────────────────────────
router.get('/:id', (req, res) => {
  const machine = db.prepare('SELECT * FROM machines WHERE id=?').get(req.params.id);
  if (!machine) return res.status(404).send('Machine not found');

  const specs = db.prepare('SELECT * FROM machine_specs WHERE machine_id=? ORDER BY display_order').all(req.params.id);

  res.render('machines/detail', { title: machine.display_name, machine, specs });
});

// ── POST /machines – Create new machine ─────────────────────────────────────
router.post('/', (req, res) => {
  const { model_code, display_name, model_series, basic_price, engine, transmission, rear_axle, pump, front_tyre, rear_tyre, battery, weight, bucket, warranty } = req.body;

  if (!model_code || !display_name || !basic_price) {
    return res.json({ ok: false, error: 'model_code, display_name, basic_price are required' });
  }

  try {
    db.prepare(`
      INSERT INTO machines
      (model_code, display_name, model_series, basic_price, engine, transmission, rear_axle, pump, front_tyre, rear_tyre, battery, weight, bucket, warranty)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(model_code, display_name, model_series || '', basic_price, engine || '', transmission || '', rear_axle || '', pump || '', front_tyre || '', rear_tyre || '', battery || '', weight || '', bucket || '', warranty || '1 Year or 2000 Hours Warranty as per company policy');

    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── PUT /machines/:id – Update machine ─────────────────────────────────────
router.put('/:id', (req, res) => {
  const { display_name, model_series, basic_price, engine, transmission, rear_axle, pump, front_tyre, rear_tyre, battery, weight, bucket, warranty } = req.body;

  try {
    db.prepare(`
      UPDATE machines
      SET display_name=?, model_series=?, basic_price=?, engine=?, transmission=?, rear_axle=?, pump=?, front_tyre=?, rear_tyre=?, battery=?, weight=?, bucket=?, warranty=?
      WHERE id=?
    `).run(display_name, model_series || '', basic_price, engine || '', transmission || '', rear_axle || '', pump || '', front_tyre || '', rear_tyre || '', battery || '', weight || '', bucket || '', warranty || '', req.params.id);

    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── DELETE /machines/:id – Delete machine ──────────────────────────────────
router.delete('/:id', (req, res) => {
  try {
    // Delete specs first (or use CASCADE)
    db.prepare('DELETE FROM machine_specs WHERE machine_id=?').run(req.params.id);
    db.prepare('DELETE FROM machines WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── POST /machines/:id/specs – Add spec ────────────────────────────────────
router.post('/:id/specs', (req, res) => {
  const { spec_name, spec_value, display_order } = req.body;

  if (!spec_name || !spec_value) {
    return res.json({ ok: false, error: 'spec_name and spec_value required' });
  }

  try {
    db.prepare(`
      INSERT INTO machine_specs (machine_id, spec_name, spec_value, display_order)
      VALUES (?,?,?,?)
    `).run(req.params.id, spec_name, spec_value, display_order || 0);

    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// ── DELETE /machines/:id/specs/:specId – Delete spec ───────────────────────
router.delete('/:id/specs/:specId', (req, res) => {
  try {
    db.prepare('DELETE FROM machine_specs WHERE id=? AND machine_id=?').run(req.params.specId, req.params.id);
    res.json({ ok: true });
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

module.exports = router;
