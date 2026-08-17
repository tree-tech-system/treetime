require('dotenv').config();
const bcrypt = require('bcrypt');
const pool = require('../src/db/pool');

const COMPANY_ID = 1;

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const freelancers = [
      { name: 'עומר לוי', email: 'omer@treetime.co.il', rate: 150, business: 'עוסק מורשה', phone: '050-1112223' },
      { name: 'דנה כהן', email: 'dana@treetime.co.il', rate: 120, business: 'עוסק פטור', phone: '052-2223334' },
      { name: 'איתי שני', email: 'itay@treetime.co.il', rate: 110, business: 'עוסק פטור', phone: '054-3334445' },
    ];
    const freelancerIds = {};
    for (const f of freelancers) {
      const hash = await bcrypt.hash('demo1234', 12);
      const res = await client.query(
        `INSERT INTO employees (full_name, email, password_hash, role, company_id, hourly_rate, business_type, phone)
         VALUES ($1,$2,$3,'employee',$4,$5,$6,$7)
         ON CONFLICT (email) DO UPDATE SET hourly_rate=EXCLUDED.hourly_rate
         RETURNING id`,
        [f.name, f.email, hash, COMPANY_ID, f.rate, f.business, f.phone]
      );
      freelancerIds[f.name] = res.rows[0].id;
    }

    const clients = [
      { name: 'נטלי אברהם', business: 'נטלי עיצוב פנים', quota: 20, linked: ['עומר לוי'] },
      { name: 'רועי גמליאל', business: 'ג׳אמפ פיטנס', quota: 12, linked: ['דנה כהן'] },
      { name: 'ד"ר יעל בראון', business: 'קליניקת ד"ר בראון', quota: 8, linked: ['איתי שני'] },
      { name: 'ורדית כץ', business: 'סטודיו ורדית', quota: 0, linked: [] },
    ];
    const clientIds = {};
    for (const c of clients) {
      const res = await client.query(
        `INSERT INTO projects (name, business_name, company_id, use_hours_bank, monthly_quota_hours)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [c.name, c.business, COMPANY_ID, c.quota > 0, c.quota]
      );
      clientIds[c.name] = res.rows[0].id;
      for (const fname of c.linked) {
        await client.query('INSERT INTO project_freelancers (project_id, employee_id) VALUES ($1,$2)', [res.rows[0].id, freelancerIds[fname]]);
      }
    }

    const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return d; };
    const atTime = (date, hm) => { const [h, m] = hm.split(':').map(Number); const d = new Date(date); d.setHours(h, m, 0, 0); return d; };

    const entries = [
      { f: 'עומר לוי', c: 'נטלי אברהם', day: 1, start: '09:00', end: '12:30', desc: 'בניית אוטומציית WhatsApp ותיקון פורמולת תאריך' },
      { f: 'דנה כהן', c: 'רועי גמליאל', day: 1, start: '10:00', end: '11:15', desc: 'עדכון דשבורד מנהל לפי בקשת הלקוח' },
      { f: 'עומר לוי', c: 'נטלי אברהם', day: 2, start: '13:00', end: '16:00', desc: 'בניית טופס ליד חדש + מיפוי שדות' },
      { f: 'איתי שני', c: 'ד"ר יעל בראון', day: 2, start: '09:30', end: '10:45', desc: 'תחזוקה שוטפת - בדיקת אוטומציות' },
      { f: 'דנה כהן', c: 'רועי גמליאל', day: 3, start: '14:00', end: '18:30', desc: 'בניית לוגיקת ספירת צ׳קבוקסים' },
      { f: 'עומר לוי', c: 'ורדית כץ', day: 4, start: '09:00', end: '10:30', desc: 'פגישת אפיון ראשונית' },
      { f: 'איתי שני', c: 'נטלי אברהם', day: 5, start: '11:00', end: '13:00', desc: 'בדיקות QA לאוטומציות דיווח עבודה' },
      { f: 'דנה כהן', c: 'ד"ר יעל בראון', day: 6, start: '09:00', end: '12:00', desc: 'בניית מרכז דיווחי עבודה ללקוח' },
      { f: 'עומר לוי', c: 'רועי גמליאל', day: 9, start: '10:00', end: '13:30', desc: 'אינטגרציית קישור ללקוח בטופס סיום עבודה' },
    ];
    const rateOf = { 'עומר לוי': 150, 'דנה כהן': 120, 'איתי שני': 110 };
    for (const e of entries) {
      const day = daysAgo(e.day);
      const started = atTime(day, e.start);
      const ended = atTime(day, e.end);
      const hours = (ended - started) / 3600000;
      const rate = rateOf[e.f];
      const cost = Math.round(hours * rate * 100) / 100;
      await client.query(
        `INSERT INTO time_entries (employee_id, project_id, description, started_at, ended_at, source, company_id, rate_snapshot, cost)
         VALUES ($1,$2,$3,$4,$5,'web',$6,$7,$8)`,
        [freelancerIds[e.f], clientIds[e.c], e.desc, started.toISOString(), ended.toISOString(), COMPANY_ID, rate, cost]
      );
    }

    await client.query('COMMIT');
    console.log('Seed complete:', { freelancerIds, clientIds });
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
