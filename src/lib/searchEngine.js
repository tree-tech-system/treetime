// Generic, safe search across a fixed set of TreeTime "areas" (entities), built for the
// Make.com integration's search module (see routes/search.js). Same safety spirit as
// kpiEngine.js: every table/column/operator a caller can touch comes from the allowlists
// below, never from raw request input -- request data only ever reaches SQL through a
// parameterized $N. company_id is always injected server-side from req.auth, never from
// the request body, so no entity here can be made to cross companies.
//
// Only today's real, existing resources are listed. Adding a new searchable area later is
// a small addition here, not a redesign -- deliberately not trying to guess what future
// areas might exist.

const ENTITIES = {
  clients: {
    label: 'לקוחות',
    table: 'projects',
    orderBy: 'created_at DESC',
    fields: {
      id: { label: 'מזהה (ID)', column: 'id', type: 'number' },
      name: { label: 'שם', column: 'name', type: 'text' },
      business_name: { label: 'שם עסק', column: 'business_name', type: 'text' },
      email: { label: 'אימייל', column: 'contact_email', type: 'text' },
      phone: { label: 'טלפון', column: 'contact_phone', type: 'text' },
      archived: { label: 'בארכיון', column: 'archived', type: 'boolean' },
    },
  },
  employees: {
    label: 'עובדים',
    table: 'employees',
    orderBy: 'created_at DESC',
    fields: {
      id: { label: 'מזהה (ID)', column: 'id', type: 'number' },
      full_name: { label: 'שם', column: 'full_name', type: 'text' },
      email: { label: 'אימייל', column: 'email', type: 'text' },
      phone: { label: 'טלפון', column: 'phone', type: 'text' },
      role: { label: 'תפקיד', column: 'role', type: 'text' },
      active: { label: 'פעיל', column: 'active', type: 'boolean' },
    },
  },
  time_entries: {
    label: 'דיווחי עבודה',
    table: 'time_entries',
    orderBy: 'started_at DESC',
    fields: {
      id: { label: 'מזהה (ID)', column: 'id', type: 'number' },
      employee_id: { label: 'עובד (ID)', column: 'employee_id', type: 'number' },
      project_id: { label: 'לקוח (ID)', column: 'project_id', type: 'number' },
      task_id: { label: 'משימה (ID)', column: 'task_id', type: 'number' },
      description: { label: 'תיאור', column: 'description', type: 'text' },
      started_at: { label: 'התחלה', column: 'started_at', type: 'date' },
      ended_at: { label: 'סיום', column: 'ended_at', type: 'date' },
    },
  },
  tasks: {
    label: 'משימות',
    table: 'tasks',
    orderBy: 'created_at DESC',
    fields: {
      id: { label: 'מזהה (ID)', column: 'id', type: 'number' },
      description: { label: 'תיאור', column: 'description', type: 'text' },
      status: { label: 'סטטוס', column: 'status', type: 'text' },
      deadline: { label: 'דדליין', column: 'deadline', type: 'date' },
      project_id: { label: 'לקוח (ID)', column: 'project_id', type: 'number' },
      employee_id: { label: 'עובד (ID)', column: 'employee_id', type: 'number' },
    },
  },
  edit_requests: {
    label: 'בקשות עריכה',
    table: 'edit_requests',
    orderBy: 'requested_at DESC',
    fields: {
      id: { label: 'מזהה (ID)', column: 'id', type: 'number' },
      employee_id: { label: 'עובד (ID)', column: 'employee_id', type: 'number' },
      entry_id: { label: 'דיווח (ID)', column: 'entry_id', type: 'number' },
      status: { label: 'סטטוס', column: 'status', type: 'text' },
      reason: { label: 'סיבה', column: 'reason', type: 'text' },
    },
  },
  tickets: {
    label: 'פניות תמיכה',
    table: 'support_tickets',
    orderBy: 'updated_at DESC',
    fields: {
      id: { label: 'מזהה (ID)', column: 'id', type: 'number' },
      employee_id: { label: 'עובד (ID)', column: 'employee_id', type: 'number' },
      subject: { label: 'נושא', column: 'subject', type: 'text' },
      status: { label: 'סטטוס', column: 'status', type: 'text' },
      priority: { label: 'עדיפות', column: 'priority', type: 'text' },
    },
  },
};

// Which comparisons are valid per field type, and the SQL each maps to.
// 'contains' is handled specially in buildWhereClause (wraps the value in %...%).
const OPERATORS_BY_TYPE = {
  text: { equals: '=', not_equals: '<>', contains: 'ILIKE' },
  number: { equals: '=', not_equals: '<>', gt: '>', gte: '>=', lt: '<', lte: '<=' },
  date: { equals: '=', gt: '>', gte: '>=', lt: '<', lte: '<=' },
  boolean: { equals: '=' },
};

function listEntities() {
  return Object.entries(ENTITIES).map(([key, e]) => ({ key, label: e.label }));
}

function listFields(entityKey) {
  const entity = ENTITIES[entityKey];
  if (!entity) return null;
  return Object.entries(entity.fields).map(([key, f]) => ({
    key, label: f.label, type: f.type, operators: Object.keys(OPERATORS_BY_TYPE[f.type]),
  }));
}

// Builds a parameterized WHERE fragment (without "WHERE", company_id excluded --
// callers always AND that in separately as the very first, hardcoded condition) from a
// flat list of {field, operator, value, connector} conditions, evaluated strictly
// left-to-right (each new condition parenthesizes around everything before it) so the
// result matches what a user visually building an AND/OR list would expect, regardless
// of SQL's normal AND-before-OR precedence.
function buildWhereClause(entityKey, conditions, paramsSoFar) {
  const entity = ENTITIES[entityKey];
  if (!entity) throw new Error(`unknown_entity:${entityKey}`);

  const params = paramsSoFar.slice();
  let sql = null;
  for (const cond of conditions || []) {
    const fieldDef = entity.fields[cond.field];
    if (!fieldDef) throw new Error(`unknown_field:${cond.field}`);
    const opMap = OPERATORS_BY_TYPE[fieldDef.type];
    const sqlOp = opMap[cond.operator];
    if (!sqlOp) throw new Error(`unknown_operator:${cond.operator}`);

    params.push(cond.operator === 'contains' ? `%${cond.value}%` : cond.value);
    const fragment = `${fieldDef.column} ${sqlOp} $${params.length}`;
    const connector = cond.connector === 'OR' ? 'OR' : 'AND'; // ignored for the first condition
    sql = sql === null ? `(${fragment})` : `(${sql} ${connector} ${fragment})`;
  }
  return { sql, params };
}

// `limit` is assumed already validated to be an integer in [1, 200] by the route (express-
// validator) before this runs -- not re-clamped here, so there's exactly one place that
// decides what an out-of-range limit means (a rejected request, not a silently adjusted one).
async function runSearch(pool, entityKey, companyId, conditions, limit) {
  const entity = ENTITIES[entityKey];
  if (!entity) throw new Error(`unknown_entity:${entityKey}`);

  const { sql: extraWhere, params } = buildWhereClause(entityKey, conditions, [companyId]);
  const where = extraWhere ? `company_id = $1 AND ${extraWhere}` : 'company_id = $1';
  const { rows } = await pool.query(
    `SELECT * FROM ${entity.table} WHERE ${where} ORDER BY ${entity.orderBy} LIMIT ${limit || 50}`,
    params
  );
  return rows;
}

module.exports = { ENTITIES, OPERATORS_BY_TYPE, listEntities, listFields, buildWhereClause, runSearch };
