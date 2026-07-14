// One-time script to copy any existing districts.json data into the new
// Postgres districts table. Safe to run more than once (uses ON CONFLICT).
//
// Run this AFTER you've added the Postgres plugin and deployed the new
// server.js, using the Railway CLI:
//
//   railway run node migrate.js
//
// It reads districts.json from the project root, so run it from a shell
// that has that file present (i.e. the deployed container, via Railway CLI).

const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('ERROR: DATABASE_URL not set. Run this with `railway run node migrate.js`.');
  process.exit(1);
}

const isInternalDb = DATABASE_URL.includes('.railway.internal');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: isInternalDb ? false : { rejectUnauthorized: false }
});

async function main() {
  const dataFile = path.join(__dirname, 'districts.json');
  if (!fs.existsSync(dataFile)) {
    console.log('No districts.json found — nothing to migrate.');
    return;
  }

  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const districts = Object.values(raw);

  if (districts.length === 0) {
    console.log('districts.json is empty — nothing to migrate.');
    return;
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS districts (
      id SERIAL PRIMARY KEY,
      domain TEXT UNIQUE NOT NULL,
      district_name TEXT NOT NULL,
      contact_name TEXT,
      contact_email TEXT,
      sites INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending_invoice',
      stripe_session_id TEXT,
      amount_paid INTEGER,
      total_due NUMERIC,
      requested_at TIMESTAMPTZ,
      activated_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  let migrated = 0;
  for (const d of districts) {
    if (!d.domain || !d.districtName) {
      console.log('Skipping record with missing domain/districtName:', d);
      continue;
    }
    await pool.query(`
      INSERT INTO districts (domain, district_name, contact_name, contact_email, sites, status, stripe_session_id, amount_paid, total_due, requested_at, activated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (domain) DO NOTHING
    `, [
      d.domain,
      d.districtName,
      d.contactName || null,
      d.contactEmail || null,
      d.sites || 1,
      d.status || 'pending_invoice',
      d.stripeSessionId || null,
      d.amountPaid || null,
      d.totalDue || null,
      d.requestedAt || null,
      d.activatedAt || null,
    ]);
    migrated++;
    console.log('Migrated:', d.districtName, d.domain);
  }

  console.log(`Done. Migrated ${migrated} district(s).`);
  await pool.end();
}

main().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
