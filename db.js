const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'quotation.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    full_name TEXT DEFAULT '',
    role TEXT DEFAULT 'user',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    address TEXT DEFAULT '',
    city TEXT DEFAULT '',
    state TEXT DEFAULT '',
    gstin TEXT DEFAULT '',
    hp_with TEXT DEFAULT '',
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS machines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    model_code TEXT UNIQUE NOT NULL,
    display_name TEXT NOT NULL,
    model_series TEXT DEFAULT '',
    basic_price INTEGER NOT NULL,
    hsn_code TEXT DEFAULT '84295900',
    engine TEXT DEFAULT '',
    transmission TEXT DEFAULT '',
    rear_axle TEXT DEFAULT '',
    pump TEXT DEFAULT '',
    front_tyre TEXT DEFAULT '',
    rear_tyre TEXT DEFAULT '',
    battery TEXT DEFAULT '',
    weight TEXT DEFAULT '',
    bucket TEXT DEFAULT '',
    warranty TEXT DEFAULT '1 Year or 2000 Hours Warranty as per company policy',
    active INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_number TEXT UNIQUE NOT NULL,
    financial_year TEXT NOT NULL,
    serial_number INTEGER NOT NULL,
    customer_id INTEGER NOT NULL,
    machine_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    quantity INTEGER DEFAULT 1,
    basic_price INTEGER NOT NULL,
    transit_insurance INTEGER DEFAULT 2000,
    freight_label TEXT DEFAULT 'Freight Extra as Actual',
    tax_mode TEXT DEFAULT 'CGST_SGST',
    cgst_rate REAL DEFAULT 9,
    sgst_rate REAL DEFAULT 9,
    igst_rate REAL DEFAULT 0,
    has_tcs INTEGER DEFAULT 1,
    tcs_rate REAL DEFAULT 1,
    insurance TEXT DEFAULT 'INCLUSIVE',
    trc TEXT DEFAULT 'INCLUSIVE',
    hp_with TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    notes TEXT DEFAULT '',
    salesperson_name TEXT DEFAULT '',
    salesperson_phone TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (customer_id) REFERENCES customers(id),
    FOREIGN KEY (machine_id) REFERENCES machines(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  );
`);

// Safe migrations for existing databases
try { db.exec("ALTER TABLE quotations ADD COLUMN salesperson_name TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE quotations ADD COLUMN salesperson_phone TEXT DEFAULT ''"); } catch(e) {}

// Seed admin user
const adminExists = db.prepare('SELECT id FROM users WHERE username = ?').get('admin');
if (!adminExists) {
  const hash = bcrypt.hashSync('admin123', 10);
  db.prepare('INSERT INTO users (username, password_hash, full_name, role) VALUES (?, ?, ?, ?)').run('admin', hash, 'Administrator', 'admin');
}

// Seed company settings
const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
const defaults = [
  ['company_name', 'SUPER ALLIED'],
  ['company_gstin', '09ACYFS8408G1ZC'],
  ['company_address', 'Aman Vihar Mawana Road, Meerut 250001'],
  ['dealer_of', 'Bull Construction Equipment Pvt. Ltd.'],
  ['contact_name', 'Haroon Rasheed'],
  ['contact_phone', '9810100522'],
  ['bank_beneficiary', 'Super Allied'],
  ['bank_account', '125001369444'],
  ['bank_ifsc', 'CNRB0018573'],
  ['bank_branch', 'DEFENCE COLONY, Mawana Road, Meerut'],
];
defaults.forEach(([k, v]) => insertSetting.run(k, v));

// Seed machine catalog (price list w.e.f. 01.05.2026)
const machines = [
  {
    model_code: 'SD76HP-2WD-BHL-FC-FC-STD-BKT-IND-TYRE-BS5',
    display_name: 'Bull Super Smart SD76 BHL 2WD',
    model_series: 'Super Smart',
    basic_price: 2446145,
    hsn_code: '84295900',
    engine: 'Kirloskar 4R1190NAI BSV CEV',
    transmission: 'Carraro 2WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Load Sensing Variable Piston Pump 3335psi',
    front_tyre: '9.00x16 - 16PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '8010 Kgs',
    bucket: '0.26 Cu.M. Backhoe Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'SD76HP-4WD-BHL-FC-FC-STD-BKT-IND-TYRE-BS5',
    display_name: 'Bull Super Smart SD76 BHL 4WD',
    model_series: 'Super Smart',
    basic_price: 2708714,
    hsn_code: '84295900',
    engine: 'Kirloskar 4R1190NAI BSV CEV',
    transmission: 'Carraro 4WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Load Sensing Variable Piston Pump 3335psi',
    front_tyre: '12.5/80x18 - 14PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '8350 Kgs',
    bucket: '0.26 Cu.M. Backhoe Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'SD76HP-2WD-BHL-FC-FC-STD-BKT-IND-TYRE-VP-BS5',
    display_name: 'Bull Champion Turbo SD76 BHL 2WD',
    model_series: 'Champion Turbo',
    basic_price: 2408145,
    hsn_code: '84295900',
    engine: 'Ashok Leyland H Series VP CEV BS5',
    transmission: 'Carraro 2WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Load Sensing Variable Piston Pump 3335psi',
    front_tyre: '9.00x16 - 16PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '8010 Kgs',
    bucket: '0.26 Cu.M. Backhoe Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'SD76HP-4WD-BHL-FC-FC-STD-BKT-IND-TYRE-VP-BS5',
    display_name: 'Bull Champion Turbo SD76 BHL 4WD',
    model_series: 'Champion Turbo',
    basic_price: 2693714,
    hsn_code: '84295900',
    engine: 'Ashok Leyland H Series VP CEV BS5',
    transmission: 'Carraro 4WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Load Sensing Variable Piston Pump 3335psi',
    front_tyre: '12.5/80x18 - 14PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '8350 Kgs',
    bucket: '0.26 Cu.M. Backhoe Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'CHALLENGER-2WD-BHL-FC-FC-STD-BKT-IND-TYRE-BS5',
    display_name: 'Bull Challenger BHL 2WD',
    model_series: 'Challenger',
    basic_price: 2308241,
    hsn_code: '84295900',
    engine: 'Kirloskar/Leyland CEV BS5',
    transmission: 'Carraro 2WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Load Sensing Variable Piston Pump',
    front_tyre: '9.00x16 - 16PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '7800 Kgs',
    bucket: '0.26 Cu.M. Backhoe Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'HD76HP-CRUSHERKING-FC-FC-IND-BS5',
    display_name: 'Bull Crusher King HD76 BHL',
    model_series: 'Crusher King',
    basic_price: 2152039,
    hsn_code: '84295900',
    engine: 'Kirloskar HD CEV BS5',
    transmission: 'Carraro 2WD Transmission',
    rear_axle: 'Heavy Duty Rear Axle',
    pump: 'Load Sensing Variable Piston Pump',
    front_tyre: '9.00x16 - 16PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '8200 Kgs',
    bucket: '0.26 Cu.M. Backhoe Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'SD76HP-2WD-FEL-HC-FC-STD-BKT-IND-TYRE-GP-BS5',
    display_name: 'Bull SS Loader SD76 FEL 2WD',
    model_series: 'SS Loader',
    basic_price: 1842208,
    hsn_code: '84295900',
    engine: 'Kirloskar CEV BS5',
    transmission: 'Carraro 2WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Gear Pump (GP)',
    front_tyre: '12.5/80x18 - 14PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '7200 Kgs',
    bucket: '1.0 Cu.M. Front Loader Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'SD76HP-4WD-FEL-HC-FC-STD-BKT-IND-TYRE-GP-BS5',
    display_name: 'Bull SS Loader SD76 FEL 4WD',
    model_series: 'SS Loader',
    basic_price: 2104777,
    hsn_code: '84295900',
    engine: 'Kirloskar CEV BS5',
    transmission: 'Carraro 4WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Gear Pump (GP)',
    front_tyre: '12.5/80x18 - 14PR',
    rear_tyre: '16.09x28 - 12PR IT Tyre',
    battery: '12V 150Ah Battery',
    weight: '7500 Kgs',
    bucket: '1.0 Cu.M. Front Loader Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'SKID-STEER-AV490-BS5',
    display_name: 'Bull Skid Steer AV490',
    model_series: 'Skid Steer',
    basic_price: 1880128,
    hsn_code: '84295900',
    engine: 'Kirloskar CEV BS5',
    transmission: 'Hydrostatic Drive',
    rear_axle: 'N/A',
    pump: 'Hydraulic Pump',
    front_tyre: '12x16.5 NHS Tyre',
    rear_tyre: '12x16.5 NHS Tyre',
    battery: '12V 100Ah Battery',
    weight: '3800 Kgs',
    bucket: '0.50 Cu.M. Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
  {
    model_code: 'GRANDIA-4WD-BHL-FCAC-6IN1-BKT-PILOT-JOYSTICK-SPS-IND-TYRE',
    display_name: 'Bull Grandia 4WD BHL AC 6-in-1 Bucket',
    model_series: 'Grandia',
    basic_price: 3518899,
    hsn_code: '84295900',
    engine: 'Kirloskar CEV BS5',
    transmission: 'Carraro 4WD Transmission',
    rear_axle: 'Carraro Rear Axle',
    pump: 'Load Sensing Variable Piston Pump with Pilot Joystick',
    front_tyre: '12.5/80x18 - 14PR',
    rear_tyre: '20.5x25 Radial Tyre',
    battery: '12V 150Ah Battery',
    weight: '9200 Kgs',
    bucket: '6-in-1 Multipurpose Bucket',
    warranty: '1 Year or 2000 Hours Warranty as per company policy',
  },
];

const insertMachine = db.prepare(`
  INSERT OR IGNORE INTO machines
    (model_code, display_name, model_series, basic_price, hsn_code,
     engine, transmission, rear_axle, pump, front_tyre, rear_tyre,
     battery, weight, bucket, warranty)
  VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
`);
machines.forEach(m => insertMachine.run(
  m.model_code, m.display_name, m.model_series, m.basic_price, m.hsn_code,
  m.engine, m.transmission, m.rear_axle, m.pump, m.front_tyre, m.rear_tyre,
  m.battery, m.weight, m.bucket, m.warranty
));

// ── Helpers ──────────────────────────────────────────────────────────────────

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

function getFY(date = new Date()) {
  const m = date.getMonth() + 1;
  const y = date.getFullYear();
  const start = m >= 4 ? y : y - 1;
  return `${String(start).slice(-2)}-${String(start + 1).slice(-2)}`;
}

function nextQuotationNumber() {
  const fy = getFY();
  const row = db.prepare('SELECT MAX(serial_number) as max FROM quotations WHERE financial_year = ?').get(fy);
  const serial = (row.max || 0) + 1;
  return { quotationNumber: `${fy}/${serial}`, financialYear: fy, serialNumber: serial };
}

function numberToWords(n) {
  n = Math.round(n);
  if (n === 0) return 'Zero Rupees Only';
  const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine',
    'Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
  const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
  function two(x) { return x < 20 ? ones[x] : tens[Math.floor(x/10)] + (x%10 ? ' '+ones[x%10] : ''); }
  function three(x) { return x>=100 ? ones[Math.floor(x/100)]+' Hundred'+(x%100?' '+two(x%100):'') : two(x); }
  let w = '';
  const cr = Math.floor(n/10000000); if (cr) { w += three(cr)+' Crore '; n %= 10000000; }
  const lk = Math.floor(n/100000);   if (lk) { w += two(lk)+' Lakh '; n %= 100000; }
  const th = Math.floor(n/1000);     if (th) { w += two(th)+' Thousand '; n %= 1000; }
  const hu = Math.floor(n/100);      if (hu) { w += ones[hu]+' Hundred '; n %= 100; }
  if (n) w += two(n)+' ';
  return w.trim()+' Rupees Only';
}

function calcQuotation(q) {
  const basic = q.basic_price * q.quantity;
  const ins   = (q.transit_insurance || 2000) * q.quantity;
  const base  = basic + ins;

  let cgst = 0, sgst = 0, igst = 0;
  if (q.tax_mode === 'IGST') {
    igst = base * (q.igst_rate || 18) / 100;
  } else {
    cgst = base * (q.cgst_rate || 9) / 100;
    sgst = base * (q.sgst_rate || 9) / 100;
  }
  const preTcs    = base + cgst + sgst + igst;
  const tcs       = q.has_tcs ? Math.round(preTcs * (q.tcs_rate || 1) / 100) : 0;
  const subTotal  = preTcs + tcs;
  const trcAmount = parseFloat(q.trc) || 0;
  const total     = subTotal + trcAmount;
  return { basic, transitInsurance: ins, base, cgst, sgst, igst, preTcs, tcs,
           subTotal, trcAmount, total,
           amountWords: numberToWords(Math.round(total)) };
}

function formatINR(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { db, getSettings, getFY, nextQuotationNumber, numberToWords, calcQuotation, formatINR };
