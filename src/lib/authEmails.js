const { sendMail, renderEmail, buttonHtml } = require('./mailer');
const { createAuthToken } = require('./authTokens');

const APP_URL = process.env.APP_URL || 'https://treetime.tree-tech-system.com';
const CONFIRM_TOKEN_TTL_MS = 48 * 60 * 60 * 1000; // 48 hours
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

// One combined email covers both "you signed up" and "please confirm your
// email" -- two separate emails for the same event would just be noise.
async function sendWelcomeEmail(employee, companyName) {
  const token = await createAuthToken(employee.id, 'email_confirm', CONFIRM_TOKEN_TTL_MS);
  const confirmUrl = `${APP_URL}/confirm-email/?token=${token}`;
  const body = `שלום ${employee.full_name},<br><br>
    החשבון שלך ב-TreeTime${companyName ? ` עבור <b>${companyName}</b>` : ''} נוצר בהצלחה.<br>
    לחצו לאישור כתובת האימייל שלכם:
    ${buttonHtml(confirmUrl, 'אישור החשבון')}
    <span style="color:#6B7568;font-size:12.5px;">הקישור בתוקף ל-48 שעות.</span>`;
  await sendMail({ to: employee.email, subject: 'ברוכים הבאים ל-TreeTime — אישור חשבון', html: renderEmail('ברוכים הבאים ל-TreeTime', body) });
}

async function sendPasswordResetEmail(employee) {
  const token = await createAuthToken(employee.id, 'password_reset', RESET_TOKEN_TTL_MS);
  const resetUrl = `${APP_URL}/reset-password/?token=${token}`;
  const body = `קיבלנו בקשה לאיפוס הסיסמה של החשבון המשויך לכתובת ${employee.email}.<br><br>
    ${buttonHtml(resetUrl, 'איפוס סיסמה')}
    <span style="color:#6B7568;font-size:12.5px;">הקישור בתוקף לשעה. אם לא ביקשתם איפוס סיסמה, אפשר להתעלם מהמייל הזה.</span>`;
  await sendMail({ to: employee.email, subject: 'איפוס סיסמה ב-TreeTime', html: renderEmail('איפוס סיסמה', body) });
}

async function sendPasswordChangedEmail(employee) {
  const body = `הסיסמה של החשבון שלך (${employee.email}) עודכנה כרגע.<br><br>
    <span style="color:#6B7568;font-size:12.5px;">אם לא ביצעת את השינוי הזה, צרו איתנו קשר מיד.</span>`;
  await sendMail({ to: employee.email, subject: 'הסיסמה שלך ב-TreeTime עודכנה', html: renderEmail('הסיסמה עודכנה', body) });
}

module.exports = { sendWelcomeEmail, sendPasswordResetEmail, sendPasswordChangedEmail };
