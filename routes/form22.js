const express = require('express');
const router  = express.Router();
const { getSettings } = require('../db');
const { generatePDF } = require('../pdf');

router.get('/', (req, res) => {
  res.render('form22', { title: 'Form 22' });
});

router.post('/pdf', async (req, res) => {
  const f = req.body;
  if (!f.model?.trim() || !f.engine_number?.trim() || !f.serial_number?.trim()) {
    req.session.flash = { error: 'Model, Engine Number and Serial Number are required.' };
    return res.redirect('/form-22');
  }

  const [y, m, d] = (f.date || '').split('-');
  const displayDate = (y && m && d) ? `${d}.${m}.${y}` : new Date().toLocaleDateString('en-GB').split('/').join('.');

  const cert = {
    displayDate,
    model: f.model.trim(),
    chassis_number: (f.chassis_number || '').trim(),
    serial_number: f.serial_number.trim(),
    engine_number: f.engine_number.trim(),
    norms: (f.norms || 'BS V CEV').trim(),
  };

  const settings = getSettings();
  const html = await new Promise((resolve, reject) =>
    res.app.render('form22-pdf', { cert, settings, bullLogoB64: req.app.locals.bullLogoB64 },
      (err, h) => err ? reject(err) : resolve(h)));

  try {
    const pdfBuffer = await generatePDF(html);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Form22-${cert.serial_number.replace(/[^a-zA-Z0-9]/g, '')}.pdf"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Form 22 PDF error:', err);
    req.session.flash = { error: 'PDF generation failed. Is Puppeteer installed?' };
    res.redirect('/form-22');
  }
});

module.exports = router;
