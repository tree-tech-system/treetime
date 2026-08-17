const pool = require('../db/pool');

async function notifyOwners(type, title, body, link_page) {
  await pool.query(
    `INSERT INTO notifications (scope, type, title, body, link_page) VALUES ('owner',$1,$2,$3,$4)`,
    [type, title, body || null, link_page || null]
  ).catch(() => {});
}

async function notifyAdmins(companyId, type, title, body, link_page) {
  await pool.query(
    `INSERT INTO notifications (scope, company_id, type, title, body, link_page) VALUES ('admin',$1,$2,$3,$4,$5)`,
    [companyId, type, title, body || null, link_page || null]
  ).catch(() => {});
}

async function notifyEmployee(employeeId, type, title, body, link_page) {
  await pool.query(
    `INSERT INTO notifications (scope, employee_id, type, title, body, link_page) VALUES ('employee',$1,$2,$3,$4,$5)`,
    [employeeId, type, title, body || null, link_page || null]
  ).catch(() => {});
}

module.exports = { notifyOwners, notifyAdmins, notifyEmployee };
