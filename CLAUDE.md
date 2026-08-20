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
  db/migrations/          002–031, רצות לפי סדר המספור (020+ רצות אוטומטית ב-deploy, ראו "Deploy מ-Git")
  db/schema.sql            דאמפ סכמה מלא (לא מתעדכן אוטומטית — לא הוזן מחדש מאז ה-import הראשוני, אל תסמכו עליו כמצב עדכני)
  middleware/auth.js       authenticate, requireRole, requireScope, requireOwner
  lib/searchEngine.js     allowlist-based generic search מעל 6 טבלאות — ראו "חיפוש כללי" למטה
  lib/notify.js            fan-out התראות **פנימיות באפליקציה בלבד** (notifyOwners/notifyAdmins/notifyEmployee) — לא מייל
  lib/mailer.js            שליחת מייל בפועל (Google OAuth2 או SMTP דרך nodemailer, יומן שליחה) — ראו "אינטגרציית מייל" למטה
  lib/googleOAuth.js       עטיפת REST גולמית סביב OAuth2 של Google (ללא תלות npm חדשה) — ראו "אינטגרציית מייל" למטה
  lib/authTokens.js        טוקנים חד-פעמיים (איפוס סיסמה / אישור אימייל)
  lib/authEmails.js        תוכן המיילים הטרנזקציוניים (welcome/reset/changed), משתמש ב-mailer+authTokens
  lib/webhookDispatcher.js
  lib/slug.js
  routes/                  קובץ אחד למשאב — ראו מפה למטה
  docs/                    openapiSpec.js, guide.html
scripts/                  backfill_slugs.js, seed_demo.js
```

**Frontend** (שורש הריפו) — **אין build step, אין framework**. כל עמוד הוא HTML מונוליתי עם `<style>`/`<script>` inline שמדבר עם ה-API דרך `fetch`: `index.html` (אדמין+עובד, ~4000 שורות), `owner/index.html` (סופר-אדמין), `signup/`, `intake/`, `join/`, `admin-invite/`, `reset-password/`, `confirm-email/` (כל אחד עמוד ציבורי חד-פעמי). **הבדל חשוב:** `signup/`/`intake/`/`join/`/`admin-invite/` מזהים את הטוקן דרך ה-path (`/join/<token>`, דורש nginx שמטפל בזה) — `reset-password/`/`confirm-email/` **מכוונים**, דרך query string (`?token=`), כדי לא לדרוש שום שינוי ב-nginx כשנוספה התיקייה (ראו "אינטגרציית מייל" למטה).

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

- **`.github/workflows/deploy.yml`** (frontend) — על כל push ל-`main`: SSH לשרת, `git fetch && git reset --hard origin/main` בתוך `$DEPLOY_PATH` (`/var/www/html`), ואז מנקה מהתיקייה הזו כל דבר שהוא לא באמת frontend (`index.html`, `admin-invite/`, `intake/`, `join/`, `owner/`, `signup/`, `reset-password/`, `confirm-email/`, `.well-known/`) — כי הריפו הוא מונו-רפו ומ-17.8.2026 הוא מכיל גם את ה-backend, וקוד backend **לא** אמור לשבת בתיקייה שמוגשת פומבית ע"י nginx. **תיקייה ציבורית חדשה = חייבים להוסיף אותה לרשימה הזו, אחרת ה-deploy הבא ימחק אותה.**
- **`.github/workflows/deploy-backend.yml`** (חדש, 17.8.2026) — trigger רק על שינוי בנתיבי `src/**`, `scripts/**`, `package*.json`. SSH ל-`/opt/treetime-api`, `git reset --hard origin/main`, `npm install`, ואז מיגרציות (ראו bootstrap למטה), ואז `systemctl restart treetime-api` + בדיקת health.
- **`.github/workflows/ci.yml`** (חדש, 17.8.2026) — על כל PR/push ל-`main`: `node -c` על כל קובצי ה-backend + `npm ci`. מאוטומט את בדיקת ה-syntax שהייתה ידנית.
- שלושתם משתמשים באותם secrets קיימים: `SSH_HOST`, `SSH_USER`, `SSH_PRIVATE_KEY`, `DEPLOY_PATH` (רק frontend).
- ⚠️ **git הוא מקור האמת לכל הקוד, לא הקבצים על השרת.** עריכה ישירה על השרת (גם `/var/www/html` וגם `/opt/treetime-api`) שלא הגיעה ל-git **תימחק/תידרס** ב-push הבא ל-main.

### ✅ Bootstrap המיגרציות בוצע (17.8.2026)

`deploy-backend.yml` מריץ מיגרציות חדשות אוטומטית ברגע שטבלת `schema_migrations` קיימת ב-DB. ה-bootstrap החד-פעמי **כבר בוצע** — הטבלה קיימת, 002–020 מסומנות כ"כבר הופעלו", וה-GRANT הכללי רץ. **מיגרציה 021 ואילך תרוץ לגמרי לבד** (כולל GRANT) בפעם הבאה שקובץ מיגרציה חדש נכנס ל-`main` — אין יותר צורך בשום פעולה ידנית סביב מיגרציות.

לצורך תיעוד, זה ה-SQL שהופעל אז (**אין צורך להריץ אותו שוב**):

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

## מפת Routes (backend)

| קובץ | תפקיד |
|------|-------|
| `auth.js` | התחברות עובד/אדמין; גם איפוס סיסמה, אישור אימייל (ראו "אינטגרציית מייל" למטה) |
| `employees.js` | CRUD עובדים; מסנן שדות לפי role (ראו "דפוס פרטיות" למטה) |
| `projects.js` | CRUD **לקוחות** |
| `timeEntries.js` | שעונים/דיווחי זמן |
| `timerSettings.js` | מדיניות שעונים per-company — כרגע רק `max_concurrent_timers` (ראו למטה) |
| `tasks.js` | משימות — קישור ללקוח/עובד, דדליין, סטטוס |
| `apiKeys.js`, `webhooks.js` | אינטגרציות חיצוניות (מפתחות per-company, `X-API-Key` header — לא `Authorization: Bearer`). ניהול UI: `index.html` → הגדרות → "אינטגרציות (API)", admin בלבד (18.8.2026) — לפני זה ה-endpoints היו קיימים אבל בלי שום מסך, רק curl |
| `reports.js` | דוחות/דשבורד |
| `tickets.js` | פניות תמיכה (צד לקוח) |
| `editRequests.js` | בקשות עריכה לדיווח זמן |
| `signup.js` | הרשמה עצמית פומבית לאדמין חדש |
| `clientFields.js` / `clientIntake.js` | שדות מותאמים ללקוח + לינק עצמאי |
| `employeeFields.js` / `employeeIntake.js` | שדות מותאמים לעובד + לינק עצמאי |
| `notificationSettings.js` | הגדרות מי מקבל איזו התראה, כולל ערוץ מייל (ראו "אינטגרציית מייל" למטה) |
| `guides.js` / `ownerGuides.js` | סרטוני הדרכה, כולל visibility לפי role (ראו למטה) |
| `branding.js` | לוגו/מיתוג (מנוהל ע"י סופר-אדמין) |
| `notifications.js` / `ownerNotifications.js` | פעמון התראות |
| `ownerChangelog.js` | יומן שינויים (רק סופר-אדמין, בלי delete) |
| `ownerAuth.js` / `ownerCompanies.js` / `ownerTickets.js` | פאנל סופר-אדמין: התחברות, ניהול חברות + impersonate, תמיכה |
| `adminSignupLinks.js` | לינק חד-פעמי מסופר-אדמין לפתיחת חברה חדשה |
| `ownerApiKeys.js` | מפתחות API ברמת owner, מוגבלים ל-scope ספציפי (ראו "גישת API לאוטומציה" למטה) |
| `ownerEmail.js` | חיבור Google OAuth + הגדרות SMTP + יומן שליחה + broadcast עם בחירת נמענים (ראו "אינטגרציית מייל" למעלה) |
| `dashboardWidgets.js` | דשבורד מותאם אישית לאדמין — KPI + widgets מסוג רשימה (ראו "דשבורד מותאם אישית" למטה) |
| `search.js` | חיפוש כללי לפי שדה/אופרטור/ערך על פני 6 טבלאות, לאינטגרציות חיצוניות (Make) — ראו "חיפוש כללי" למטה |

### דשבורד מותאם אישית לאדמין (17.8.2026)

אדמין בכל חברה יכול לבנות לעצמו דשבורד עם שני סוגי widgets, בעמוד "דשבורד ראשי" ב-`index.html` (לא בפאנל ה-owner):

- **KPI — בונה חופשי, לא רשימה סגורה.** אדמין בוחר מקור נתונים (`time_entries`/`projects`/`employees`/`tasks`) + סוג צבירה (`sum`/`avg`/`count`/`min`/`max`) + שדה + סינון, ורואה תוצאה חיה לפני שמירה (`POST /api/dashboard-widgets/kpi/preview`).
  - **מנגנון הבטיחות:** `src/lib/kpiEngine.js` — allowlist קשיח של טבלאות/שדות/פילטרים מותרים לכל מקור. שום מחרוזת מה-request לא הופכת ל-SQL גולמי; רק ל-`$N` params. `company_id = $1` תמיד מוזרק קשיח בקוד, **לעולם לא** דרך ה-config של האדמין — כלומר גם "בונה חופשי" לא יכול לחצות בין חברות.
  - הרחבת מקור/שדה/פילטר חדש = עריכת ה-allowlist ב-`kpiEngine.js` בלבד, לא נגיעה ב-routes.
- **רשימה — מרחיבה מסכים קיימים, לא טבלה חדשה.** בזמן רינדור, ה-widget קורא ל-**אותם** endpoints קיימים (`/api/time-entries`, `/api/tasks`) עם אותם query params — אין endpoint חדש לרשימות. לוקוחות (`projects`) עדיין לא מחובר לזה — לא התבקש עדיין. **כפתור הקיצור "שמור תצוגה כ-widget" שישב בעמודי "דיווחי עבודה" ו"משימות" עצמם (שמר את `reportFilters`/`taskFilters` הנוכחיים כ-`config`) הוסר לגמרי ב-20.8.2026** לפי בקשה מפורשת ("תסיר לי את זה... ברמת האדמין והמשתמש" — היה ממילא admin-only בשני המקומות, אז "ברמת המשתמש" היה כבר no-op) — `openSaveListWidgetModal`/`saveListWidget` והמשתנים התומכים נמחקו כקוד מת. **עדיין אפשר להוסיף widget מסוג רשימה** — רק דרך אשף "הוסף דשבורד" (`openAddListWidgetModal`/`saveListWidgetFromWizard`, ראו למטה), שלא נגעו בו; מה שהוסר הוא רק הקיצור-מהיר-מתוך-הסינון-הקיים.
- **מבנה:** דשבורד אחד לחברה, `dashboard_widgets` (migration 022, `type`/`title`/`config` JSONB/`position`), רשימה מסודרת בלבד — אין drag & drop grid (KPI tiles כן מסתדרים ב-flex-wrap ויזואלית, אבל הסדר עדיין נשלט רק ע"י חצי למעלה/למטה, לא גרירה חופשית). `GET /api/dashboard-widgets` מחזיר גם `value` מחושב לכל KPI widget inline (נמנע מ-N+1 קריאות ברינדור).
- **עריכה, לא רק יצירה/מחיקה/סידור.** `PATCH /api/dashboard-widgets/:id` מקבל גם `config` (לא רק `title`/`position`) ומריץ מולו את אותו ולידציה של `evaluateKpi` לפני שמירה. בפרונט: כפתור עפרון על כל KPI widget פותח את אותו מודאל בנייה, ממולא מראש (`applyKpiPrefill`), ושומר ב-PATCH במקום POST.
- **שני מקורות "relation" נוספים (18.8.2026), לא בתוך ה-allowlist הגנרי:** `clients_usage` (שעות שנרשמו ללקוח מול `monthly_quota_hours` שלו, עם סף אחוזים) ו-`employees_activity` (שעות שנרשמו לעובד + דיווח אחרון). אלה דורשים JOIN+GROUP BY ולא מתאימים למנוע הגנרי החד-טבלאי — פונקציות ייעודיות ב-`kpiEngine.js` (`evaluateClientsUsage`/`evaluateEmployeesActivity`), עדיין פרמטריות/מסוננות ל-company_id באותו אופן. גם כ-KPI (ספירה מעל סף) וגם כ-widget מסוג רשימה, דרך `/api/dashboard-widgets/relations/clients-usage` ו-`/relations/employees-activity` (אלה כן endpoints חדשים — לא מתאימים לעקרון "הרחב מסך קיים" כי אין מסך כזה קיים).
- **תאריכים יחסיים:** `date_from`/`date_to` מקבלים גם `"this_month_start"`/`"today"` (מתורגם טרי בכל קריאה ב-`resolveDateValue`), לא רק תאריך מוחלט — כדי ש-widget שמור לא יתיישן ("החודש הנוכחי" תמיד יהיה החודש הנוכחי האמיתי).
- **`status` filter על time_entries:** `open`/`completed`/`all`, override ל-`baseWhere` הדיפולטיבי (`ended_at IS NOT NULL`) — כדי לתמוך גם ב-KPI כמו "שעונים פתוחים כרגע".
- **כפתור "הוסף דשבורד" — אשף דו-שלבי (17.8.2026, index.html).** `openAddWidgetTypeModal()` (שלב 1: בחירת KPI/רשימה בכרטיסים לחיצים, "שלב הבא" חסום עד שנבחר סוג) → `goToWidgetTypeStep2()` מפנה ל-`openAddKpiWidgetModal()` (הבונה הקיים) או ל-`openAddListWidgetModal()` החדש (שלב 2 לרשימה: כותרת, "לאיזה אזור במערכת זה מקושר" = מקור, "אילו עמודות יופיעו" = checkboxes דינמיים לפי מקור מ-`LIST_SOURCE_COLUMNS`, פילטרים מותנים לפי מקור, תצוגה מקדימה, שמירה). אותו מודאל משמש גם לעריכה (`existingWidget` פרמטר, כמו ב-KPI) — `openEditListWidgetModal(id)` מזין PATCH במקום POST. הרינדור של רשימות עבר מפונקציות hardcoded per-source לפונקציה גנרית אחת `renderListWidgetRows(source, rows, selectedColumns)` שמתבססת על `LIST_SOURCE_COLUMNS` ומכבדת את בחירת העמודות של האדמין.
- **שינוי גודל widgets — 3 ידיות מתיחה בכיוונים מפורשים, לא גדלים קבועים (17.8.2026 → 4 גדלים קבועים ב-18.8.2026 → 2 חצי מתיחה ב-18.8.2026 → 3 ידיות כיוון מפורשות, 20.8.2026).** נוסה גם resize חופשי בפיקסלים וגם 4 גדלים קבועים (¼/½/¾/מלא); שניהם הוחלפו בעקבות בקשה מפורשת בחזרה למתיחה חופשית, דרך שתי ידיות בצורת חץ (לא נקודת גרירה בפינה, ולא כפתורי גודל) — רוחב וגובה. **20.8.2026: ידית הרוחב היחידה (עם היפוך כיוון לפי RTL, ניחוש) פוצלה לשתי ידיות מפורשות** לפי בקשה מפורשת ("3 אפשרויות: מתיחה ימינה, מתיחה שמאלה, מתיחה למטה", בהשראת UX של אוריגמי) — `.widget-resize-arrow-w-right` (קצה ימין) ו-`.widget-resize-arrow-w-left` (קצה שמאל), שתיהן `↔`/`cursor:ew-resize`, בנוסף ל-`.widget-resize-arrow-h` (↕, מרכז תחתון, `cursor:ns-resize`) הקיימת למתיחת **גובה** — 3 ידיות סה"כ. הכיוון נגזר מ-`e.currentTarget.classList` בזמן ה-mousedown (לא מ-document direction) ונשמר על ה-state של הגרירה הפעילה: ידית ימין — גרירה ימינה מגדילה; ידית שמאל — גרירה שמאלה מגדילה (סימן הפוך, לא תלוי RTL בכלל יותר — ביטול הניחוש הישן). לחיצה והחזקה על ידית ואז גרירה, אותה פונקציית handler משותפת לשתי ידיות הרוחב (`onWidgetWidthResizeStart/Move/End`), גובה נשאר בפונקציות נפרדות משלו (`onWidgetHeightResizeStart/Move/End`). כל השלוש שומרות ב-`PATCH /api/dashboard-widgets/:id` (`width_px`/`height_px`) בסיום הגרירה, מינימום 200px רוחב / 60px גובה. עמודת `size` מ-הניסיון הקודם (migration 025) נשארה בטבלה כשריד לא מזיק, לא נקראת יותר — כמו `width_px` בזמנו. המרחק בין widgets נשאר אחיד תמיד — `gap:12px` על ה-container הגמיש (`flex-wrap`), לא תלוי בגודל הפרטני של כל widget.
  - **תיקון נלווה, אותו יום: הצד הנגדי לידית שנגררת חייב להישאר מקובע — לא היה כך בהתחלה. עבר גרסה שגויה לפני שהתייצב על הפתרון הנכון.** בדף RTL הזה, שינוי `width` בלבד על פריט flex תמיד משאיר את קצה **ימין** שלו מקובע (נקבע ע"י סכום הרוחב של האחים הקודמים ב-row, לא מושפע מהרוחב העצמי) ומותח את קצה **שמאל**. זה בדיוק ההתנהגות הרצויה לידית **שמאל** — אין צורך בהתערבות. לידית **ימין** זה הפוך ממה שרוצים, אז נדרש `transform:translateX()` מפצה על הקופסה עצמה.
    - **ניסיון ראשון (נכשל, זוהה ע"י המשתמש בפועל בדפדפן):** transform רק על ה-widget שמשתנה גודלו, בלי לגעת בשכנים. **גרם לחפיפה בין widgets** — transform הוא ויזואלי-בלבד ולא משפיע על ה-layout, אז שכן שקודם ל-widget ב-DOM (מימין לו ב-RTL) לא "יודע" לזוז כדי לפנות מקום — flex מזיז אוטומטית רק אחים ש**אחרי** הפריט ב-flow, לעולם לא לפניו. אומת בהתחלה מול VM sandbox עם מודל-יד שהניח בטעות שקצה ימין תמיד קבוע — המודל עצמו היה נכון לגבי ה-widget הבודד, אבל לא בדק בכלל את השכנים, ולכן לא תפס את הבעיה. **המסקנה: בדיקה מול מודל-מדומה של flex לא מספיקה כשהשאלה היא בדיוק "איך flex מתנהג באמת" — נדרש דפדפן אמיתי.**
    - **אבחון מדויק בוצע עם Playwright מול Chromium אמיתי** (לא סימולציה): שורת flex RTL עם כמה widgets, גרירת ידית ימין, ומדידת `getBoundingClientRect()` בפועל על כל ה-widgets לפני/אחרי. זה חשף **שתי בעיות בו-זמנית**, לא רק חפיפה: (1) האח שקודם ל-widget (מימין) לא זז → חפיפה. (2) האח שאחרי ה-widget (משמאל) **כן** זז (בעקבות reflow טבעי מבוסס-width האמיתי) — אבל בהתבסס על המיקום ה"אמיתי" (הלא-מטורנספם) של ה-widget, לא על מיקומו הוויזואלי המקובע — מה שפתח **רווח** (לא חפיפה) בין ה-widget לשכן השמאלי שלו.
    - **הפתרון הנכון, אומת ב-Playwright אמיתי:** ידית ימין מזיזה (`translateX`, אותו delta בדיוק) **את כל שאר ה-widgets באותה שורה, לשני הכיוונים** (`collectRowMates` הולך גם `previousElementSibling` וגם `nextElementSibling`, עוצר כשה-`top` משתנה = יצא מהשורה) — לא רק את מי שלפני. עבור אח שלפני: זה דוחף אותו לפנות מקום (פותר חפיפה). עבור אח שאחרי: זה **מבטל בדיוק** את ה-reflow הטבעי הלא-רצוי שלו (בעיה 2) כי הוא בכלל לא היה אמור לזוז — ה-widget גדל רק לכיוון ימין, הרחק ממנו. `baseTranslate` (per-element, נקרא מ-`el.style.transform` הקיים) עדיין דואג לכך שגרירות חוזרות/מעבר בין ידיות יצטברו נכון בלי קפיצות.
    - **המחיר המוסכם (החלטת מוצר מפורשת מהמשתמש):** אם אין מספיק מקום פנוי בשורה, האחים שנדחפים עלולים לגלוש ויזואלית מעבר לקצה הדשבורד בזמן הגרירה עצמה — זה טרייד-אוף מקובל מול האלטרנטיבה (חפיפה). לא נבנה מנגנון מניעת-גלישה (clamp/wrap-detection) — לא התבקש ומסבך משמעותית.
    - **עדיין live-drag-only, לא נשמר ב-DB** — כמו קודם, רק `width_px` של ה-widget שבאמת השתנה נשמר; אחרי ריענון מלא כל השורה מתיישרת מחדש לפי widths בלבד, וזה בסדר (אותו נימוק כמו קודם — "קיבוע קצה" רלוונטי רק בתוך גרירה פעילה אחת).
    - **אומת עם Playwright אמיתי (לא VM sandbox מדומה) על שורה עם 4 widgets:** גרירת ימין +60px → אח קודם נדחף +60 בדיוק, ה-widget גדל נכון (קצה שמאל קבוע, ימין +60), שני האחים שאחרי **לא זזו כלל** (לא רווח ולא חפיפה), הרווח של 12px נשמר משני הצדדים. גרירה חוזרת של ידית ימין (+30 נוסף, בלי reload) → מצטבר נכון ל-+90 total, בלי קפיצה. ריענון + גרירת ידית שמאל → בדיוק כמו לפני (אח קודם לא מושפע, אחים שאחרי נדחפים ע"י flow טבעי, בלי transform בכלל).
- **שינוי סדר widgets בגרירה בלבד — חצי ↑/↓ הוסרו (18.8.2026, הוסרו 18.8.2026).** לחיצה ארוכה (350ms, `mousedown` בלי תזוזה של יותר מ-6px) על widget (לא על כפתור/select/ידית resize) מתחילה גרירה (`onWidgetDragMouseDown`/`Move`/`Up`) — הזזת העכבר מסדרת מחדש את ה-DOM חי מול שאר ה-widgets (`document.elementFromPoint` + `insertBefore` לפי חצי שה-cursor נמצא בו), שחרור העכבר שומר את הסדר החדש דרך אותו endpoint קיים `POST /dashboard-widgets/reorder`. חצי ↑/↓ (`moveDashboardWidget`) נבנו קודם כדרך נגישה חלופית לצד הגרירה, אבל הוסרו לגמרי בעקבות בקשה מפורשת ("לא רלוונטי יותר") — הגרירה היא המנגנון היחיד לשינוי סדר כעת. `renderOneDashboardWidget` איבד את הפרמטרים `i`/`total` שהיו קיימים רק בשביל חישוב גבולות החצים. הגרירה מוגבלת ל-widgets בפועל בלבד (`data-draggable="1"`, אדמין בלבד) — לא חוצה לפאנלים הקבועים (ראו הבא).
- **שני הפאנלים הקבועים (״מגמת שעות״, ״כל השעונים הפתוחים״) הוזזו לתחתית הדשבורד (18.8.2026).** מוצגים עכשיו **אחרי** אזור ה-widgets של האדמין, עטופים יחד ב-flex row (`flex:1 1 420px` כל אחד) כדי לשבת זה-לצד-זה במסך רחב ולהתקפל למסך צר — "גמישות" ויזואלית-רספונסיבית, אבל בלי size-picker/גרירה משלהם (הם עדיין hardcoded ב-`renderDashboard()`, לא שורות `dashboard_widgets` אמיתיות, אז אין להם `id` לשמור עליו קונפיגורציה — אם ירצו את זה גם עליהם, זו המרה לwidget type אמיתי, לא רק CSS).
- **הכרטיסים הקבועים הישנים של הדשבורד הפכו ל-widgets רגילים (18.8.2026, migration 023 + `src/lib/defaultWidgets.js`).** 4 ה-KPI וה-2 טבלאות/פאנל שהיו hardcoded ב-`renderDashboard()` (סה״כ שעות החודש, שעונים פתוחים, לקוחות מעל מכסה, עובדים פעילים, מכסת שעות ללקוח, פעילות עובדים, דיווחים אחרונים) הוסרו מהקוד הקשיח ומוזרעים כשורות `dashboard_widgets` רגילות — הן ל-19 החברות הקיימות (migration חד-פעמית) והן לכל חברה חדשה (`seedDefaultWidgets()` נקרא מ-`signup.js` ומ-`ownerCompanies.js` POST `/`, בתוך אותה טרנזקציה). ניתנות עכשיו להסרה/סידור/עריכה כמו כל widget אחר. **לא הומר:** גרף "מגמת שעות — 6 שבועות אחרונים" — זה time-series (כמה נקודות נתון), לא scalar KPI ולא רשימה — נשאר hardcoded בכוונה, ממתין ל-widget type שלישי (`trend`/`chart`) שעדיין לא נבנה.
- הרשאות: כתיבה (`POST`/`PATCH`/`DELETE`/`reorder`) = `requireRole('admin')` בלבד. קריאה = כל מי שמחובר לחברה (כרגע רק אדמין רואה בפועל, כי ה-widgets מוצגים רק ב-`renderDashboard()` שהיא admin-only — עדיין לא הורחב ל-`renderPersonalDashboard()` של עובד).

### אינטגרציית מייל (SMTP, 18.8.2026)

המערכת שולחת מייל אמיתי עכשיו — עד עכשיו `lib/notify.js` היה **רק** התראות פנימיות באפליקציה (טבלת `notifications`, פעמון), אין ולא היה שום קשר למייל.

- **תשתית (`src/lib/`):**
  - `mailer.js` — transport של `nodemailer` נבנה מ-env vars (`SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`). **אם `SMTP_HOST` לא מוגדר — לא זורק שגיאה, רק רושם ל-log ומדלג.** ככה כל הפיצ'ר עובד קצה-לקצה (החתימה על הזרימה, ה-DB, הטוקנים) גם בלי ספק SMTP אמיתי מוגדר עדיין. `sendMail()` עצמה **אף פעם לא זורקת** — כל קריאה אליה בקוד היא fire-and-forget עם `.catch(()=>{})`, כדי שכשל בשליחת מייל לעולם לא יפיל את הפעולה שהפעילה אותו (הרשמה מצליחה גם אם מייל הברוכים-הבאים נכשל). `renderEmail()`/`buttonHtml()` — תבנית HTML ממותגת משותפת לכל סוגי המייל. `Reply-To` על **כל** מייל יוצא = `SUPPORT_EMAIL` (ברירת מחדל `support@tree-tech-system.com`) — לא מנגנון contact-form דו-כיווני, רק שאם מישהו לוחץ "השב" זה מגיע לתמיכה.
  - `authTokens.js` — טוקן חד-פעמי גנרי: `createAuthToken(employeeId, purpose, ttlMs)` מייצר טוקן רנדומלי (32 בייט), שומר רק את ה-**hash** שלו ב-`auth_tokens` (migration 026, כמו `password_hash` — דלף DB לבד לא מספיק לניצול). `consumeAuthToken(rawToken, purpose)` — `UPDATE ... RETURNING` אטומי יחיד (בודק+מסמן כמנוצל בפעולה אחת, מונע race condition בין שתי בקשות בו-זמניות עם אותו טוקן).
  - `authEmails.js` — מרכיב את 3 המיילים הטרנזקציוניים בפועל (`sendWelcomeEmail`/`sendPasswordResetEmail`/`sendPasswordChangedEmail`) מעל `mailer.js`+`authTokens.js`.
- **איפוס סיסמה (חדש לגמרי — לא היה קיים).** `POST /api/auth/forgot-password` (עובד/אדמין בלבד, לא owner) — **תמיד** מחזיר תשובה זהה בין אם המייל קיים או לא, כדי שלא ישמש לבדיקת אילו כתובות רשומות. `POST /api/auth/reset-password` — טוקן + סיסמה חדשה, שולח מייל אישור אחרי. עמוד ציבורי `reset-password/` (טוקן ב-query string). קישור "שכחת סיסמה?" במסך ההתחברות של `index.html` (טופס inline, לא modal — כדי לעבוד גם לפני login).
- **אישור חשבון (חדש לגמרי).** לא gate חוסם — עובד יכול להתחבר מיד כרגיל, זה רק תיעוד. מייל "ברוכים הבאים" ואישור חשבון **אוחדו למייל אחד** (לא שני מיילים על אותו אירוע) — כפתור באימייל מוביל ל-`confirm-email/` (query string), קורא ל-`POST /api/auth/confirm-email`, מסמן `employees.email_confirmed_at`. **נשלח מכל 6 המקומות שיוצרים שורת employee:** `auth.js` `/register`, `signup.js`, `ownerCompanies.js`, `adminSignupLinks.js`, `employeeIntake.js`, `employees.js` (הוספת עובד ע"י אדמין). הדגל `email_confirmed_at` נשמר אבל **לא נאכף/מוצג בשום מקום עדיין** — אם ירצו UI/gate על זה, זו תוספת נפרדת.
- **שינוי סיסמה.** ה-endpoint הקיים `/api/auth/change-password` (ולא רק `reset-password` החדש) שולח עכשיו מייל אבטחה "הסיסמה שלך עודכנה" בסיום.
- **שינוי אימייל להתחברות (18.8.2026), שני מסלולים נפרדים:**
  - **עצמי (עובד/אדמין, בעצמו).** `POST /api/auth/change-email` — כמו `change-password`: דורש סיסמה נוכחית לאימות, לא token/gate נוסף. שולח מייל אבטחה **לכתובת הישנה** (לא החדשה) — כך שאם מישהו לא מורשה החליף את המייל, הבעלים האמיתי (שעדיין רואה את תיבת הדואר הישנה) יידע. כפתור "שינוי אימייל" ב-`index.html`, לצד "שינוי סיסמה" הקיים — גם ב"החשבון שלי" וגם ב"הגדרות → הגדרות כלליות" (שני המקומות שכבר הציגו את כפתור שינוי הסיסמה).
  - **ע"י סופר-אדמין (owner, ידני, ללא סיסמה נוכחית).** לא endpoint חדש — שדה `שם משתמש (אימייל)` בכרטיס "פרטי כניסה — אדמין ראשי" בעמוד חברה ב-`owner/index.html` הפך מ-`readonly` לעריכה + כפתור "שמור אימייל", ששולח ל-`PATCH /api/owner/companies/:id/employees/:employeeId` הקיים (**אותו** endpoint ששימש כבר לאיפוס סיסמה ע"י owner — הוא כבר תמך ב-`email` מהתחלה, לא נגעתי ב-backend בכלל). **בכוונה לא שולח מייל התראה** — עקבי עם איפוס-סיסמה-ע"י-owner הקיים, ששקט באותה צורה על אותו endpoint.
- **התראות מוגדרות (quota80/edit_request/support_reply) — הורחבו, לא נבנו מחדש.** `company_notification_settings` (migration 027) קיבל עמודת `_email_` מקבילה לכל עמודת `_notify_` קיימת (`quota80_email_admin`, `edit_request_email_admin`, וכו') — **ברירת מחדל `false`** (מייל פולשני יותר מפעמון, opt-in ולא opt-out כמו רוב ה-`_notify_`). נבדק ונשלח ב-`editRequests.js` וב-`ownerTickets.js`, באותה נקודה שכבר קוראת ל-`notifyAdmins`/`notifyEmployee` — לא נוסף hook חדש. **`quota80` אין לו trigger שרתי בכלל** (גם לא ל-in-app) — זה עדיין רק חישוב client-side לבאנר בדשבורד, כך שההגדרה קיימת ב-UI/DB אבל לא תשלח בפועל עד שמישהו יבנה בדיקה תקופתית בצד השרת. UI: טבלת "הגדרות התראות" ב-`index.html` קיבלה 2 עמודות נוספות ("גם במייל — מנהל/עובד") לצד ה-2 הקיימות.
- **הגדרת SMTP מפאנל ה-owner (18.8.2026) — לא רק `.env` יותר.** רובריקה חדשה "✉️ מייל" ב-`owner/index.html`. `smtp_settings` (migration 029, שורה יחידה קבועה `id=1`) — host/port/secure/username/password/from_name/from_email, ניתנים לעריכה בלי SSH לשרת. `mailer.js`'s `getSmtpConfig()` קורא מה-DB ונופל חזרה ל-env vars (`SMTP_HOST` וכו') **per-field** אם ה-DB ריק — כך ששני המסלולים תקפים, וה-DB מנצח כשהוא מוגדר. נקרא מחדש בכל שליחה (לא cached) — שינוי הגדרות דרך ה-UI פעיל מיד, בלי restart לשרת.
  - **סיסמת SMTP נשמרת ב-DB, לא רק ב-.env — טרייד-אוף מכוון.** מוגנת ע"י `requireOwner` בלבד (לא `requireOwnerScope` — מפתח owner_api_key **לא יכול לגעת בזה בכלל**, גם לא עם scope), ולעולם לא מוחזרת בגוף תשובת GET (`password_set: true/false` בלבד, לא הערך עצמו). **אין הצפנה ברמת האפליקציה** על העמודה בטבלה — מי שיש לו גישת DB יכול לקרוא אותה. זו החלטה מודעת (נוחות ניהול מול .env-בלבד), לא נשכחה.
  - `PATCH /api/owner/email/settings` — שדה `password` ריק/חסר = משאיר את הסיסמה הקיימת (לא צריך להקליד אותה מחדש בכל שינוי קטן). כל שאר השדות אותו דבר (COALESCE מול הערך הקיים).
  - `POST /api/owner/email/test-email` — שולח מייל בדיקה עם ההגדרות השמורות כרגע, ומחזיר את השגיאה האמיתית אם נכשל (לכן `mailer.js` מייצא גם `sendTestEmail` שכן זורק שגיאה, בניגוד ל-`sendMail` הרגילה שלעולם לא זורקת).
- **שליחת מייל — broadcast עם בחירת נמענים (18.8.2026, הורחב מ-"כל האדמינים" בלבד).** `POST /api/owner/email/broadcast` — `{subject, body, target, employee_ids?}`. `target`: `'admins'` (ברירת מחדל, כל האדמינים הפעילים בפלטפורמה — ההתנהגות המקורית), `'all'` (כל המשתמשים הפעילים, אדמינים+עובדים), `'manual'` (רק `employee_ids` — מערך שחובה כשנבחר, 400 אם ריק/חסר). כל השאילתות **בלי סינון company_id בכוונה** (owner-level = כל הפלטפורמה, כמו `ownerChangelog`/`ownerNotifications`). `GET /api/owner/email/recipients` מזין את בורר הנמענים הידני בפרונט — כל עובד פעיל בכל חברה, עם שם החברה, כדי שאפשר לסמן ידנית מי יקבל. דרך `Promise.all` בלי batching/rate-limiting — מספיק בהיקף הנוכחי (~19 חברות), אם יגדל משמעותית ייתכן שיידרש queue. אין אישור/confirm בצד השרת — ה-UI עושה `confirm()` עם הניסוח המתאים ליעד שנבחר לפני השליחה כי זו פעולה בלתי הפיכה.
- **חיבור Google OAuth כשולח (18.8.2026) — אלטרנטיבה ל-SMTP הידני, לא תחליף מאולץ.** כפתור "🔗 התחבר עם Google" ברובריקת ✉️ מייל ב-`owner/index.html` מתחיל flow תקני של OAuth2 authorization-code, ומעניק **הרשאת שליחה בלבד** (לא קריאה/מחיקה) על תיבת Gmail/Google Workspace שמחוברת. אפשר לחבר כמה חשבונות ולבחור איזה מהם ברירת המחדל בפועל.
  - **זרימה (`src/lib/googleOAuth.js` + `routes/ownerEmail.js`):** `POST /google/start` (owner מחובר) ממציא `state` חד-פעמי (Map בזיכרון, `ownerId`→state, תוקף 10 דקות — תהליך Node יחיד, בלי clustering, אז זה מספיק ולא דורש טבלה) ומחזיר URL להסכמת Google (`scope=openid email https://mail.google.com/`, `access_type=offline&prompt=consent` כדי שתמיד יחזור `refresh_token`, גם בחיבור חוזר לאותה תיבה). `GET /google/callback` הוא **היחיד ב-router שרץ *לפני* `router.use(authenticate, requireOwner)`** — נרשם קודם ב-Express אז אף פעם לא עובר את ה-auth gate — כי זו הפניית דפדפן רגילה מ-Google, בלי Bearer header; ה-`state` הוא מנגנון האימות שלו במקום זה. שומר/מעדכן שורה ב-`google_email_accounts` (migration 030, `ON CONFLICT (email) DO UPDATE` לחיבור חוזר), ומפנה בחזרה ל-`/owner/?email_connected=<email>` או `?email_error=<...>`; `boot()` ב-`owner/index.html` קורא את זה פעם אחת, מציג toast, עובר לעמוד מייל, ומנקה את ה-query string.
  - **מה כן נשמר, מה לא:** רק `refresh_token` (בלי `access_token`/תפוגה) — `nodemailer`'s OAuth2 support (`auth:{type:'OAuth2', refreshToken, clientId, clientSecret}`) שולף ומרענן access token בעצמו בכל שליחה, אז אין ניהול תפוגה בצד שלנו. `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` **רק ב-`.env`** (כמו `JWT_SECRET`) — סוד ברמת האפליקציה, לא per-tenant, אז לא עבר לטבלת DB כמו SMTP. `POST /google/start` מחזיר שגיאה ברורה בעברית אם הם עוד לא מוגדרים, במקום לשלוח את האדמין למסך שגיאה מבלבל של Google.
  - **סדר עדיפות שולח (`mailer.js`'s `resolveSender()`):** אם יש שורה ב-`google_email_accounts` עם `is_default=TRUE` — היא תמיד מנצחת; אחרת נופל ל-`smtp_settings`/env הקיימים. `PATCH /accounts/:id/default` הוא טרנזקציה (`BEGIN; UPDATE...FALSE; UPDATE...TRUE WHERE id=$1; COMMIT/ROLLBACK`) + unique index חלקי על `is_default=TRUE` כהגנה כפולה נגד שני חשבונות default בו-זמנית. `DELETE /accounts/:id` הוא מחיקה קשיחה (אין `active` flag — שום קוד לא היה משתמש בו) + ניסיון best-effort לבטל את ההרשאה מול Google (`revokeToken`, אף פעם לא חוסם/נכשל את המחיקה).
- **יומן שליחת מיילים (18.8.2026, לא היה קיים).** `email_send_log` (migration 031) — שורה לכל ניסיון שליחה, נכתבת מנקודת מחנק **אחת**: `sendMail()`/`sendTestEmail()` ב-`mailer.js` (fire-and-forget, `.catch(()=>{})`, אף פעם לא חוסמת/מפילה את השליחה עצמה). כך **כל** קטגוריית מייל מכוסה בלי קוד logging כפול בכל route: `welcome`, `password_reset`, `password_changed`, `email_changed`, `notification`/`support_reply`/`edit_request` (התראות מוגדרות), `broadcast`, `test`. סטטוס `sent`/`failed`/`skipped` (skipped = אין לא Google default ולא SMTP host מוגדר בכלל). `GET /api/owner/email/log` (מסונן `limit`/`offset`, ברירת מחדל 50, מקס' 200) מזין טבלה ב-✉️ מייל עם "טען עוד". אין UI/endpoint למחיקת רשומות יומן — כמו `system_changelog`, זה תיעוד לא-הפיך בכוונה.
- **מה עוד לא הוגדר / נשאר לעשות:** **אין עדיין ספק SMTP אמיתי ואין עדיין Google OAuth client מוגדרים.** SMTP: המשתמש בחר ספק בראש אבל עוד לא סיפק host/port/username/password — עד אז אין ערך ב-DB או ב-`.env` והמערכת רק רושמת ל-log במקום לשלוח בפועל. Google: `GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` עדיין לא ב-`.env` בשרת, אז "התחבר עם Google" יחזיר שגיאה ברורה במקום להתחיל את הflow (ראו "TODO פתוח"). כשיהיו פרטי SMTP: להזין אותם ישירות דרך פאנל ה-owner (✉️ מייל) — לא צריך יותר SSH ל-`.env` לשם כך, אבל האופציה עדיין קיימת כברירת מחדל/fallback. גם צריך רשומות DNS (SPF/DKIM) בדומיין כדי שלא ייפול לספאם (רלוונטי בעיקר למסלול ה-SMTP הידני — שליחה דרך Gmail/Workspace לא סובלת מזה באותה מידה כי Google עצמה עומדת מאחורי המשלוח).

### חיפוש כללי (Search) — לאינטגרציות חיצוניות כמו Make (18.8.2026)

נבנה במקור בשביל אפליקציית Make מותאמת אישית (custom app) שהמשתמש בונה ב-Make.com מול ה-API של TreeTime — Make דורש מודול "Search" עם תפריט "איזה אזור" + בונה תנאים דינמי (שדה/אופרטור/ערך, עם AND/OR), בדיוק כמו שכבר קיים באפליקציות Make בוגרות אחרות (Origami, לדוגמה). **עקרון בטיחות זהה למנוע ה-KPI** (`kpiEngine.js`): allowlist קשיח של טבלאות/שדות/אופרטורים ב-`src/lib/searchEngine.js`, שום מחרוזת גולמית מה-request לא הופכת ל-SQL — רק ל-`$N` params. `company_id` תמיד מוזרק קשיח מ-`req.auth.companyId` בקוד, **אף פעם לא** דרך רשימת התנאים שהלקוח שולח (ולכן `company_id` גם לא ברשימת השדות המותרים לאף entity — ניסיון לסנן לפיו נדחה כ-`unknown_field`, לא "עובד בטעות").

- **6 "אזורים" (entities) נתמכים היום:** `clients` (טבלת `projects`), `employees`, `time_entries`, `tasks`, `edit_requests`, `tickets` (טבלת `support_tickets`). **בכוונה לא** כולל דשבורד/הגדרות/הדרכות/webhooks/api_keys/שדות מותאמים — אלה מסכי ניהול/קונפיגורציה, לא "רשומות" שמחפשים לפיהן. הוספת אזור עתידי = תוספת קטנה ל-`ENTITIES` ב-`searchEngine.js`, לא שינוי ארכיטקטורה — לא נבנה מראש בשביל אזורים שעוד לא קיימים.
- **3 endpoints, כולם `requireScope('read')`:**
  - `GET /api/search/entities` — רשימת האזורים (מזין את תפריט "איזה אזור" ב-Make).
  - `GET /api/search/entities/:entity/fields` — השדות המותרים לאזור ספציפי + האופרטורים המותרים לכל שדה לפי סוגו (`text`/`number`/`date`/`boolean`). זה מה שמזין את הרשימה הדינמית של שדות ב-Make (Remote Procedure שמשתנה לפי איזה entity נבחר).
  - `POST /api/search/:entity/query` — `{conditions: [{field, operator, value, connector}], limit}`, מחזיר את הרשומות התואמות (מסונן ל-company, ממויין וmoved-limited לפי הגדרת ה-entity).
- **הערכת AND/OR — משמאל לימין, לא לפי סדר פעולות רגיל של SQL.** כל תנאי חדש עוטף ב-סוגריים את כל מה שהיה לפניו (`(((cond1) AND cond2) OR cond3)`), כדי להתאים לאינטואיציה של בונה-תנאים ויזואלי ("הוסף AND"/"הוסף OR" ברשימה שטוחה), לא ל-precedence שבו AND גובר על OR כברירת מחדל ב-SQL. **אין קינון קבוצות** (אין "(A OR B) AND (C OR D)") — רק רשימה שטוחה אחת, בכוונה, כדי לא לסבך את זה מעבר למה שהתבקש.
- **`limit`:** מאומת ע"י express-validator ל-1–200, **נדחה עם 400 אם מחוץ לטווח** — לא "מתוקן" בשקט לגבול הקרוב (עקבי עם `GET /api/owner/email/log`).
- **הרשאות:** `requireScope('read')` — עובד רגיל מחובר (לא רק אדמין) עובר תמיד; מפתח API צריך `read` או `admin` scope. אין הגבלת role נוספת — זו יכולת קריאה כללית, לא פעולת ניהול.
- **`GET /api/search/fields` — איחוד כל השדות מכל האזורים, בלי תלות ב-entity.** נוסף כניסיון ראשון לעקוף בעיה אמיתית ב-Make: RPC שמופעל משדה **מקונן** בתוך פרמטר מסוג `array` (כמו "שדה" בתוך שורת "תנאי חיפוש" חוזרת) לא מקבל באמינות את הערך של פרמטר-אח ברמה העליונה (`entity`) — `{{parameters.entity}}` חוזר ריק בתוך ה-RPC, בכל תחביר שנוסה. **מחקר בפועל (חיפוש בתיעוד הרשמי של Make ובפורום הקהילה שלהם) אישר שזו מגבלה מוכרת של הפלטפורמה** — כמה מפתחי Make אחרים דיווחו על אותה תופעה בדיוק: RPC עובד ברמה עליונה, לא עובד בתוך collection/array. `listAllFields()` (union מדודופלק של כל 21 השדות, לפי `key`) עדיין קיים ושימושי כפתרון גיבוי כללי, אבל **הפתרון בפועל שנבחר** (ראו הבא) עוקף את המגבלה לגמרי במקום להסתפק ב"הצעת יותר מדי שדות".
- **מבנה ה-UI הסופי ב-Make: 3 "משבצות" תנאי קבועות, לא מערך פתוח.** כדי לנצל דווקא את מה שכן מוכח כעובד (RPC תלוי ברמה עליונה), מודול "חיפוש כללי" ב-Make בנוי עם עד 3 תנאים כפרמטרים נפרדים ברמה העליונה (`field1/operator1/value1`, `field2/operator2/value2/connector1`, `field3/operator3/value3/connector2`) במקום מערך `criteria` דינמי — כל `fieldN` הוא select שכן תלוי ב-`entity` דרך RPC (`listFields`, שחזר לגרסה עם `{{parameters.entity}}` בכתובת), כי ברמה עליונה זה עובד. **טרייד-אוף מודע:** מקסימום 3 תנאים במקום כמות בלתי מוגבלת — מספיק לרוב המקרים האמיתיים, ונמנע מלהמשיך "לתקוע" על מגבלת פלטפורמה מתועדת.
- **`POST /:entity/query` מסנן משבצות ריקות בשקט, לא דוחה אותן.** כיוון שהמודול ב-Make שולח את כל 3 המשבצות בכל בקשה (גם אם המשתמש מילא רק תנאי אחד), ה-route מסנן החוצה כל condition בלי `field` **לפני** שהוא מגיע ל-`buildWhereClause` — כדי שלא נדרוש דחייה מלאה של הבקשה רק כי משבצת 2/3 ריקה. שאר התנאים עדיין מתקפלים נכון משמאל-לימין, בלי קשר לאילו משבצות בפועל היו מלאות.

### תצוגת תפריט: סרגל צד / סרגל עליון (18.8.2026)

העדפה אישית **לא מסונכרנת בין מכשירים** — נשמרת ב-`localStorage` (`tt_nav_layout`, `'sidebar'` ברירת מחדל או `'topbar'`) ולא ב-DB, בכוונה: זו בחירת תצוגה טהורה בלי משמעות עסקית/אבטחתית, אז לא הצדיק migration/endpoint חדש. `applyStoredNavLayout()` נקרא בתחילת `boot()`, מוסיף/מסיר class `nav-top` על `document.body`; כל שאר ההתנהגות היא CSS בלבד תחת `body.nav-top ...` (הופך את `.sidebar` משורה אנכית לרוחבית, `.app` מ-`flex-direction:row` ל-`column`, `.nav` מקבל `flex-direction:row` כדי שהאפשרויות יופיעו אחת ליד השניה) — שום קוד JS לא בונה מחדש את ה-DOM בין שני המצבים, רק toggle של class אחד. `renderNavLayoutPicker(wrapped)` — שני כרטיסים לחיצים ("סרגל צד" / "סרגל עליון"), מופיע פעמיים באותו קוד: ב"החשבון שלי" (`wrapped=true`, עטוף ב-`.panel` משלו, כי זה עמוד עצמאי) וב"הגדרות → הגדרות כלליות" (`wrapped=false`, בלי `.panel` נוסף כי זה כבר בתוך `.panel-pad` קיים — panel מקונן היה נראה מוזר). **רק ב-`index.html` (אדמין+עובד) — לא ב-`owner/index.html`**, לא התבקש שם.

### נראות סרטוני הדרכה לפי role (18.8.2026)

`guide_videos.visibility` (migration 028, `'admin'`/`'all'`, ברירת מחדל `'all'`) — הסופר-אדמין בוחר לכל סרטון בנפרד, בזמן הוספה/עריכה ב-`owner/index.html` (select "מי יראה את הסרטון"), האם הוא מיועד לאדמין בלבד או לכולם. **האכיפה בפועל ב-`guides.js`** (הצד שהאדמין/עובד של החברה קוראים ממנו, לא ב-`ownerGuides.js` שהוא ה-CRUD של הסופר-אדמין) — `req.auth.role !== 'admin'` מסנן החוצה סרטוני `'admin'` **בשרת**, לפני שהם מגיעים ל-client, לא רק מוסתרים ב-UI (עקבי עם "סינון שדות לפי role" ב"מוסכמות עבודה" למטה). ב-`owner/index.html` יש badge קטן ("אדמין בלבד") ליד כותרת סרטון עם visibility כזה, כדי שהסופר-אדמין יראה בסקירה מהירה בלי לפתוח כל סרטון בנפרד.

### אדמין מוסיף סרטוני הדרכה משלו לחברה שלו (19.8.2026)

עד עכשיו `guide_videos` הייתה ספרייה גלובלית בלבד — רק הסופר-אדמין (owner) יכול היה להוסיף/לערוך/למחוק סרטונים, זהים לכל החברות. עכשיו אדמין של חברה יכול להוסיף גם סרטונים משלו, שרק העובדים שלו רואים.

- **`guide_videos.company_id` (migration 036), NULLABLE — NULL = גלובלי (owner), ערך = שייך לחברה ספציפית בלבד.** לא טבלה נפרדת — אותה טבלה, כדי לשמור על אותן קטגוריות ואותו מנגנון `visibility` קיים.
- **`GET /api/guides` (הצד שהאדמין/עובד קוראים ממנו) מחזיר עכשיו `company_id IS NULL OR company_id = req.auth.companyId`** — גלובליים + הסרטונים של החברה שלי, יחד באותן קטגוריות. לעולם לא סרטונים של חברה אחרת.
- **`POST/PATCH/DELETE /api/guides/videos` חדשים — `requireRole('admin')`, תמיד `company_id = req.auth.companyId` בקוד (INSERT) או ב-`WHERE` (PATCH/DELETE).** אדמין בוחר קטגוריה **קיימת** (ניהול קטגוריות עצמו נשאר owner-בלבד — לא התבקש). PATCH/DELETE לעולם לא יכולים לפגוע בסרטון גלובלי (`company_id IS NULL` לעולם לא שווה למספר חברה אמיתי) או בסרטון של חברה אחרת.
- **תיקון נלווה הכרחי ב-`ownerGuides.js`:** בלי זה, ברגע שסרטוני חברה נכנסים לאותה טבלה, ה-CRUD הגלובלי של ה-owner (`GET`/`PATCH`/`DELETE` הקיימים, בלי סינון `company_id` בכלל לפני התיקון) היה **מציג ועלול לערוך/למחוק בטעות סרטונים פרטיים של חברות** מתוך פאנל הניהול הגלובלי. כל שאילתה שם קיבלה `WHERE company_id IS NULL` מפורש — ה-owner מנהל רק את הספרייה הגלובלית, בלי שום שינוי בפועל בהתנהגות שלו מנקודת המבט שלו.
- **פרונט:** כפתור "+ הוסף סרטון לחברה שלך" (אדמין בלבד) בעמוד "הדרכות", בתוך הקטגוריה הנבחרת. כל סרטון עם `company_id` לא-ריק מקבל אייקון עריכה (זיהוי "זה שלי" — אם `company_id` הגיע בתגובה בכלל, הוא מובטח להיות either גלובלי או של החברה שלי, אף פעם לא של חברה אחרת, אז `!=null` מספיק כדי לדעת "זה שלי, אפשר לערוך"). אותו מודאל משמש גם ליצירה וגם לעריכה.

### מגבלת שעונים פתוחים במקביל — per-company, ניתנת לעריכה (19.8.2026)

`POST /api/time-entries/start` תמיד חסם עובד מלפתוח יותר מדי שעונים פתוחים בו-זמנית (409 `too_many_running_timers`), אבל עד עכשיו זה היה קבוע קשיח בקוד (`MAX_CONCURRENT_TIMERS = 3`) — זהה לכל חברה, בלי שום דרך להגדיר אחרת. `company_timer_settings` (migration 033, שורה אחת per company, `max_concurrent_timers` ברירת מחדל 3) + `routes/timerSettings.js` חדש (`GET` — כל מחובר, `PATCH` — אדמין בלבד, מאמת טווח 1–20) הופכים את זה למדיניות שכל אדמין קובע לחברה שלו. `timeEntries.js`'s `/start` קורא את הערך מה-DB לפי `company_id` בכל בקשה (לא cached), נופל חזרה ל-3 אם אין שורה עדיין (חברה שלא שינתה כלום). UI: תת-סעיף חדש בהגדרות → **"הגדרות שעונים"** (שינוי שם מ"סגירה אוטומטית של דיווחי עבודה פתוחים" — הקטגוריה עכשיו כוללת גם את זה, לא רק auto-close), עם שדה מספרי + כפתור שמירה נפרד משלו (`PATCH /api/timer-settings` בפועל מול השרת — **לא** דרך `saveSettings()`/`persist()` הקיימים של אותה קטגוריה, ששומרים רק ל-`localStorage` ולכן לא היו מתאימים למדיניות אמיתית ברמת חברה).

### השהיית שעון ("הקפאה") — לא סגירה (19.8.2026)

עד עכשיו לשעון פתוח היו רק שני מצבים: רץ, או עצור (`ended_at`). עכשיו יש מצב שלישי: מוקפא — לא מסיים את הדיווח, רק מקפיא את מונה הזמן, ולא נספר בעלות.

- **`time_entries` (migration 034):** `paused_at` (TIMESTAMPTZ, לא NULL כל עוד מוקפא) + `paused_seconds` (INTEGER, מצטבר על פני כל מחזורי הקפאה/המשך). `POST /api/time-entries/pause` ו-`/resume` חדשים (אותו דפוס disambiguation כמו `/start`/`/stop` — `entry_id` נדרש רק אם לעובד יש כמה שעונים תואמים). שעון מוקפא **עדיין נחשב "רץ"** לצורך מגבלת השעונים המקבילים (`company_timer_settings`) — לא משחרר סלוט.
- **`/stop` מסכם הקפאה שעדיין פעילה** (אם עצרו שעון בזמן שהוא מוקפא) לתוך `paused_seconds` **לפני** חישוב העלות — כדי שהזמן המוקפא לעולם לא ייספר. `computeCost()` קיבל פרמטר `pausedSeconds` רביעי, מחסיר אותו מהפרש הזמן לפני הכפלה בתעריף.
- **`PATCH /:id` (עריכה ידנית של שעה/תיאור, כולל הזרימה הקיימת שבה `stopTimer()` בפרונט קורא ל-`/stop` ומיד אחריו PATCH עם שעות שהמשתמש יכול לערוך)** לא צריך לקבל `paused_seconds` בבקשה בכלל — הוא קורא את הערך **כבר-מסוכם** מהשורה עצמה (`current.rows[0].paused_seconds`), שכבר עודכן ע"י `/stop` שרץ קודם. כלומר גם תיקון ידני של שעת התחלה/סיום ממשיך להחריג נכון את זמן ההקפאה, בלי לשנות את הפרונט בכלל.
- **פרונט:** `elapsedMinutes()`/`elapsedClock()` שינו חתימה — מקבלים עכשיו את **אובייקט הטיימר המלא** (לא רק `startedAt`) ומחשבים "מוקפא עד כה" (`timerPausedSecondsSoFar`) כדי שהשעון בתצוגה **יקפא בפועל** (לא ימשיך לתקתק) כל עוד `pausedAt` מוגדר — גם ב-`setInterval` של הטיקטוק החי. עודכנו כל 9 מקומות הקריאה. כפתור השהה/המשך נוסף לצד כל כפתור "עצור" קיים בלי יוצא מן הכלל: "כל השעונים הפתוחים" (אדמין), ה-widget הצף, שורת משימה, ומודאל פרטי משימה.
- **`stopTimer()`'s תצוגת "משך זמן" (רק preview, לא נשלח לשרת) נשארה כפי שהייתה — לא מחריגה זמן מוקפא ולא מציגה הסבר על כך.** ניסיון ראשוני להוסיף שם גם תצוגת הסבר (`${ICON.clock} הזמן שבו השעון היה מוקפא...`) נכשל ויזואלית — האייקון הגולמי נרנדר ענק בלי container שמגביל את הגודל — והוסר לגמרי לפי בקשה מפורשת ("לא רלוונטי"). **החישוב האמיתי לצורך העלות הסופית נשאר תקין** — קורה בשרת (`/stop` + fallback ב-`PATCH`), בלי תלות במה שמוצג ב-preview הזה.
- **חלון קופץ ("שעון פעיל") נפתח בלחיצה על כרטיסיית ה-widget הצף** (`openTimerDetail`) — מציג עובד, לקוח, משימה מקושרת אם יש, שעת התחלה וזמן שרץ (מתעדכן חי — אותו `data-timer-clock` שהטיקטוק הגלובלי כבר מעדכן, גם כשהוא בתוך מודאל), עם כפתורי השהה/המשך ועצור-דיווח בתוך החלון עצמו. לחיצה על כפתורי ההשהיה/עצירה בכרטיסייה עצמה (לא בתוך הפופ-אפ) ממשיכה לעבוד ישירות בלי לפתוח את הפופ-אפ (`event.stopPropagation()`).

### אדמין נכנס בתור עובד (impersonate), ברמת החברה — לא רק owner (19.8.2026)

עד עכשיו impersonation היה קיים רק ל-owner (`POST /api/owner/companies/:id/impersonate`, לצורך תמיכה). עכשיו גם אדמין רגיל יכול "להיכנס בתור" עובד **בתוך החברה שלו בלבד**, כדי לבדוק איך המערכת נראית מהצד של המשתמש שלו.

- **`employee_impersonation_log` (migration 035) — טבלה נפרדת מ-`impersonation_log` הקיימת של ה-owner**, כי שם `owner_id` הוא `NOT NULL REFERENCES owners(id)` ולא ניתן לשימוש חוזר לאדמין (שהוא employee, לא owner). מבנה מקביל: `company_id`, `admin_id`, `employee_id`.
- **`POST /api/employees/:id/impersonate` (חדש, ב-`employees.js`) — `requireRole('admin')`, מוגבל מפורשות ל-`company_id` של האדמין** (`WHERE id=$1 AND company_id=$2` — לא ניתן לחצות בין חברות, גם לא בניחוש `id`). מחזיר `{token, employee}` — טוקן חד-פעמי בתוקף שעה (`expiresIn: '1h'`), עם `impersonated_by` בתוכו (מזהה האדמין), **מראה בדיוק את אותו מבנה** כמו טוקן ה-impersonate של ה-owner.
- **פרונט: כפתור "⚡ היכנס בתור" בתחתית מודאל "עריכת עובד"** (`openFreelancerForm`, ליד "שמור"), מוצג רק בעריכת עובד קיים שהוא לא אתה בעצמך. `impersonateEmployee()` **מעתיק תו-בתו את מנגנון ה-`window.open` הסינכרוני** שכבר קיים ב-`owner/index.html` (חובה לפתוח את הטאב **לפני** ה-`await`, אחרת דפדפנים חוסמים את זה כפעולה לא-יזומה-ע"י-משתמש) — פותח טאב חדש ל-`/c/<slug>/?token=<token>`, מנגנון query-string שכבר קיים ונתמך ב-`boot()` הקיים (לא נגעתי בו).
- **נבדק:** אדמין מצליח להיכנס בתור עובד באותה חברה + הטוקן המוחזר מכיל בדיוק את השדות הנכונים (`sub`/`role`/`company_id`/`impersonated_by`) + רשומת יומן נכתבת; עובד רגיל (לא אדמין) נדחה ב-403; ניסיון להיכנס בתור עובד מ**חברה אחרת** נדחה ב-404 (לא חושף אפילו אם ה-id קיים); id לא קיים → 404.

### כרטיס עובד (תצוגת אדמין) מקבל דשבורד נתונים, כמו כרטיס לקוח (19.8.2026)

`openFreelancerForm` (עריכת עובד קיים) מקבל בראש המודאל את `renderFreelancerDashboardTiles(f)` — 3 אריחים (פרטי עובד/שעות שעבד החודש/מגמת 6 שבועות, `freelancerWeeklyTrend()` חדש, מקביל ל-`clientWeeklyTrend`). מוצג רק בעריכת עובד קיים (לא ב"עובד חדש", אין עדיין נתונים). **תוסף אז גם סקשן דיווחים מסונן מתחת לאריחים (משותף עם כרטיס לקוח, ראו למטה) — הוסר לגמרי לפי בקשה מפורשת בהמשך אותו יום** (נשארו רק 3 האריחים בשני הכרטיסים).

### גישה לעובד ל"כרטיס לקוח" + סינון דיווחים בתוכו (19.8.2026)

עד עכשיו "כרטיס לקוח" (המודאל שנפתח מ-`openClientForm`, עם אריחי סיכום + טבלת "3 דיווחים אחרונים" קבועה) היה נגיש רק לאדמין — לעובד לא הייתה בכלל כניסה ל"לקוחות" (`FREELANCER_PAGES` לא כלל את זה בכלל). שני שינויים ביחד:

- **עובד מקבל גישה, בגרסה מצומצמת.** `FREELANCER_PAGES` קיבל `{id:'clients', label:'הלקוחות שלי'}` (אותו slug `clients` כמו אצל אדמין — אין צורך ב-route חדש). `filteredClients()`/`renderClientCard` הפכו role-aware: עובד רואה רק `clientsForFreelancer()` (לקוחות המקושרים אליו, או לא-מקושרים לאף אחד = פתוחים לכולם — פונקציה שכבר הייתה קיימת), בלי כפתורי עריכה/לינק-פורטל/ארכיון (רק "פתח"), ובלי כפתורי "לקוח חדש"/"שדות מותאמים אישית" בראש העמוד. `openClientForm` מסתעף ל-2 מסלולים: אדמין ממשיך לקבל את טופס העריכה המלא כרגיל; עובד מקבל מודאל קריאה-בלבד ("פרטי לקוח") עם אריחי הסיכום + תיאור — בלי שום שדה פיננסי (תעריף שעתי/בנק שעות) ובלי כפתור שמירה. **שים לב:** `GET /api/projects` כבר היום לא מסנן לפי role בשרת (מחזיר את כל לקוחות החברה לכל מחובר) — הסינון כאן, כמו בכל שאר האפליקציה (דיווחים/משימות), הוא client-side בלבד; זה עקבי עם הדפוס הקיים בכל המערכת, לא שינוי חדש.
- **טבלת "3 דיווחים אחרונים" הקבועה הוחלפה בסקשן מסונן מלא, ואז הוסרה שוב לגמרי (19.8.2026, אותו יום).** בהתחלה נבנה סקשן מסונן זהה לשורת הסינון של עמוד "דיווחי עבודה" (עובד/לקוח/תאריכים/נקה סינון/שמור כ-widget, `renderClientReportsSection()`+`clientCardFilters`, גם שוכפל לכרטיס עובד — ראו למעלה). **הוסר לגמרי לפי בקשה מפורשת** ("תוריד לי את הדבר הזה... מהיישויות הבאות: לקוחות, עובדים") — כולל הפונקציה, המשתנה, ושתי נקודות ה-seed בכרטיסי לקוח/עובד. נשארו רק 3 אריחי הסיכום בשני הכרטיסים (`renderClientDashboardTiles`/`renderFreelancerDashboardTiles`) — אין יותר טבלת דיווחים כלשהי בתוך אף אחד מהכרטיסים.

### התראה על דיווח עבודה ארוך — סף דקות ניתן להגדרה (20.8.2026, UI הועבר להגדרות שעונים 20.8.2026)

האדמין יכול להגדיר סף דקות (למשל 120), וכל דיווח עבודה בודד שמגיע אליו או חוצה אותו מקפיץ התראה — לא רק on/off כמו שאר סוגי ההתראות ב"הרשאות התראות", אלא ערך מספרי שהאדמין קובע בעצמו. הבקאנד (migration + `notificationSettings.js` + `timeEntries.js`) לא זז — רק מיקום ה-UI.

- **`company_notification_settings` (migration 037) קיבל 3 עמודות חדשות:** `long_entry_threshold_minutes` (INTEGER, **nullable**, בלי ברירת מחדל) + `long_entry_notify_admin`/`long_entry_email_admin` (BOOLEAN, אותה מוסכמת default TRUE/FALSE כמו `edit_request` — in-app דלוק כברירת מחדל, מייל opt-in). **ה-NULL הוא המתג האמיתי, לא ה-boolean-ים:** כל עוד לא נבחר סף בפועל, ההתראה כבויה **לגמרי**, גם אם שני הסימונים מסומנים — כי אין משמעות ל"התראה על חריגה מסף" בלי סף. זה שונה מכל שאר השורות בטבלה, שכולן boolean-בלבד.
- **בדיקה מתבצעת בשרת, ב-`timeEntries.js`, בכל נקודה שדיווח מקבל משך זמן סופי:** `maybeNotifyLongEntry()` נקראת (fire-and-forget, `.catch(()=>{})`, לעולם לא יכולה להפיל את הפעולה שהפעילה אותה) מ-`POST /stop` (עצירת שעון רץ) ומ-`POST /` (יצירת דיווח ידני עם `started_at`/`ended_at` מפורשים). **בכוונה לא** מ-`PATCH /:id` (עריכת דיווח קיים) — עריכה שדוחפת דיווח קיים מעל הסף היא edge case נדיר, והוספתה הייתה מצריכה מנגנון "כבר הודעתי על זה" כדי למנוע spam בכל עריכה חוזרת; לא נבנה מראש בשביל מקרה שלא התבקש.
  - **הזמן שנבדק נטו, לא ברוטו** — מחסיר `paused_seconds` בדיוק כמו `computeCost()` (ראו "השהיית שעון" למעלה), כך שדיווח של 4 שעות שרובן הקפאה לא מקפיץ התראה על סמך זמן שהעובד לא באמת עבד בו.
  - ההשוואה היא **"שווה או מעל"** (`netMinutes >= threshold`), בדיוק כפי שהוגדר — לא "מעל" בלבד.
  - הודעת ההתראה כוללת שם עובד + מספר הדקות בפועל + הסף שהוגדר, ל-`link_page:'reports'` (עמוד "דיווחי עבודה"). `notifyAdmins`/`sendAdminEmails` — אותו דפוס בדיוק כמו `edit_request` ב-`editRequests.js`, כולל ה-`!== false` ל-notify (מתייחס ל-undefined כברירת מחדל TRUE, עקבי עם שאר הטבלה).
- **`notificationSettings.js`:** `DEFAULTS` קיבל את 3 השדות (`long_entry_threshold_minutes:null`). `PATCH /` קיבל ולידציה חדשה (`express-validator`, שדה יחיד) — `long_entry_threshold_minutes` חייב להיות מספר שלם ≥ 1 **אם נשלח**, `optional({nullable:true})` כדי לתמוך גם בניקוי השדה (חזרה ל-NULL = כיבוי). זה השדה הראשון בטבלה הזו שמקבל ולידציית קלט אמיתית — כל שאר השדות תמיד היו boolean מוזרקים בבטחה עם `!!`.
- **UI — בהתחלה שורה רביעית ב"הרשאות התראות", הועבר ל"הגדרות שעונים" באותו יום לפי בקשה מפורשת.** לא בטבלה יותר — בלוק נפרד בתחתית `catId==='autoClose'` (index.html), אחרי בלוק "מקסימום שעונים פתוחים במקביל". דרופדאון "האם להפעיל התראה על דיווח עבודה ארוך?" (כן/לא, `toggleLongEntryFields()`) חושף/מסתיר את שדה הסף + 2 checkboxes ("התראה בפעמון באפליקציה"/"גם במייל") — **בדיוק אותו דפוס show/hide כמו `sAutoCloseEnabled`/`toggleAutoCloseFields()`** הקיים כבר באותו עמוד לבלוק הסגירה האוטומטית, לא הומצא דפוס חדש. "לא" בדרופדאון שולח `long_entry_threshold_minutes:null` בשמירה (מכבה את ההתראה לגמרי, זהה לניקוי השדה המספרי בגרסה הקודמת). `saveLongEntrySettings()` הוא כפתור "שמור" נפרד משלו בבלוק, קורא ל-**אותו** `PATCH /api/notification-settings` הקיים (לא endpoint חדש) — למרות שהעברנו את זה לעמוד "הגדרות שעונים", זה עדיין נשמר באותה טבלת DB (`company_notification_settings`) עם שאר ההתראות, לא עבר ל-`company_timer_settings`.
  - **מלכודת שהייתה קרובה לקרות ותוקנה לפני commit:** מכיוון ש-`PATCH /api/notification-settings` מחליף את כל השורה (`{...DEFAULTS, ...req.body}` בשרת), ושני העמודים ("הרשאות התראות" ו"הגדרות שעונים") שולחים PATCH נפרד עם רק השדות שהם עצמם מציגים — שמירה בעמוד אחד הייתה **מאפסת בשקט** את השדות שהעמוד השני מנהל, חזרה ל-DEFAULTS. שני הפתרונות פורסים `...state.notificationSettings` (המצב האחרון שנטען מה-GET) כבסיס ל-body לפני שדורסים רק את השדות שבאמת מוצגים בעמוד הזה — כך ששמירה בעמוד אחד תמיד משמרת את מה שהעמוד השני שמר.
- **אומת** עם סקריפט מקומי מול Express אמיתי + fake pool + fake clock (לא DB אמיתי): סף שנחצה/לא נחצה/בדיוק שווה, סף לא מוגדר (NULL) עם דיווח ארוך במיוחד → בלי התראה, notify_admin=false עם email_admin=false → בלי כלום, notify_admin=true עם email_admin=false → מתריע בלי מייל, ודיווח עם מחזור השהיה/המשך → הזמן המוקפא לא נספר לצורך הסף. גם `PATCH /api/notification-settings`: 403 לעובד רגיל, 400 על סף לא תקין (0 או לא-מספר), 200 ושמירה נכונה על סף תקין, וניקוי השדה מחזיר ל-NULL.

### בקשות עריכה — פופ-אפ מאוחד לצפייה/עריכה/אישור/דחייה (20.8.2026)

עד עכשיו הטיפול בבקשת עריכה היה מפוצל: "אשר וערוך" בשורת הטבלה מיד סימן את הבקשה כמאושרת, ואז **ניווט לעמוד "דיווחי עבודה"** ופתח שם מודאל עריכה כללי ונפרד (`openEntryForm`) בלי קשר ויזואלי לבקשה עצמה. "דחה" פתח מודאל אחר עם שדה הערה בלבד, בלי להראות את פרטי הבקשה/הדיווח. לפי בקשה מפורשת — הכל אוחד לפופ-אפ אחד.

- **כפתור יחיד בכל שורה, `openEditRequestDetail(id)`, במקום זוג/טקסט משתנה לפי מצב.** טבלת "בקשות עריכה" (`renderEditRequestsPage`) איבדה את כפתורי "אשר וערוך"/"דחה" הנפרדים ואת הטקסט המשתנה ("הערה:"/"הערת מנהל:"/"ממתין לטיפול מנהל") — כל שורה מקבלת כפתור אחד: "טיפול בבקשה" (בקשות pending, אדמין) או "צפייה" (הכל השאר — resolved, או כל שורה מנקודת מבט עובד). שני הכפתורים פותחים את **אותו** פופ-אפ; ההבדל בתוכן נקבע בתוך הפונקציה עצמה, לא בכפתור.
- **תוכן הפופ-אפ מותאם לפי 3 משתנים: role (אדמין/עובד) × סטטוס הבקשה (pending/resolved) × האם הדיווח המקורי עדיין קיים:**
  - **אדמין + pending + הדיווח קיים (המצב הנפוץ):** שדות עריכה מלאים של הדיווח (לקוח/תאריך/שעות/משך מחושב/תיאור, זהים לשדות ב-`openEntryForm` הקיים אבל עם id-ים נפרדים בקידומת `erq` כדי לא להתנגש) + סיבת הבקשה כטקסט read-only + הערה אופציונלית לעובד + שני כפתורים: "אשר ושמור עריכה" ו"דחה בקשה".
  - **אדמין + pending + הדיווח נמחק:** הודעה "הדיווח המקורי נמחק — לא ניתן לערוך אותו" במקום שדות עריכה, בלי כפתור אישור (אין מה לאשר), **כן** עם כפתור דחייה (עדיין אפשר לסגור את הבקשה פורמלית).
  - **כל מצב resolved (approved/rejected), לכל role:** תצוגת סיכום read-only של הדיווח (כמו הכרטיס ב-`openEditRequestForm` הקיים) + הערת המנהל אם יש, בלי שום שדה עריכה ובלי כפתורי פעולה — רק "סגור".
  - **עובד צופה בבקשה שלו (כל סטטוס):** תמיד read-only — לא מקבל שדות עריכה ולא כפתורי פעולה גם אם הבקשה pending, זהה להתנהגות ההרשאות הקודמת (רק אדמין מטפל בבקשות).
- **"אשר ושמור עריכה" — פעולה אחת בפופ-אפ, שתי קריאות API ברצף, לא ניווט לעמוד אחר.** `approveEditRequestFromDetail(id)` מריץ `PATCH /api/time-entries/:entryId` עם הערכים הערוכים (**אותו payload בדיוק** כמו ש-`saveEntry` הקיים היה שולח — `project_id`/`description`/`started_at`/`ended_at`, לא נגעתי ב-endpoint), ורק **אחרי הצלחה** — `PATCH /api/edit-requests/:id` עם `{status:'approved', admin_note}`. אם שדה התיאור קצר מ-10 תווים, שתי הקריאות נחסמות מראש (זהה לוולידציה הקיימת ב-`openEntryForm`). "דחה בקשה" (`rejectEditRequestFromDetail`) נשאר קריאה בודדת כמו קודם, רק עם ה-state הועבר לתוך אותו פופ-אפ במקום מודאל-בתוך-מודאל נפרד.
- **שדה "הערה לעובד" — `document.getElementById('erqAdminNote')?.value` עם `?.`, לא הנחת-קיום.** בכל תרחיש שהדיווח נמחק (אין שדות עריכה) השדה עדיין קיים ומוצג (מבוקר ע"י `admin && status==='pending'`, לא ע"י קיום הדיווח) — אבל ה-`?.` שומר גם על מקרה תיאורטי שבו הפונקציה נקראת כשהשדה לא ברינדור בפועל, בלי לזרוק שגיאה.
- **לא נבנה `openEntryForm`/`saveEntry` מחדש** — הפופ-אפ החדש הוא מסלול ייעודי מקביל לבקשות עריכה בלבד (id-ים נפרדים, `approveEditRequestFromDetail` נפרד), לא שינוי להתנהגות "דיווח עבודה ידני"/"עריכת דיווח" הרגילה שממשיכה לעבוד בדיוק כפי שהייתה דרך `openEntryForm` הקיים בעמוד "דיווחי עבודה".
- **אומת** מול VM sandbox שמריץ את הפונקציות המדויקות שנשלחו (לא שכתוב שלהן) עם DOM מזויף: 6 שילובי role×status×entry-exists לבדיקת איזה שדות/כפתורים מופיעים, ועוד 5 תרחישים לבדיקת ה-payloads בפועל (סדר שתי הקריאות באישור, חסימת אישור עם תיאור קצר מדי בלי קריאת API כלל, השמטת `admin_note` ריק מה-JSON כשלא הוקלדה הערה, ותקינות הדחייה גם כשאלמנט ההערה לא קיים ב-DOM כי הדיווח נמחק).

### גישת API לאוטומציה (owner-level, לא company-level)

מ-17.8.2026 יש דרך למתן אוטומציה (CI, בדיקות e2e, רישום changelog) גישה **ממוקדת** לפעולות owner-only, בלי session אמיתי ובלי להרחיב את מנגנון ה-`api_keys` הרגיל (שהוא per-company, `requireRole`/`requireScope` — לעולם לא `requireOwner`).

- טבלה נפרדת `owner_api_keys` (migration 021), לא קשורה ל-`api_keys` הרגילה.
- Scopes תקפים: `changelog:write` (POST `/api/owner/changelog`), `impersonate` (POST `/api/owner/companies/:id/impersonate`). כל endpoint owner אחר (companies CRUD, dashboard, employee edits) עדיין `requireOwner` בלבד — מפתח כזה לא יכול לגעת בהם.
- יצירה: `POST /api/owner/api-keys` (owner session אמיתי בלבד — לא ניתן ליצור מפתח עם מפתח). מחזיר את המפתח הגולמי (`tto_...`) פעם אחת בלבד.
- ב-middleware: `req.auth.type === 'owner_apikey'`, ו-`req.auth.ownerId` מוגדר לזהות היוצר (מ-`created_by`) — כך שקוד קיים שקורא `req.auth.ownerId` (למשל רישום ל-`impersonation_log`, `created_by` ב-changelog) עובד זהה לשני סוגי ה-auth בלי שינוי נוסף.
- `requireOwnerScope(scope)` ב-`middleware/auth.js` — מקביל ל-`requireOwner` אבל מוסיף גם מעבר למפתח עם ה-scope הנכון.

## מוסכמות עבודה

1. **יומן שינויים חובה.** אחרי כל שינוי אמיתי — רשומה ב-`system_changelog` דרך `POST /api/owner/changelog` (`{version, category, title, description}`, description מפורט בעברית: שורש הבעיה, התיקון, איך אומת). אין אפשרות מחיקה. מספור נכון לאוגוסט 2026: הגענו ל-**1.37**, הבא **1.38**.
2. **סינון שדות לפי role, לא open-gate גורף.** כשעובד רגיל צריך גישה ל-endpoint שהיה admin-only — הפתרון הוא סט שדות מצומצם (ראו `EMPLOYEE_LIST_FIELDS_BASIC` ב-`employees.js`), לא לפתוח את כל השדות לכולם.
3. **שינויי הרשאה תמיד ב-frontend + backend ביחד**, אף פעם רק באחד — אחרת ניתן לעקוף דרך קריאת API ישירה.
4. **בדיקות end-to-end ב-curl**, כולל impersonation דרך `POST /api/owner/companies/:id/impersonate` (מקבל `employee_id` אופציונלי כדי להיכנס כעובד ספציפי בלי לדעת סיסמה). לנקות נתוני בדיקה בסוף.
5. **לא להוסיף אבסטרקציות/ולידציות/הרשאות שלא התבקשו.** לבנות בדיוק את מה שביקשו, לא לנחש דרישות עתידיות.
6. **תגובות למשתמש בעברית**, ישירות: מה השורש, מה התיקון, איך אומת.

## גישה וסודות

**שום סוד לא נמצא בקובץ הזה או בריפו בכוונה תחילה** — לא סיסמאות, לא JWT secret, לא connection string. `.env` בשרת (`/opt/treetime-api/.env`) מכיל `DATABASE_URL`, `JWT_SECRET`, `JWT_EXPIRES_IN`, `PORT`, `NODE_ENV` ומודר דרך `.gitignore`. `uploads/` (קבצים שהעלו משתמשים בפועל) גם מודר בכוונה — זה דאטה של לקוחות, לא קוד, והריפו **ציבורי**.

**עוד לא הוגדרו בשרת (מ-18.8.2026, ראו "אינטגרציית מייל" למעלה):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `SUPPORT_EMAIL`, `APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`. עד שיתווספו — המערכת רק רושמת מיילים ל-log במקום לשלוח (או, עבור Google, מסרבת להתחיל את ה-OAuth flow עם שגיאה ברורה), לא נכשלת בשקט.

Super-admin: `support@tree-tech-system.com`. סיסמאות (כל הרמות) נמסרות/מתאפסות רק בצ'אט ישירות מהמשתמש, לעולם לא נשמרות בקובץ.

## TODO פתוח (ראו גם Task list של הסשן)

1. ✅ ~~backend בגיט~~ — הושלם, PR #3.
2. ✅ ~~Deploy workflow ל-backend~~ — הושלם, PR #5.
3. ✅ ~~אוטומציה למיגרציות + GRANT~~ — הושלם, PR #6 + bootstrap בשרת בוצע (17.8.2026). מיגרציה 021 היא הבדיקה החיה הראשונה של הריצה האוטומטית.
4. ✅ ~~גישת API ייעודית לבדיקות e2e ולרישום changelog~~ — הושלם: מנגנון `owner_api_keys` נפרד וממוקד-scope (ראו "גישת API לאוטומציה" למעלה), migration 021. **נשאר לבצע ידנית פעם אחת:** owner מחובר צריך ליצור בפועל מפתח דרך `POST /api/owner/api-keys` (`{"name":"CI automation","scopes":["changelog:write","impersonate"]}`) ולשמור את ה-`api_key` שמוחזר (רק פעם אחת) כ-secret ב-GitHub (למשל `OWNER_API_KEY`) לשימוש עתידי באוטומציה/curl.
5. ✅ ~~Test suite / CI~~ — הושלם, PR #5 (`ci.yml`): `node -c` + `npm ci` על כל PR.
6. החלטה: לנקות את חברות הדמו (IDs `1`, `5`, `7` בטבלת `companies`) לפני production אמיתי, או להשאיר? **לא טופל — משנה נתוני production, ממתין להחלטה מפורשת.**
7. **אינטגרציית מייל (SMTP) — הקוד מוכן, חסרים פרטי ספק אמיתיים (18.8.2026).** ראו "אינטגרציית מייל" למעלה — כל הזרימות (איפוס סיסמה, אישור חשבון, welcome, שינוי סיסמה, התראות מוגדרות, broadcast) בנויות ועובדות, אבל בלי הגדרות SMTP אמיתיות (לא ב-DB דרך פאנל ה-owner, לא ב-`.env`) שום מייל לא באמת יוצא (רק log). **נשאר:** (א) לבחור/להקים ספק בפועל ולקבל host/port/username/password, (ב) **להזין אותם ישירות בפאנל ה-owner (✉️ מייל → הגדרות SMTP)** — לא צריך יותר SSH/`.env` בשביל זה, יש UI ייעודי מ-18.8.2026, (ג) ללחוץ "שלח מייל בדיקה" באותו מסך כדי לוודא שההגדרות תקינות, (ד) רשומות DNS (SPF/DKIM) בדומיין כדי שלא ייפול לספאם — זה עדיין דורש גישה ל-DNS registrar, לא ניתן לעשות מהמערכת.
8. **חיבור Google OAuth כשולח — הקוד מוכן, חסר Google Cloud OAuth client (18.8.2026).** ראו "אינטגרציית מייל" למעלה. **נשאר, כולו מחוץ למערכת (Google Cloud Console):** (א) ליצור פרויקט (או להשתמש בקיים) ולהפעיל בו OAuth consent screen — אם `tree-tech-system.com` הוא דומיין Google Workspace, כדאי לבחור סוג משתמש **Internal** דווקא (לא External), כדי לדלג לגמרי על תהליך אימות/סקירה של Google עבור scope רגיש כמו `https://mail.google.com/`; (ב) ליצור OAuth Client ID מסוג "Web application", ולהוסיף ל-Authorized redirect URIs **בדיוק** את `https://treetime.tree-tech-system.com/api/owner/email/google/callback` (חובה להתאים תו-לתו, כולל ה-`/api/` — אין nginx route נפרד, זה מגיע ישירות ל-backend דרך ה-proxy הקיים ל-`/api/`, אין צורך בשינוי nginx); (ג) להזין את ה-Client ID וה-Client Secret שמתקבלים כ-`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` ב-`.env` בשרת (`/opt/treetime-api/.env`) + `sudo systemctl restart treetime-api` — **אין** UI ל-2 השדות האלה בפאנל ה-owner בכוונה (הם סוד ברמת האפליקציה כולה, לא per-tenant, כמו `JWT_SECRET`); (ד) ללחוץ "🔗 התחבר עם Google" ברובריקת ✉️ מייל ולוודא שהחיבור מצליח ומחזיר לעמוד עם toast הצלחה.
