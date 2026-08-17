const pool = require('../db/pool');

// Allowlist-based query builder for admin-defined KPIs. Every field, filter,
// and table name a config can reference comes from this list -- nothing from
// the request body ever reaches SQL as a raw identifier, only as a bound
// parameter value. company_id scoping is always added here, never left up
// to the config, so a KPI can never read another company's data.
const DATA_SOURCES = {
  time_entries: {
    table: 'time_entries',
    baseWhere: 'ended_at IS NOT NULL',
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

const AGGREGATIONS = ['sum', 'avg', 'count', 'min', 'max'];

class ValidationError extends Error {}

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

async function evaluateKpi(companyId, config) {
  const source = validateConfig(config);
  const { aggregation, field, filters = {} } = config;

  const params = [companyId];
  const whereClauses = ['company_id = $1'];
  if (source.baseWhere) whereClauses.push(source.baseWhere);

  for (const [key, value] of Object.entries(filters)) {
    if (value === undefined || value === null || value === '') continue;
    const f = source.filters[key];
    params.push(value);
    whereClauses.push(`${f.column} ${f.op} $${params.length}`);
  }

  const selectExpr = aggregation === 'count' ? 'COUNT(*)' : `${aggregation.toUpperCase()}(${source.numericFields[field]})`;
  const sql = `SELECT ${selectExpr} AS value FROM ${source.table} WHERE ${whereClauses.join(' AND ')}`;
  const { rows } = await pool.query(sql, params);
  return Number(rows[0].value) || 0;
}

// Metadata for the KPI builder UI -- what a client is allowed to offer as choices.
function listDataSources() {
  return Object.fromEntries(
    Object.entries(DATA_SOURCES).map(([key, s]) => [
      key,
      { numericFields: Object.keys(s.numericFields), filters: Object.keys(s.filters) },
    ])
  );
}

module.exports = { evaluateKpi, validateConfig, listDataSources, ValidationError, AGGREGATIONS };
