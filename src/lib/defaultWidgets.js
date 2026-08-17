// The dashboard cards every company used to get hardcoded in the frontend --
// now just the starting set of ordinary, editable/removable dashboard_widgets
// rows, seeded once per company. Existing companies were backfilled by
// migration 023; this seeds the same set for every company created from here on.
const DEFAULT_WIDGETS = [
  { type: 'kpi', title: 'עובדים פעילים החודש', config: { data_source: 'employees_activity', filters: {} } },
  { type: 'kpi', title: 'לקוחות מעל 80% מכסה', config: { data_source: 'clients_usage', filters: { threshold_pct: 80 } } },
  { type: 'kpi', title: 'שעונים פתוחים כרגע', config: { data_source: 'time_entries', aggregation: 'count', filters: { status: 'open' } } },
  { type: 'kpi', title: 'סה״כ שעות החודש', config: { data_source: 'time_entries', aggregation: 'sum', field: 'duration_hours', filters: { date_from: 'this_month_start', date_to: 'today' } } },
  { type: 'list', title: 'מכסת שעות ללקוח', config: { source: 'clients_usage', filters: {} } },
  { type: 'list', title: 'פעילות עובדים', config: { source: 'employees_activity', filters: {} } },
  { type: 'list', title: 'דיווחים אחרונים', config: { source: 'time_entries', filters: {} } },
];

async function seedDefaultWidgets(dbClient, companyId) {
  for (let i = 0; i < DEFAULT_WIDGETS.length; i++) {
    const w = DEFAULT_WIDGETS[i];
    await dbClient.query(
      `INSERT INTO dashboard_widgets (company_id, type, title, config, position) VALUES ($1,$2,$3,$4,$5)`,
      [companyId, w.type, w.title, w.config, i]
    );
  }
}

module.exports = { DEFAULT_WIDGETS, seedDefaultWidgets };
