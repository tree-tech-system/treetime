# TreeTime

פלטפורמת SaaS לניהול זמני עבודה (time tracking), רב-דיירית (multi-tenant), שנבנתה עבור **Tree Tech** ונמכרת ללקוחות שלה. דומיין ייצור: `https://treetime.tree-tech-system.com`.

מסמך זה הוא הקשר קבוע לכל סשן עתידי שעובד על הריפו הזה. הוא מתעדכן — אם משהו כאן סותר את המצב האמיתי בקוד, בקוד יש להאמין.

## היררכיית הרשאות (3 רמות — הבסיס לכל דבר במערכת)

```
Super Admin (Tree Tech) — טבלת owners, JWT type:'owner', פאנל נפרד תחת /owner/
    ↓
Admin — עובד עם role='admin' בטבלת employees, מנהל חברה אחת בלבד
    ↓
Employee — עובד עם role='employee', רואה/מדווח רק על עצמו
```

תפקיד `manager` **הוסר לגמרי**. אם רואים `requireRole('manager','admin')` בקוד — זה שריד מת, לא ניתן להקצאה משום ממשק או API. אל תחזירו אותו בלי בקשה מפורשת.

## ארכיטקטורה

**Backend** (`src/`) — Express + PostgreSQL (`pg`), JWT (`jsonwebtoken`) + `bcrypt`, ולידציה עם `express-validator`, העלאות עם `multer`, תיעוד עם `swagger-jsdoc`/`swagger-ui-express`. אין test suite אוטומטי — כל אימות היסטורי נעשה ידנית ב-curl.

```
src/
  server.js              נקודת כניסה, רישום כל ה-routes
  db/pool.js              pg connection pool
  db/migrations/          002–020, רצות לפי סדר המספור (020+ רצות אוטומטית ב-deploy, ראו "Deploy מ-Git")
  db/schema.sql            דאמפ סכמה מלא
  middleware/auth.js       authenticate, requireRole, requireScope, requireOwner
  lib/notify.js            fan-out התראות (notifyOwners/notifyAdmins/notifyEmployee)
  lib/webhookDispatcher.js
  lib/slug.js
  routes/                  קובץ אחד למשאב — ראו מפה למטה
  docs/                    openapiSpec.js, guide.html
scripts/                  backfill_slugs.js, seed_demo.js
```

**Frontend** (שורש הריפו) — **אין build step, אין framework**. כל עמוד הוא HTML מונוליתי עם `<style>`/`<script>` inline שמדבר עם ה-API דרך `fetch`: `index.html` (אדמין+עובד, ~4000 שורות), `owner/index.html` (סופר-אדמין), `signup/`, `intake/`, `join/`, `admin-invite/` (כל אחד עמוד ציבורי חד-פעמי).

**Multi-tenancy:** כל חברה מקבלת slug (`/c/<slug>/<page>`), מנותב גם ב-nginx (`try_files` ל-SPA fallback) וגם client-side (`history.pushState`/`popstate`).

**סמנטיקה מבלבלת:** הטבלה/route `projects` = **לקוחות (clients)**, לא "פרויקטים".

## הסביבה בפועל (production)

VPS של Hostinger, hostname `srv1901012.hstgr.cloud`, Ubuntu 24.04, Node.js v20, PostgreSQL 16.
- Backend רץ מ-`/opt/treetime-api` כ-systemd service `treetime-api` על פורט 3001 מקומי; nginx עושה proxy_pass תחת `/api/`. **אחרי כל שינוי בקוד ה-backend על השרת: `sudo systemctl restart treetime-api`.**
- Frontend מוגש מ-`/var/www/html`.
- DB: `treetime`, role אפליקציה `treetime_app`. גישת superuser בשרת: `sudo -u postgres psql treetime`.

## ⚠️ מלכודות ידועות — קרו בפועל, גרמו לקריסת production

1. **GRANT אחרי מיגרציה — עכשיו אוטומטי, בתנאי שבוצע bootstrap חד-פעמי.** מיגרציה חדשה שרצה עם `sudo -u postgres psql -f migration.sql` יוצרת טבלה בבעלות `postgres`; `treetime_app` לא מקבל גישה אוטומטית → 502 מיידי. קרה בעבר עם `admin_signup_links` ו-`tasks`. **מ-17.8.2026 יש לזה פתרון קבוע:** `deploy-backend.yml` מריץ כל מיגרציה חדשה (לפי `schema_migrations`, ראו migration 020) ומיד אחריה `GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO treetime_app;` (סכימה שלמה, לא טבלה בודדת — פותר את זה סופית). **זה פעיל רק אחרי בוצע bootstrap חד-פעמי** (ראו "Deploy מ-Git" למטה) — אם הוא עוד לא בוצע, עדיין צריך GRANT ידני כמו קודם:
   ```sql
   GRANT ALL PRIVILEGES ON TABLE <table_name> TO treetime_app;
   GRANT USAGE, SELECT ON SEQUENCE <table_name>_id_seq TO treetime_app;
   ```

2. **Cache-Control על HTML.** לכל location block שמגיש HTML ב-nginx צריך `add_header Cache-Control "no-cache, must-revalidate";`, אחרת דפדפנים תוקעים גרסאות ישנות של לוגו/עמודים.

3. **אין syntax check אוטומטי.** אחרי כל עריכה:
   - Backend: `node -c src/routes/<file>.js`
   - Frontend: לחלץ את תוכן ה-`<script>` הראשי לקובץ `.js` זמני ולהריץ `node -c` עליו.

## Deploy מ-Git

מ-17.8.2026 **גם frontend וגם backend נפרסים אוטומטית** על push ל-`main`. `git push` (או merge PR) הוא כל מה שצריך — אין יותר צורך ב-SSH ידני לעדכון קוד.

- **`.github/workflows/deploy.yml`** (frontend) — על כל push ל-`main`: SSH לשרת, `git fetch && git reset --hard origin/main` בתוך `$DEPLOY_PATH` (`/var/www/html`), ואז מנקה מהתיקייה הזו כל דבר שהוא לא באמת frontend (`index.html`, `admin-invite/`, `intake/`, `join/`, `owner/`, `signup/`, `.well-known/`) — כי הריפו הוא מונו-רפו ומ-17.8.2026 הוא מכיל גם את ה-backend, וקוד backend **לא** אמור לשבת בתיקייה שמוגשת פומבית ע"י nginx.
- **`.github/workflows/deploy-backend.yml`** (חדש, 17.8.2026) — trigger רק על שינוי בנתיבי `src/**`, `scripts/**`, `package*.json`. SSH ל-`/opt/treetime-api`, `git reset --hard origin/main`, `npm install`, ואז מיגרציות (ראו bootstrap למטה), ואז `systemctl restart treetime-api` + בדיקת health.
- **`.github/workflows/ci.yml`** (חדש, 17.8.2026) — על כל PR/push ל-`main`: `node -c` על כל קובצי ה-backend + `npm ci`. מאוטומט את בדיקת ה-syntax שהייתה ידנית.
- שלושתם משתמשים באותם secrets קיימים: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `DEPLOY_PATH` (רק frontend).
- ⚠️ **git הוא מקור האמת לכל הקוד, לא הקבצים על השרת.** עריכה ישירה על השרת (גם `/var/www/html` וגם `/opt/treetime-api`) שלא הגיעה ל-git **תימחק/תידרס** ב-push הבא ל-main.

### ⚠️ Bootstrap חד-פעמי נדרש להפעלת אוטומציית המיגרציות

`deploy-backend.yml` מריץ מיגרציות חדשות אוטומטית **רק** אם טבלת `schema_migrations` כבר קיימת ב-DB. עד שהיא לא קיימת, השלב הזה עושה no-op בטוח (רואים בלוג של ה-Action: "schema_migrations table not found yet"), ומיגרציות חדשות עדיין דורשות הרצה ידנית + GRANT כמו קודם. כדי להפעיל את האוטומציה **פעם אחת ולתמיד**, להריץ בשרת (`sudo -u postgres psql treetime`):

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
  filename TEXT PRIMARY KEY,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO schema_migrations (filename) VALUES
  ('002_multi_tenant.sql'), ('003_freelancer_model.sql'), ('004_activity_log.sql'),
  ('005_company_slug.sql'), ('006_employee_public_id.sql'), ('007_employee_extra_fields.sql'),
  ('008_company_business_fields.sql'), ('009_client_custom_fields.sql'), ('010_client_payment_method.sql'),
  ('011_client_intake_links.sql'), ('012_notification_settings.sql'), ('013_guides.sql'),
  ('014_employee_custom_fields_and_intake.sql'), ('015_platform_branding.sql'), ('016_system_changelog.sql'),
  ('017_notifications.sql'), ('018_admin_signup_links.sql'), ('019_tasks.sql'), ('020_schema_migrations.sql')
ON CONFLICT DO NOTHING;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO treetime_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO treetime_app;
```

זה מסמן את 002–020 כ"כבר הופעלו" (כי הם כבר רצו ידנית בעבר) כדי שהריצה האוטומטית הבאה לא תנסה להריץ אותם שוב. **מיגרציה 021 ואילך יופעלו אוטומטית**, כולל GRANT, בפעם הבאה שקובץ מיגרציה נכנס ל-`main`.

## מפת Routes (backend)

| קובץ | תפקיד |
|------|-------|
| `auth.js` | התחברות עובד/אדמין |
| `employees.js` | CRUD עובדים; מסנן שדות לפי role (ראו "דפוס פרטיות" למטה) |
| `projects.js` | CRUD **לקוחות** |
| `timeEntries.js` | שעונים/דיווחי זמן |
| `tasks.js` | משימות — קישור ללקוח/עובד, דדליין, סטטוס |
| `apiKeys.js`, `webhooks.js` | אינטגרציות חיצוניות |
| `reports.js` | דוחות/דשבורד |
| `tickets.js` | פניות תמיכה (צד לקוח) |
| `editRequests.js` | בקשות עריכה לדיווח זמן |
| `signup.js` | הרשמה עצמית פומבית לאדמין חדש |
| `clientFields.js` / `clientIntake.js` | שדות מותאמים ללקוח + לינק עצמאי |
| `employeeFields.js` / `employeeIntake.js` | שדות מותאמים לעובד + לינק עצמאי |
| `notificationSettings.js` | הגדרות מי מקבל איזו התראה |
| `guides.js` / `ownerGuides.js` | סרטוני הדרכה |
| `branding.js` | לוגו/מיתוג (מנוהל ע"י סופר-אדמין) |
| `notifications.js` / `ownerNotifications.js` | פעמון התראות |
| `ownerChangelog.js` | יומן שינויים (רק סופר-אדמין, בלי delete) |
| `ownerAuth.js` / `ownerCompanies.js` / `ownerTickets.js` | פאנל סופר-אדמין: התחברות, ניהול חברות + impersonate, תמיכה |
| `adminSignupLinks.js` | לינק חד-פעמי מסופר-אדמין לפתיחת חברה חדשה |

## מוסכמות עבודה

1. **יומן שינויים חובה.** אחרי כל שינוי אמיתי — רשומה ב-`system_changelog` דרך `POST /api/owner/changelog` (`{version, category, title, description}`, description מפורט בעברית: שורש הבעיה, התיקון, איך אומת). אין אפשרות מחיקה. מספור נכון לאוגוסט 2026: הגענו ל-**1.37**, הבא **1.38**.
2. **סינון שדות לפי role, לא open-gate גורף.** כשעובד רגיל צריך גישה ל-endpoint שהיה admin-only — הפתרון הוא סט שדות מצומצם (ראו `EMPLOYEE_LIST_FIELDS_BASIC` ב-`employees.js`), לא לפתוח את כל השדות לכולם.
3. **שינויי הרשאה תמיד ב-frontend + backend ביחד**, אף פעם רק באחד — אחרת ניתן לעקוף דרך קריאת API ישירה.
4. **בדיקות end-to-end ב-curl**, כולל impersonation דרך `POST /api/owner/companies/:id/impersonate` (מקבל `employee_id` אופציונלי כדי להיכנס כעובד ספציפי בלי לדעת סיסמה). לנקות נתוני בדיקה בסוף.
5. **לא להוסיף אבסטרקציות/ולידציות/הרשאות שלא התבקשו.** לבנות בדיוק את מה שביקשו, לא לנחש דרישות עתידיות.
6. **תגובות למשתמש בעברית**, ישירות: מה השורש, מה התיקון, איך אומת.

## גישה וסודות

**שום סוד לא נמצא בקובץ הזה או בריפו בכוונה תחילה** — לא סיסמאות, לא JWT secret, לא connection string. `.env` בשרת (`/opt/treetime-api/.env`) מכיל `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `NODE_ENV` ומודר דרך `.gitignore`. `uploads/` (קבצים שהעלו משתמשים בפועל) גם מודר בכוונה — זה דאטה של לקוחות, לא קוד, והריפו **ציבורי**.

Super-admin: `support@tree-tech-system.com`. סיסמאות (כל הרמות) נמסרות/מתאפסות רק בצ'אט ישירות מהמשתמש, לעולם לא נשמרות בקובץ.

## TODO פתוח (ראו גם Task list של הסשן)

1. ✅ ~~backend בגיט~~ — הושלם, PR #3.
2. ✅ ~~Deploy workflow ל-backend~~ — הושלם, PR #5.
3. אוטומציה למיגרציות + GRANT — **הקוד קיים ומופעל** (PR #6, `deploy-backend.yml` + migration 020), אבל מחכה ל-bootstrap חד-פעמי בשרת (ראו "Deploy מ-Git" למעלה — עותק-הדבק אחד ב-`psql`) לפני שהוא באמת פעיל.
4. גישת API ייעודית לבדיקות end-to-end ולרישום changelog אוטומטי. **נבדק — אין כרגע מנגנון**: `requireOwner` (ב-`middleware/auth.js`) מקבל רק JWT אמיתי מסוג `owner`, ו-API keys (`api_keys` table) הם ברמת חברה בלבד (`requireRole`/`requireScope`, לא `requireOwner`). להוסיף ל-API key גישת owner זו הרחבת הרשאות אמיתית שלא התבקשה — לא נעשה בלי אישור מפורש. אופציות לבחירה: (א) המשתמש עושה login דרך `/api/owner/auth/login` ומעביר טוקן חד-פעמי בכל פעם, (ב) endpoint/scope ייעודי חדש למפתחות owner-level, מוגבל לפעולות ספציפיות (כמו POST changelog בלבד) — דורש עיצוב וא ישור מפורש לפני מימוש.
5. ✅ ~~Test suite / CI~~ — הושלם, PR #5 (`ci.yml`): `node -c` + `npm ci` על כל PR.
6. החלטה: לנקות את חברות הדמו (IDs `1`, `5`, `7` בטבלת `companies`) לפני production אמיתי, או להשאיר? **לא טופל — משנה נתוני production, ממתין להחלטה מפורשת.**
