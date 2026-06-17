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

  CREATE TABLE IF NOT EXISTS machine_specs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id INTEGER NOT NULL REFERENCES machines(id) ON DELETE CASCADE,
    spec_name TEXT NOT NULL,
    spec_value TEXT NOT NULL,
    display_order INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_specs_machine ON machine_specs(machine_id);

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

// ── Safe migrations ───────────────────────────────────────────────────────────

// Quotation columns
try { db.exec("ALTER TABLE quotations ADD COLUMN salesperson_name TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE quotations ADD COLUMN salesperson_phone TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE quotations ADD COLUMN tyre_option TEXT DEFAULT 'IT'"); } catch(e) {}

// Spare quotation columns
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN show_discount INTEGER DEFAULT 0"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN quotation_date DATE"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN salesperson_id INTEGER REFERENCES salespersons(id)"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN approval_status TEXT DEFAULT 'draft'"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN approval_notes TEXT DEFAULT ''"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN approved_by INTEGER REFERENCES users(id)"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN approved_at DATETIME"); } catch(e) {}
try { db.exec("ALTER TABLE spare_quotations ADD COLUMN roundoff_amount REAL DEFAULT 0"); } catch(e) {}

// Machine quotation salesperson link
try { db.exec("ALTER TABLE quotations ADD COLUMN salesperson_id INTEGER REFERENCES salespersons(id)"); } catch(e) {}
try { db.exec("ALTER TABLE quotations ADD COLUMN tyre_option TEXT DEFAULT 'IT'"); } catch(e) {}

// Employee profile columns on users
const userCols = [
  "ALTER TABLE users ADD COLUMN employee_code TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN designation TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN department TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN mobile TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN emergency_contact TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN date_of_joining DATE",
  "ALTER TABLE users ADD COLUMN photo_path TEXT DEFAULT ''",
  "ALTER TABLE users ADD COLUMN manager_id INTEGER",
  "ALTER TABLE users ADD COLUMN is_hr_active INTEGER DEFAULT 1",
];
userCols.forEach(sql => { try { db.exec(sql); } catch(e) {} });

// ── HR Tables ─────────────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    date DATE NOT NULL,
    check_in_time  DATETIME,
    check_in_lat   REAL,
    check_in_lng   REAL,
    check_in_photo TEXT,
    check_out_time DATETIME,
    check_out_lat  REAL,
    check_out_lng  REAL,
    check_out_photo TEXT,
    status TEXT DEFAULT 'present',
    notes TEXT DEFAULT '',
    UNIQUE(user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_att_date ON attendance(date);
  CREATE INDEX IF NOT EXISTS idx_att_user ON attendance(user_id);

  CREATE TABLE IF NOT EXISTS leave_types (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    days_per_year INTEGER DEFAULT 12,
    carry_forward INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS leave_balances (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    year INTEGER NOT NULL,
    allocated REAL DEFAULT 0,
    used      REAL DEFAULT 0,
    UNIQUE(user_id, leave_type_id, year)
  );

  CREATE TABLE IF NOT EXISTS leaves (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    leave_type_id INTEGER NOT NULL REFERENCES leave_types(id),
    start_date DATE NOT NULL,
    end_date   DATE NOT NULL,
    days       REAL NOT NULL,
    reason     TEXT DEFAULT '',
    status     TEXT DEFAULT 'pending',
    reviewed_by      INTEGER REFERENCES users(id),
    reviewer_comment TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_leaves_user ON leaves(user_id);

  CREATE TABLE IF NOT EXISTS salary_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    month      TEXT NOT NULL,
    basic      REAL DEFAULT 0,
    hra        REAL DEFAULT 0,
    allowances REAL DEFAULT 0,
    gross      REAL DEFAULT 0,
    pf         REAL DEFAULT 0,
    esic       REAL DEFAULT 0,
    tds        REAL DEFAULT 0,
    other_ded  REAL DEFAULT 0,
    net_salary REAL DEFAULT 0,
    paid_on    DATE,
    remarks    TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, month)
  );

  CREATE TABLE IF NOT EXISTS incentive_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    month      TEXT NOT NULL,
    amount     REAL DEFAULT 0,
    reason     TEXT DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id   INTEGER NOT NULL REFERENCES users(id),
    title     TEXT NOT NULL,
    body      TEXT DEFAULT '',
    type      TEXT DEFAULT 'info',
    is_read   INTEGER DEFAULT 0,
    link      TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, is_read);

  CREATE TABLE IF NOT EXISTS field_visits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id       INTEGER NOT NULL REFERENCES users(id),
    customer_name TEXT NOT NULL,
    visit_time    DATETIME DEFAULT CURRENT_TIMESTAMP,
    lat  REAL,
    lng  REAL,
    photo   TEXT,
    remarks TEXT DEFAULT ''
  );
  CREATE INDEX IF NOT EXISTS idx_visits_user ON field_visits(user_id);

  CREATE TABLE IF NOT EXISTS expense_journeys (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL REFERENCES users(id),
    date       DATE NOT NULL,
    start_km   REAL,
    start_photo TEXT,
    start_lat  REAL,
    start_lng  REAL,
    start_time DATETIME,
    end_km     REAL,
    end_photo  TEXT,
    end_lat    REAL,
    end_lng    REAL,
    end_time   DATETIME,
    total_km   REAL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(user_id, date)
  );
  CREATE INDEX IF NOT EXISTS idx_journey_user ON expense_journeys(user_id, date);
`);

// Add is_active column to leave_types if missing
try { db.exec("ALTER TABLE leave_types ADD COLUMN is_active INTEGER DEFAULT 1"); } catch(e) {}

// ── Lead Management Tables ────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS leads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_number TEXT UNIQUE NOT NULL,
    created_by INTEGER REFERENCES users(id),

    sh_name TEXT DEFAULT '',
    team_member TEXT DEFAULT '',
    state TEXT DEFAULT '',
    dealer_location TEXT DEFAULT '',
    district TEXT DEFAULT '',
    tehsil TEXT DEFAULT '',
    village_city TEXT DEFAULT '',

    customer_name TEXT NOT NULL,
    customer_phone TEXT DEFAULT '',
    model_required TEXT DEFAULT '',
    who_visited TEXT DEFAULT '',

    visit1_date TEXT DEFAULT NULL,
    visit2_date TEXT DEFAULT NULL,
    visit3_date TEXT DEFAULT NULL,

    demo_seen INTEGER DEFAULT 0,
    expected_purchase_date TEXT DEFAULT NULL,
    customer_interested INTEGER DEFAULT 0,
    margin_money_available TEXT DEFAULT '',
    customer_category TEXT DEFAULT 'FTB',

    current_stage INTEGER DEFAULT 1,
    status TEXT DEFAULT 'active',

    docs_submitted INTEGER DEFAULT 0,
    guarantor_docs_submitted INTEGER DEFAULT 0,
    guarantor_name TEXT DEFAULT '',
    cibil_customer TEXT DEFAULT '',
    cibil_guarantor TEXT DEFAULT '',

    fi_done INTEGER DEFAULT 0,
    fi_result TEXT DEFAULT '',
    financier_name TEXT DEFAULT '',
    financier_exec_name TEXT DEFAULT '',
    exec_contact TEXT DEFAULT '',

    loan_amount_required TEXT DEFAULT '',
    credit_query_resolved INTEGER DEFAULT 0,
    credit_approval_raised INTEGER DEFAULT 0,
    loan_sanctioned INTEGER DEFAULT 0,
    loan_amount TEXT DEFAULT '',

    do_expected_date TEXT DEFAULT NULL,
    do_issued INTEGER DEFAULT 0,
    margin_money_status TEXT DEFAULT '',
    billing_done INTEGER DEFAULT 0,
    invoice_done INTEGER DEFAULT 0,
    insurance_done INTEGER DEFAULT 0,
    form_21_22 INTEGER DEFAULT 0,

    margin_money_receipt INTEGER DEFAULT 0,
    ltt_receipt INTEGER DEFAULT 0,
    rc_submitted INTEGER DEFAULT 0,

    customer_assets TEXT DEFAULT '',
    other_income TEXT DEFAULT '',
    work_order INTEGER DEFAULT 0,
    remarks TEXT DEFAULT '',

    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_leads_created_by ON leads(created_by);
  CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(current_stage);
  CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
`);

// Role-based permissions table
db.exec(`
  CREATE TABLE IF NOT EXISTS role_permissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    permission TEXT NOT NULL,
    UNIQUE(role, permission)
  );
`);

// Seed leave types (only CL and SL active by default)
const insertLT = db.prepare('INSERT OR IGNORE INTO leave_types (code, name, days_per_year, carry_forward, is_active) VALUES (?,?,?,?,?)');
[['CL','Casual Leave',12,0,1],['SL','Sick Leave',12,0,1],['EL','Earned Leave',15,1,0],['HD','Half Day',24,0,0]]
  .forEach(r => insertLT.run(...r));
// Ensure EL and HD stay inactive even on existing DBs
db.prepare("UPDATE leave_types SET is_active=0 WHERE code IN ('EL','HD')").run();

// Seed default role permissions
const insertPerm = db.prepare('INSERT OR IGNORE INTO role_permissions (role, permission) VALUES (?,?)');
const defaultPerms = [
  // manager
  ['manager','attendance'],['manager','hr_admin'],['manager','leave_approval'],
  ['manager','attendance_admin'],['manager','quotations'],['manager','customers'],
  ['manager','salary_admin'],['manager','reports'],
  // sales
  ['sales','attendance'],['sales','field_visit'],['sales','route_map'],
  ['sales','expense_claim'],['sales','quotations'],['sales','customers'],
  // service
  ['service','attendance'],['service','field_visit'],['service','route_map'],['service','expense_claim'],
  // hr
  ['hr','attendance'],['hr','hr_admin'],['hr','leave_approval'],['hr','attendance_admin'],['hr','reports'],
  // office
  ['office','attendance'],['office','quotations'],['office','customers'],
  // staff (backward compat = sales)
  ['staff','attendance'],['staff','field_visit'],['staff','quotations'],['staff','customers'],
  // employee (basic)
  ['employee','attendance'],
];
defaultPerms.forEach(([r,p]) => insertPerm.run(r,p));

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

// ── Initialize default settings ──────────────────────────────────────────────
const defaultSettings = {
  company_name: 'Super Allied',
  company_gstin: '18AABCT5419H1ZO',
  company_address: 'Address not set',
  dealer_of: 'Bull Tractors',
  contact_name: 'Contact Name',
  contact_phone: '+91-XXXXXXXXXX',
  bank_beneficiary: 'Bank Account Holder Name',
  bank_account: 'Account Number',
  bank_ifsc: 'IFSC Code',
  bank_branch: 'Branch Name',
  salesperson_name: 'Govind Maan',
  salesperson_phone: '+919690014010',
  rto_default_rate: '6',
  price_lock_enabled: '1',
  roundoff_enabled: '1',
  roundoff_amount: '500',
  company_email: '',
  company_udyam: '',
  company_phone_sales: '',
  company_phone_service: '',
  company_state: 'Uttar Pradesh',
  company_state_code: '09',
  company_upi: ''
};

Object.entries(defaultSettings).forEach(([key, defaultValue]) => {
  try {
    const existing = db.prepare('SELECT value FROM settings WHERE key=?').get(key);
    if (!existing) {
      db.prepare('INSERT INTO settings (key, value) VALUES (?,?)').run(key, defaultValue);
    }
  } catch(e) {}
});

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

function calcQuotation(q, settings) {
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
  let total       = subTotal + trcAmount;

  // Apply upward roundoff if enabled
  if (settings && settings.roundoff_enabled === '1') {
    const roundoffAmount = parseInt(settings.roundoff_amount) || 500;
    total = Math.ceil(total / roundoffAmount) * roundoffAmount;
  }

  return { basic, transitInsurance: ins, base, cgst, sgst, igst, preTcs, tcs,
           subTotal, trcAmount, total, roundoffApplied: total !== (subTotal + trcAmount),
           amountWords: numberToWords(Math.round(total)) };
}

function formatINR(n) {
  if (n == null) return '';
  return Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function getUserPermissions(role) {
  if (role === 'admin') return ['*'];
  return db.prepare('SELECT permission FROM role_permissions WHERE role=?').all(role).map(r => r.permission);
}

function createNotification(userId, title, body = '', type = 'info', link = '') {
  try {
    db.prepare('INSERT INTO notifications (user_id,title,body,type,link) VALUES (?,?,?,?,?)')
      .run(userId, title, body, type, link);
  } catch(e) { /* non-critical */ }
}

// ── Spare Parts System Tables ─────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS sold_machines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_no TEXT UNIQUE NOT NULL,
    chassis_number TEXT DEFAULT '',
    engine_number TEXT DEFAULT '',
    model TEXT DEFAULT '',
    customer_name TEXT NOT NULL,
    customer_address TEXT DEFAULT '',
    place_of_supply TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    mobile_1 TEXT DEFAULT '',
    mobile_2 TEXT DEFAULT '',
    finance_type TEXT DEFAULT 'Cash',
    financier TEXT DEFAULT '',
    registration_no TEXT DEFAULT '',
    gst_number TEXT DEFAULT '',
    pan_number TEXT DEFAULT '',
    dealer TEXT DEFAULT '',
    date_of_sale DATE,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sold_machine_no ON sold_machines(machine_no);
  CREATE INDEX IF NOT EXISTS idx_sold_customer ON sold_machines(customer_name);
  CREATE INDEX IF NOT EXISTS idx_sold_mobile ON sold_machines(mobile_1);

  CREATE TABLE IF NOT EXISTS spare_parts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sap_part_no TEXT DEFAULT '',
    rnd_part_no TEXT DEFAULT '',
    material_description TEXT NOT NULL,
    hsn_code TEXT DEFAULT '',
    tax_rate REAL DEFAULT 18,
    ndp_basic REAL DEFAULT 0,
    ndp_gst REAL DEFAULT 0,
    ndp_price REAL DEFAULT 0,
    mrp_basic REAL DEFAULT 0,
    mrp_gst REAL DEFAULT 0,
    mrp_price REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_parts_sap ON spare_parts(sap_part_no);
  CREATE INDEX IF NOT EXISTS idx_parts_rnd ON spare_parts(rnd_part_no);

  CREATE TABLE IF NOT EXISTS spare_quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_no TEXT UNIQUE NOT NULL,
    serial_number INTEGER NOT NULL,
    financial_year TEXT NOT NULL,
    sold_machine_id INTEGER REFERENCES sold_machines(id),
    machine_no TEXT DEFAULT '',
    customer_name TEXT NOT NULL,
    customer_address TEXT DEFAULT '',
    customer_gstin TEXT DEFAULT '',
    contact_person TEXT DEFAULT '',
    mobile TEXT DEFAULT '',
    place_of_supply TEXT DEFAULT '',
    tax_mode TEXT DEFAULT 'CGST_SGST',
    salesperson TEXT DEFAULT '',
    validity_days INTEGER DEFAULT 30,
    remarks TEXT DEFAULT '',
    terms TEXT DEFAULT 'Prices are subject to change without notice.\nGoods once sold will not be taken back.\nAll disputes subject to Meerut jurisdiction.',
    status TEXT DEFAULT 'draft',
    total_basic REAL DEFAULT 0,
    total_gst REAL DEFAULT 0,
    grand_total REAL DEFAULT 0,
    created_by INTEGER REFERENCES users(id),
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_sq_machine_no ON spare_quotations(machine_no);
  CREATE INDEX IF NOT EXISTS idx_sq_date ON spare_quotations(created_at);
  CREATE INDEX IF NOT EXISTS idx_sq_status ON spare_quotations(status);

  CREATE TABLE IF NOT EXISTS spare_quotation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    quotation_id INTEGER NOT NULL REFERENCES spare_quotations(id) ON DELETE CASCADE,
    part_no TEXT DEFAULT '',
    description TEXT NOT NULL,
    hsn TEXT DEFAULT '',
    qty REAL DEFAULT 1,
    basic_rate REAL DEFAULT 0,
    discount_percent REAL DEFAULT 0,
    discount_amount REAL DEFAULT 0,
    tax_rate REAL DEFAULT 18,
    tax_amount REAL DEFAULT 0,
    net_rate REAL DEFAULT 0,
    line_total REAL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_sqi_quotation ON spare_quotation_items(quotation_id);

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity TEXT DEFAULT '',
    entity_id TEXT DEFAULT '',
    details TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_log(entity, entity_id);

  CREATE TABLE IF NOT EXISTS salespersons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    territory TEXT DEFAULT '',
    target_monthly REAL DEFAULT 0,
    active INTEGER DEFAULT 1,
    notes TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

function nextSpareQuotationNumber() {
  const fy = getFY();
  const row = db.prepare('SELECT MAX(serial_number) as max FROM spare_quotations WHERE financial_year = ?').get(fy);
  const serial = (row.max || 0) + 1;
  const padded = String(serial).padStart(4, '0');
  return { quotationNo: `SP-${fy}/${padded}`, financialYear: fy, serialNumber: serial };
}

function auditLog(userId, action, entity = '', entityId = '', details = '') {
  try {
    db.prepare('INSERT INTO audit_log (user_id,action,entity,entity_id,details) VALUES (?,?,?,?,?)')
      .run(userId, action, entity, String(entityId), details);
  } catch(e) {}
}

module.exports = { db, getSettings, getFY, nextQuotationNumber, nextSpareQuotationNumber, numberToWords, calcQuotation, formatINR, createNotification, getUserPermissions, auditLog };
