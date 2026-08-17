require('dotenv').config();
const pool = require('../src/db/pool');
const { generateSlug } = require('../src/lib/slug');

async function main() {
  const { rows } = await pool.query('SELECT id FROM companies WHERE slug IS NULL');
  for (const row of rows) {
    let slug;
    for (let attempt = 0; attempt < 5; attempt++) {
      slug = generateSlug();
      const exists = await pool.query('SELECT 1 FROM companies WHERE slug = $1', [slug]);
      if (!exists.rows.length) break;
    }
    await pool.query('UPDATE companies SET slug = $1 WHERE id = $2', [slug, row.id]);
    console.log(`company ${row.id} -> ${slug}`);
  }
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
