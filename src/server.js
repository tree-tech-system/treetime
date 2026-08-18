require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

const pool = require('./db/pool');
const openapiSpec = require('./docs/openapiSpec');
const authRoutes = require('./routes/auth');
const employeeRoutes = require('./routes/employees');
const projectRoutes = require('./routes/projects');
const timeEntryRoutes = require('./routes/timeEntries');
const apiKeyRoutes = require('./routes/apiKeys');
const webhookRoutes = require('./routes/webhooks');
const reportRoutes = require('./routes/reports');
const ticketRoutes = require('./routes/tickets');
const editRequestRoutes = require('./routes/editRequests');
const signupRoutes = require('./routes/signup');
const clientFieldRoutes = require('./routes/clientFields');
const clientIntakeRoutes = require('./routes/clientIntake');
const notificationSettingsRoutes = require('./routes/notificationSettings');
const ownerGuideRoutes = require('./routes/ownerGuides');
const guideRoutes = require('./routes/guides');
const employeeFieldRoutes = require('./routes/employeeFields');
const employeeIntakeRoutes = require('./routes/employeeIntake');
const brandingRoutes = require('./routes/branding');
const ownerChangelogRoutes = require('./routes/ownerChangelog');
const notificationRoutes = require('./routes/notifications');
const ownerNotificationRoutes = require('./routes/ownerNotifications');
const ownerAuthRoutes = require('./routes/ownerAuth');
const ownerCompanyRoutes = require('./routes/ownerCompanies');
const ownerTicketRoutes = require('./routes/ownerTickets');
const adminSignupLinkRoutes = require('./routes/adminSignupLinks');
const taskRoutes = require('./routes/tasks');
const ownerApiKeyRoutes = require('./routes/ownerApiKeys');
const dashboardWidgetRoutes = require('./routes/dashboardWidgets');
const ownerEmailRoutes = require('./routes/ownerEmail');

const app = express();

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    limit: 300,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// Logs every authenticated API call to api_activity_log, scoped per company.
// Reads req.auth after the route's own auth middleware has populated it, since
// this listener only fires once the response is finished.
app.use('/api', (req, res, next) => {
  res.on('finish', () => {
    const companyId = req.auth?.companyId;
    if (!companyId) return;
    pool
      .query(
        `INSERT INTO api_activity_log (company_id, employee_id, api_key_id, method, path, status_code, ip)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [companyId, req.auth.employeeId || null, req.auth.apiKeyId || null, req.method, req.originalUrl, res.statusCode, req.ip]
      )
      .catch(() => {});
  });
  next();
});

app.get('/api/health', (req, res) => res.json({ status: 'ok', time: new Date().toISOString() }));

app.get('/api/guide', (req, res) => res.sendFile(path.join(__dirname, 'docs', 'guide.html')));
app.use('/api/docs', swaggerUi.serve, swaggerUi.setup(openapiSpec));
app.get('/api/openapi.json', (req, res) => res.json(openapiSpec));

app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/projects', projectRoutes);
app.use('/api/time-entries', timeEntryRoutes);
app.use('/api/api-keys', apiKeyRoutes);
app.use('/api/webhooks', webhookRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/tickets', ticketRoutes);
app.use('/api/edit-requests', editRequestRoutes);
app.use('/api/signup', signupRoutes);
app.use('/api/client-fields', clientFieldRoutes);
app.use('/api', clientIntakeRoutes);
app.use('/api/notification-settings', notificationSettingsRoutes);
app.use('/api/owner/guides', ownerGuideRoutes);
app.use('/api/guides', guideRoutes);
app.use('/api/employee-fields', employeeFieldRoutes);
app.use('/api', employeeIntakeRoutes);
app.use('/api/branding', brandingRoutes);
app.use('/api/owner/changelog', ownerChangelogRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/owner/notifications', ownerNotificationRoutes);
app.use('/api/owner/auth', ownerAuthRoutes);
app.use('/api/owner/companies', ownerCompanyRoutes);
app.use('/api/owner/tickets', ownerTicketRoutes);
app.use('/api', adminSignupLinkRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/owner/api-keys', ownerApiKeyRoutes);
app.use('/api/dashboard-widgets', dashboardWidgetRoutes);
app.use('/api/owner/email', ownerEmailRoutes);

app.use((req, res) => res.status(404).json({ error: 'not_found', message: `No route: ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error', message: 'Something went wrong on the server.' });
});

const port = process.env.PORT || 3001;
app.listen(port, () => console.log(`TreeTime API listening on :${port}`));
