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
  db/migrations/          002–019, רצות לפי סדר המספור
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

1. **GRANT אחרי מיגרציה.** מיגרציה חדשה שרצה עם `sudo -u postgres psql -f migration.sql` יוצרת טבלה בבעלות `postgres`. `treetime_app` **לא** מקבל גישה אוטומטית → 502 מיידי בכל endpoint שנוגע בטבלה. חובה מיד אחרי כל מיגרציה:
   ```sql
   GRANT ALL PRIVILEGES ON TABLE <table_name> TO treetime_app;
   GRANT USAGE, SELECT ON SEQUENCE <table_name>_id_seq TO treetime_app;
   ```
   קרה עם `admin_signup_links` ו-`tasks`. עדיין רשומות owner=`postgres` בפועל — לא בעיה כל עוד ה-GRANT בוצע.

2. **Cache-Control על HTML.** לכל location block שמגיש HTML ב-nginx צריך `add_header Cache-Control "no-cache, must-revalidate";`, אחרת דפדפנים תוקעים גרסאות ישנות של לוגו/עמודים.

3. **אין syntax check אוטומטי.** אחרי כל עריכה:
   - Backend: `node -c src/routes/<file>.js`
   - Frontend: לחלץ את תוכן ה-`<script>` הראשי לקובץ `.js` זמני ולהריץ `node -c` עליו.

## Deploy מ-Git

- **`.github/workflows/deploy.yml`** — על כל push ל-`main`, SSH לשרת ומריץ `git fetch && git reset --hard origin/main` בתוך `$DEPLOY_PATH` (`/var/www/html`, **רק frontend**). Secrets: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `DEPLOY_PATH`.
- ⚠️ **מ-16.8.2026 git הוא מקור האמת לפרונט-אנד, לא הקבצים על השרת.** עריכה ישירה על השרת בתיקיית `/var/www/html` שלא הגיעה ל-git **תימחק בשקט** ב-push הבא ל-main.
- **ה-backend עדיין בלי deploy workflow.** שינוי שנכנס ל-`main` כאן לא משפיע על production עד שמישהו עם גישת שרת: (1) מריץ מיגרציות חדשות + GRANT, (2) מעדכן את `/opt/treetime-api` בשרת (`git pull` / דומה), (3) `sudo systemctl restart treetime-api`. להקים workflow מקביל לזה של הפרונט זו משימה פתוחה.

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
2. Deploy workflow ל-backend (SSH + restart על push ל-main).
3. אוטומציה למיגרציות + GRANT כחלק מה-deploy, כדי שהמלכודת ב"מלכודות ידועות" #1 לא תחזור.
4. גישת API ייעודית (owner token / API key ב-GitHub secret) ל-e2e testing ולרישום changelog אוטומטי, בלי לבקש credentials מהמשתמש בכל פעם.
5. Test suite / CI — כרגע הכל curl ידני.
6. החלטה: לנקות את חברות הדמו (IDs `1`, `5`, `7` בטבלת `companies`) לפני production אמיתי, או להשאיר?
