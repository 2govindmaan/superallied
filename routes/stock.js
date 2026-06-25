const express  = require('express');
const router   = express.Router();
const { db, auditLog } = require('../db');
const XLSX     = require('xlsx');

// ── List / filter ─────────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  const { part_number, part_name, category, out_of_stock, page = 1 } = req.query;
  const limit  = 50;
  const offset = (parseInt(page) - 1) * limit;

  const conds = [];
  const params = [];

  if (part_number) { conds.push("(sp.sap_part_no LIKE ? OR sp.rnd_part_no LIKE ?)"); params.push(`%${part_number}%`, `%${part_number}%`); }
  if (part_name)   { conds.push("sp.material_description LIKE ?"); params.push(`%${part_name}%`); }
  if (category)    { conds.push("COALESCE(sa.category, sp.category,'')=?"); params.push(category); }
  if (out_of_stock === '1') { conds.push("COALESCE(sa.stock_quantity,0)=0"); }

  const where = conds.length ? 'WHERE ' + conds.join(' AND ') : '';

  const rows = db.prepare(`
    SELECT sp.id, sp.sap_part_no, sp.rnd_part_no, sp.material_description,
           sp.hsn_code, sp.category AS part_category,
           COALESCE(sa.stock_quantity,0) AS stock_quantity,
           COALESCE(sa.category, sp.category, '') AS category,
           sa.remarks, sa.updated_at, sa.updated_by,
           u.full_name AS updated_by_name
    FROM spare_parts sp
    LEFT JOIN stock_availability sa ON sa.part_id = sp.id
    LEFT JOIN users u ON u.id = sa.updated_by
    ${where}
    ORDER BY sp.sap_part_no ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const total = db.prepare(`
    SELECT COUNT(*) AS cnt
    FROM spare_parts sp
    LEFT JOIN stock_availability sa ON sa.part_id = sp.id
    ${where}
  `).get(...params).cnt;

  const categories = db.prepare(`
    SELECT DISTINCT COALESCE(sa.category, sp.category,'') AS cat
    FROM spare_parts sp
    LEFT JOIN stock_availability sa ON sa.part_id=sp.id
    WHERE cat != ''
    ORDER BY cat ASC
  `).all().map(r => r.cat);

  res.render('stock/list', {
    title: 'Stock Availability',
    rows, total, categories,
    filters: { part_number: part_number||'', part_name: part_name||'', category: category||'', out_of_stock: out_of_stock||'' },
    page: parseInt(page), limit,
    pages: Math.ceil(total / limit),
    flash: req.session.flash || {}
  });
  delete req.session.flash;
});

// ── API: get stock for one part (used by quotation form) ─────────────────────
router.get('/api/:partId', (req, res) => {
  const row = db.prepare(`
    SELECT COALESCE(sa.stock_quantity,0) AS stock_quantity
    FROM spare_parts sp
    LEFT JOIN stock_availability sa ON sa.part_id=sp.id
    WHERE sp.id=?
  `).get(req.params.partId);
  if (!row) return res.json({ stock_quantity: 0 });
  res.json(row);
});

// ── Update / upsert stock for one part ───────────────────────────────────────
router.post('/:partId/update', (req, res) => {
  const { stock_quantity, remarks, category } = req.body;
  const qty = parseInt(stock_quantity) || 0;
  const partId = parseInt(req.params.partId);

  db.prepare(`
    INSERT INTO stock_availability (part_id, stock_quantity, remarks, category, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(part_id) DO UPDATE SET
      stock_quantity = excluded.stock_quantity,
      remarks        = excluded.remarks,
      category       = excluded.category,
      updated_by     = excluded.updated_by,
      updated_at     = CURRENT_TIMESTAMP
  `).run(partId, qty, remarks||'', category||'', req.session.userId);

  if (category) {
    db.prepare("UPDATE spare_parts SET category=? WHERE id=?").run(category, partId);
  }

  auditLog(req.session.userId, 'STOCK_UPDATED', 'stock_availability', partId, `qty=${qty}`);

  if (req.headers['x-requested-with'] === 'XMLHttpRequest' || req.headers.accept?.includes('json')) {
    return res.json({ ok: true });
  }
  req.session.flash = { success: 'Stock updated.' };
  res.redirect('/stock');
});

// ── Export to Excel ───────────────────────────────────────────────────────────
router.get('/export', (req, res) => {
  const rows = db.prepare(`
    SELECT sp.sap_part_no AS "SAP Part No",
           sp.rnd_part_no AS "RND Part No",
           sp.material_description AS "Description",
           COALESCE(sa.category, sp.category,'') AS "Category",
           COALESCE(sa.stock_quantity,0) AS "Stock Quantity",
           sa.remarks AS "Remarks",
           sa.updated_at AS "Last Updated",
           u.full_name AS "Updated By"
    FROM spare_parts sp
    LEFT JOIN stock_availability sa ON sa.part_id=sp.id
    LEFT JOIN users u ON u.id=sa.updated_by
    ORDER BY sp.part_number ASC
  `).all();

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Stock');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="stock_availability.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Download import template ──────────────────────────────────────────────────
router.get('/template', (req, res) => {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ['SAP Part No', 'RND Part No', 'Stock Quantity', 'Remarks', 'Category'],
    ['SAP-001', 'RND-001', 10, 'In warehouse', 'Bearings'],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  res.setHeader('Content-Disposition', 'attachment; filename="stock_import_template.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

// ── Bulk import Excel ─────────────────────────────────────────────────────────
router.post('/import/excel', (req, res) => {
  if (!req.files?.file) {
    req.session.flash = { error: 'No file uploaded.' };
    return res.redirect('/stock');
  }

  const wb  = XLSX.read(req.files.file.data, { type: 'buffer' });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const data = XLSX.utils.sheet_to_json(ws, { defval: '' });

  let imported = 0;
  const failed  = [];

  for (const row of data) {
    const sapNo   = String(row['SAP Part No'] || row['Part Number'] || row['part_number'] || '').trim();
    const rndNo   = String(row['RND Part No'] || row['rnd_part_no'] || '').trim();
    const qty     = parseInt(row['Stock Quantity'] || row['stock_quantity'] || row['QTY'] || 0);
    const remarks = String(row['Remarks'] || row['remarks'] || '').trim();
    const cat     = String(row['Category'] || row['category'] || '').trim();

    if (!sapNo && !rndNo) { failed.push({ row, reason: 'Missing Part Number' }); continue; }

    const part = db.prepare("SELECT id FROM spare_parts WHERE sap_part_no=? OR rnd_part_no=?").get(sapNo || rndNo, rndNo || sapNo);
    if (!part) { failed.push({ row, reason: `Part not found: ${sapNo || rndNo}` }); continue; }

    db.prepare(`
      INSERT INTO stock_availability (part_id, stock_quantity, remarks, category, updated_by, updated_at)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(part_id) DO UPDATE SET
        stock_quantity = excluded.stock_quantity,
        remarks        = excluded.remarks,
        category       = excluded.category,
        updated_by     = excluded.updated_by,
        updated_at     = CURRENT_TIMESTAMP
    `).run(part.id, isNaN(qty) ? 0 : qty, remarks, cat, req.session.userId);

    if (cat) db.prepare("UPDATE spare_parts SET category=? WHERE id=?").run(cat, part.id);
    imported++;
  }

  auditLog(req.session.userId, 'STOCK_BULK_IMPORT', 'stock_availability', null, `imported=${imported} failed=${failed.length}`);

  if (failed.length) {
    // Return failed rows as downloadable Excel
    const fwb = XLSX.utils.book_new();
    const fws = XLSX.utils.json_to_sheet(failed.map(f => ({ ...f.row, Error: f.reason })));
    XLSX.utils.book_append_sheet(fwb, fws, 'Failed');
    const fbuf = XLSX.write(fwb, { type: 'buffer', bookType: 'xlsx' });
    // Store in session for download
    req.session.failedImport = fbuf.toString('base64');
    req.session.flash = { success: `Imported ${imported} rows. ${failed.length} failed — download below.`, failedCount: failed.length };
  } else {
    req.session.flash = { success: `Successfully imported ${imported} rows.` };
  }

  res.redirect('/stock');
});

// ── Download failed import rows ───────────────────────────────────────────────
router.get('/import/failed', (req, res) => {
  const b64 = req.session.failedImport;
  if (!b64) return res.redirect('/stock');
  const buf = Buffer.from(b64, 'base64');
  delete req.session.failedImport;
  res.setHeader('Content-Disposition', 'attachment; filename="stock_import_failed.xlsx"');
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.send(buf);
});

module.exports = router;
