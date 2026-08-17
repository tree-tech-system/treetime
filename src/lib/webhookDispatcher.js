const crypto = require('crypto');
const pool = require('../db/pool');

// Fires an event to all active webhooks subscribed to it. Fire-and-forget,
// does not block the API response; delivery attempts are logged either way.
async function dispatchEvent(event, payload) {
  const { rows: hooks } = await pool.query(
    'SELECT * FROM webhooks WHERE active = TRUE AND $1 = ANY(events)',
    [event]
  );

  for (const hook of hooks) {
    const body = JSON.stringify({ event, data: payload, sent_at: new Date().toISOString() });
    const signature = crypto.createHmac('sha256', hook.secret).update(body).digest('hex');

    fetch(hook.target_url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-TreeTime-Event': event,
        'X-TreeTime-Signature': `sha256=${signature}`,
      },
      body,
      signal: AbortSignal.timeout(8000),
    })
      .then((r) =>
        pool.query(
          'INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, success) VALUES ($1,$2,$3,$4,$5)',
          [hook.id, event, payload, r.status, r.ok]
        )
      )
      .catch((err) =>
        pool.query(
          'INSERT INTO webhook_deliveries (webhook_id, event, payload, status_code, success) VALUES ($1,$2,$3,$4,$5)',
          [hook.id, event, payload, null, false]
        ).catch(() => {})
      );
  }
}

module.exports = { dispatchEvent };
