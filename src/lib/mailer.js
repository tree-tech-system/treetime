const nodemailer = require('nodemailer');
const pool = require('../db/pool');

const SUPPORT_EMAIL = process.env.SUPPORT_EMAIL || 'support@tree-tech-system.com';

// SMTP connection settings can be configured two ways: the server .env (SMTP_HOST etc.,
// set once by whoever has SSH access) or the owner panel (src/routes/ownerEmail.js,
// smtp_settings table) -- whichever the owner set most recently there wins per-field,
// env vars are just the bootstrap fallback. Read fresh on every send (not cached) so a
// settings change in the owner panel takes effect immediately, no server restart needed.
async function getSmtpConfig() {
  const { rows } = await pool.query('SELECT * FROM smtp_settings WHERE id = 1');
  const db = rows[0] || {};
  return {
    host: db.host || process.env.SMTP_HOST || null,
    port: db.port || Number(process.env.SMTP_PORT) || 587,
    secure: db.host ? !!db.secure : process.env.SMTP_SECURE === 'true',
    user: db.username || process.env.SMTP_USER || undefined,
    pass: db.password || process.env.SMTP_PASS || undefined,
    fromName: db.from_name || 'TreeTime',
    fromEmail: db.from_email || 'no-reply@tree-tech-system.com',
  };
}

// A connected Google mailbox (owner panel -> מייל -> "התחבר עם Google", see
// googleOAuth.js + routes/ownerEmail.js) always wins over the manual SMTP
// settings above when one is marked default -- it's the "nicer" path the
// owner explicitly opted into, so it should actually take over sending.
async function getGoogleDefaultAccount() {
  const { rows } = await pool.query(
    `SELECT email, display_name, refresh_token FROM google_email_accounts WHERE is_default = TRUE LIMIT 1`
  );
  return rows[0] || null;
}

async function resolveSender() {
  const google = await getGoogleDefaultAccount();
  if (google) {
    return { type: 'google', email: google.email, displayName: google.display_name || 'TreeTime', refreshToken: google.refresh_token };
  }
  return { type: 'smtp', ...(await getSmtpConfig()) };
}

function senderConfigured(sender) {
  return sender.type === 'google' || !!sender.host;
}

function senderEmailOf(sender) {
  return sender.type === 'google' ? sender.email : sender.fromEmail;
}

function fromHeader(sender) {
  return sender.type === 'google' ? `"${sender.displayName}" <${sender.email}>` : `"${sender.fromName}" <${sender.fromEmail}>`;
}

function buildTransporter(sender) {
  if (sender.type === 'google') {
    // nodemailer's OAuth2 support fetches (and refreshes) a short-lived access
    // token itself on every send using these credentials -- no token/expiry
    // bookkeeping needed on our side, see migration 030's comment.
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: sender.email,
        clientId: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        refreshToken: sender.refreshToken,
      },
    });
  }
  return nodemailer.createTransport({
    host: sender.host,
    port: sender.port,
    secure: sender.secure,
    auth: sender.user ? { user: sender.user, pass: sender.pass } : undefined,
  });
}

// Fire-and-forget audit trail of every send attempt (email_send_log, migration
// 031) -- never awaited by callers, a logging hiccup must never affect an
// actual email send.
function logEmail({ to, subject, category, senderEmail, status, error }) {
  pool
    .query(
      `INSERT INTO email_send_log (to_email, subject, category, sender, status, error) VALUES ($1,$2,$3,$4,$5,$6)`,
      [to, subject || null, category || 'other', senderEmail || null, status, error || null]
    )
    .catch(() => {});
}

// Never throws -- a mail failure must never break the action that triggered it
// (e.g. signup succeeding even if the welcome email fails to send).
async function sendMail({ to, subject, html, text, category = 'other' }) {
  const sender = await resolveSender();
  if (!senderConfigured(sender)) {
    console.log(`[mailer] no sender configured, skipping email to ${to}: ${subject}`);
    logEmail({ to, subject, category, senderEmail: null, status: 'skipped' });
    return;
  }
  try {
    await buildTransporter(sender).sendMail({ from: fromHeader(sender), replyTo: SUPPORT_EMAIL, to, subject, html, text });
    logEmail({ to, subject, category, senderEmail: senderEmailOf(sender), status: 'sent' });
  } catch (err) {
    console.error(`[mailer] failed to send to ${to}:`, err.message);
    logEmail({ to, subject, category, senderEmail: senderEmailOf(sender), status: 'failed', error: err.message });
  }
}

// Unlike sendMail(), this DOES throw -- it backs the "send test email" button in the
// owner panel, where silently swallowing a bad host/port/credential would defeat the point.
async function sendTestEmail(to) {
  const sender = await resolveSender();
  if (!senderConfigured(sender)) throw new Error('לא הוגדר שרת SMTP או חשבון Google מחובר עדיין');
  const subject = 'מייל בדיקה מ-TreeTime';
  try {
    await buildTransporter(sender).sendMail({
      from: fromHeader(sender),
      replyTo: SUPPORT_EMAIL,
      to,
      subject,
      html: renderEmail('מייל בדיקה', 'אם זה הגיע אליך — הגדרות השליחה תקינות ועובדות.'),
    });
    logEmail({ to, subject, category: 'test', senderEmail: senderEmailOf(sender), status: 'sent' });
  } catch (err) {
    logEmail({ to, subject, category: 'test', senderEmail: senderEmailOf(sender), status: 'failed', error: err.message });
    throw err;
  }
}

// Shared branded wrapper so every email type (reset, welcome, notifications...) looks
// like the same product instead of each route hand-rolling its own HTML.
function renderEmail(title, bodyHtml) {
  return `<!DOCTYPE html>
<html dir="rtl" lang="he"><body style="margin:0;padding:0;background:#FAF9F4;font-family:Arial,Helvetica,sans-serif;">
  <div style="max-width:480px;margin:0 auto;padding:32px 16px;">
    <div style="background:#FFFFFF;border:1px solid #E4E1D6;border-radius:14px;padding:28px 26px;">
      <div style="font-size:15px;font-weight:800;color:#2F6F4E;margin-bottom:18px;">TreeTime</div>
      <div style="font-size:17px;font-weight:700;color:#10241C;margin-bottom:12px;">${title}</div>
      <div style="font-size:14px;line-height:1.7;color:#1D3327;">${bodyHtml}</div>
    </div>
    <div style="text-align:center;font-size:11.5px;color:#6B7568;margin-top:16px;">
      אימייל זה נשלח אוטומטית ממערכת TreeTime. לתמיכה: ${SUPPORT_EMAIL}
    </div>
  </div>
</body></html>`;
}

function buttonHtml(url, label) {
  return `<div style="text-align:center;margin:22px 0;">
    <a href="${url}" style="display:inline-block;background:#2F6F4E;color:#fff;text-decoration:none;
      font-weight:700;font-size:14px;padding:12px 28px;border-radius:10px;">${label}</a>
  </div>`;
}

async function sendAdminEmails(companyId, subject, bodyHtml, category = 'notification') {
  const { rows } = await pool.query(
    `SELECT email FROM employees WHERE company_id = $1 AND role = 'admin' AND active = TRUE`,
    [companyId]
  );
  await Promise.all(rows.map((r) => sendMail({ to: r.email, subject, html: renderEmail(subject, bodyHtml), category })));
}

async function sendEmployeeEmailById(employeeId, subject, bodyHtml, category = 'notification') {
  const { rows } = await pool.query('SELECT email FROM employees WHERE id = $1 AND active = TRUE', [employeeId]);
  if (!rows[0]) return;
  await sendMail({ to: rows[0].email, subject, html: renderEmail(subject, bodyHtml), category });
}

module.exports = {
  sendMail, sendTestEmail, renderEmail, buttonHtml, sendAdminEmails, sendEmployeeEmailById,
  getSmtpConfig, getGoogleDefaultAccount, SUPPORT_EMAIL,
};
