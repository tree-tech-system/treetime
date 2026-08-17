const pool = require('../db/pool');

// Allowlist-based query builder for admin-defined KPIs. Every field, filter,
// and table name a config can reference comes from this list -- nothing from
// the request body ever reaches SQL as a raw identifier, only as a bound
// parameter value. company_id scoping is always added here, never left up
// to the config, so a KPI can never read another company's data.
const DATA_SOURCES = {
  time_entries: {
    table: 'time_entries',
    baseWhere: 'ended_at IS NOT NULL', // default when no explicit status filter is given
    numericFields: {
      duration_hours: 'EXTRACT(EPOCH FROM (ended_at - started_at)) / 3600.0',
      cost: 'cost',
    },
    filters: {
      date_from: { column: 'started_at', op: '>=' },
      date_to: { column: 'started_at', op: '<=' },
      employee_id: { column: 'employee_id', op: '=' },
      project_id: { column: 'project_id', op: '=' },
      task_id: { column: 'task_id', op: '=' },
      status: { special: 'time_entry_status' }, // open | completed | all -- overrides baseWhere
    },
  },
  projects: {
    table: 'projects',
    numericFields: {
      monthly_quota_hours: 'monthly_quota_hours',
      hourly_rate: 'hourly_rate',
    },
    filters: {
      date_from: { column: 'created_at', op: '>=' },
      date_to: { column: 'created_at', op: '<=' },
      payment_method: { column: 'payment_method', op: '=' },
    },
  },
  employees: {
    table: 'employees',
    numericFields: {
      hourly_rate: 'hourly_rate',
    },
    filters: {
      date_from: { column: 'created_at', op: '>=' },
      date_to: { column: 'created_at', op: '<=' },
      role: { column: 'role', op: '=' },
      active: { column: 'active', op: '=' },
    },
  },
  tasks: {
    table: 'tasks',
    numericFields: {},
    filters: {
      date_from: { column: 'deadline', op: '>=' },
      date_to: { column: 'deadline', op: '<=' },
      status: { column: 'status', op: '=' },
      employee_id: { column: 'employee_id', op: '=' },
      project_id: { column: 'project_id', op: '=' },
    },
  },
};

// Sources handled outside the generic single-table builder above -- they roll
// up time_entries per client/employee and compare the result to a field on
// that same row (quota %, "has logged any hours"), which a flat WHERE can't
// express. Still fully parameterized, just hand-written per source instead
// of forced through the generic abstraction for two concrete cases.
const RELATION_SOURCES = ['clients_usage', 'employees_activity'];

const AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max'];
const TIME_ENTRY_STATUSES = ['open', 'completed', 'all'];

class ValidationError extends Error {}

// date_from/date_to accept either a literal ISO date or one of these -- resolved
// fresh on every call so a seeded "this month" widget never goes stale.
function resolveDateValue(v) {
  if (v === 'this_month_start') {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
  }
  if (v === 'today' || v === 'now') return new Date().toISOString().slice(0, 10);
  return v;
}

function validateConfig(config) {
  const { data_source, aggregation, field, filters } = config || {};
  const source = DATA_SOURCES[data_source];
  if (!source) throw new ValidationError(`Unknown data_source: ${data_source}`);
  if (!AGGREGATIONS.includes(aggregation)) throw new ValidationError(`Unknown aggregation: ${aggregation}`);
  if (aggregation !== 'count' && !source.numericFields[field]) {
    throw new ValidationError(`"${field}" is not a valid numeric field for ${data_source}`);
  }
  for (const key of Object.keys(filters || {})) {
    if (!source.filters[key]) throw new ValidationError(`Unknown filter for ${data_source}: ${key}`);
  }
  return source;
}

async function evaluateSimpleKpi(companyId, config) {
  const source = validateConfig(config);
  const { aggregation, field, filters = {} } = config;

  const params = [companyId];
  const filterClauses = [];
  let statusOverride = false;

  for (const [key, rawValue] of Object.entries(filters)) {
    if (rawValue === undefined || rawValue === null || rawValue === '') continue;
    const f = source.filters[key];
    if (f.special === 'time_entry_status') {
      statusOverride = true;
      if (!TIME_ENTRY_STATUSES.includes(rawValue)) throw new ValidationError(`Invalid status filter value: ${rawValue}`);
      if (rawValue === 'open') filterClauses.push('ended_at IS NULL');
      else if (rawValue === 'completed') filterClauses.push('ended_at IS NOT NULL');
      continue;
    }
    const value = (key === 'date_from' || key === 'date_to') ? resolveDateValue(rawValue) : rawValue;
    params.push(value);
    filterClauses.push(`${f.column} ${f.op} $${params.length}`);
  }

  const whereClauses = ['company_id = $1'];
  if (source.baseWhere && !statusOverride) whereClauses.push(source.baseWhere);
  whereClauses.push(...filterClauses);

  const selectExpr = aggregation === 'count' ? 'COUNT(*)' : `${aggregation.toUpperCase()}(${source.numericFields[field]})`;
  const sql = `SELECT ${selectExpr} AS value FROM ${source.table} WHERE ${whereClauses.join(' AND ')}`;
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].value) || 0;
}

// Per-client hours logged (within the date window) vs. their monthly_quota_hours,
// for clients that actually use an hours-bank quota. Used both for the "N clients
// over X%" KPI and the "quota usage" list widget.
async function evaluateClientsUsage(companyId, { dateFrom, dateTo } = {}) {
  const from = resolveDateValue(dateFrom || 'this_month_start');
  const to = resolveDateValue(dateTo || 'today');
  const { rows } = await pool.query(
    `SELECT p.id, p.name, p.business_name, p.monthly_quota_hours,
       COALESCE(SUM(
         CASE WHEN te.ended_at IS NOT NULL AND te.started_at >= $2 AND te.started_at <= $3
              THEN EXTRACT(EPOCH FROM (te.ended_at - te.started_at)) / 3600.0 ELSE 0 END
       ), 0) AS hours_logged
     FROM projects p
     LEFT JOIN time_entries te ON te.project_id = p.id AND te.company_id = p.company_id
     WHERE p.company_id = $1 AND p.use_hours_bank = TRUE AND p.monthly_quota_hours > 0
     GROUP BY p.id, p.name, p.business_name, p.monthly_quota_hours
     ORDER BY p.name`,
    [companyId, from, to]
  );
  return rows.map((r) => {
    const quota = Number(r.monthly_quota_hours);
    const hours = Number(r.hours_logged);
    return {
      id: r.id,
      name: r.business_name || r.name,
      monthly_quota_hours: quota,
      hours_logged: hours,
      pct: quota > 0 ? (hours / quota) * 100 : 0,
    };
  });
}

// Per-employee hours logged (within the date window) + their most recent
// completed entry. Used both for the "N active employees" KPI and the
// "employee activity" list widget.
async function evaluateEmployeesActivity(companyId, { dateFrom, dateTo } = {}) {
  const from = resolveDateValue(dateFrom || 'this_month_start');
  const to = resolveDateValue(dateTo || 'today');
  const { rows } = await pool.query(
    `SELECT e.id, e.full_name,
       COALESCE(SUM(
         CASE WHEN te.ended_at IS NOT NULL AND te.started_at >= $2 AND te.started_at <= $3
              THEN EXTRACT(EPOCH FROM (te.ended_at - te.started_at)) / 3600.0 ELSE 0 END
       ), 0) AS hours_logged,
       MAX(te.started_at) FILTER (WHERE te.ended_at IS NOT NULL) AS last_entry_at
     FROM employees e
     LEFT JOIN time_entries te ON te.employee_id = e.id AND te.company_id = e.company_id
     WHERE e.company_id = $1 AND e.active = TRUE
     GROUP BY e.id, e.full_name
     ORDER BY e.full_name`,
    [companyId, from, to]
  );
  return rows.map((r) => ({ id: r.id, name: r.full_name, hours_logged: Number(r.hours_logged), last_entry_at: r.last_entry_at }));
}

async function evaluateKpi(companyId, config) {
  const { data_source, filters = {} } = config || {};

  if (data_source === 'clients_usage') {
    const threshold = Number(filters.threshold_pct);
    if (!Number.isFinite(threshold)) throw new ValidationError('threshold_pct is required for clients_usage');
    const rows = await evaluateClientsUsage(companyId, { dateFrom: filters.date_from, dateTo: filters.date_to });
    return rows.filter((r) => r.pct >= threshold).length;
  }
  if (data_source === 'employees_activity') {
    const minHours = filters.min_hours !== undefined && filters.min_hours !== '' ? Number(filters.min_hours) : 0;
    const rows = await evaluateEmployeesActivity(companyId, { dateFrom: filters.date_from, dateTo: filters.date_to });
    return rows.filter((r) => r.hours_logged > minHours).length;
  }
  return evaluateSimpleKpi(companyId, config);
}

// Metadata for the KPI builder UI -- what a client is allowed to offer as choices.
function listDataSources() {
  const simple = Object.fromEntries(
    Object.entries(DATA_SOURCES).map(([key, s]) => [
      key,
      { numericFields: Object.keys(s.numericFields), filters: Object.keys(s.filters) },
    ])
  );
  return { ...simple, clients_usage: { relation: true }, employees_activity: { relation: true } };
}

module.exports = {
  evaluateKpi,
  evaluateClientsUsage,
  evaluateEmployeesActivity,
  validateConfig,
  listDataSources,
  resolveDateValue,
  ValidationError,
  AGGREGATIONS,
  RELATION_SOURCES,
};
