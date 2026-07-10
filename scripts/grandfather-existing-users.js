// One-time migration: grandfather every user that exists before Phase 3
// (billing) ships onto the 'pro' plan, so no live poll gets retroactively
// capped by the new free-tier limit. Safe to re-run.
//
// Usage:
//   DATABASE_URL=postgres://localhost:5432/... node scripts/grandfather-existing-users.js

const { Pool } = require('pg');

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('DATABASE_URL env var is required.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

async function main() {
  const res = await pool.query(
    `UPDATE users SET plan = 'pro' WHERE plan != 'pro' RETURNING id, email`
  );
  console.log(`Grandfathered ${res.rows.length} user(s) onto the pro plan:`);
  for (const row of res.rows) console.log(`  ✓ ${row.id} — ${row.email}`);
  await pool.end();
}

main().catch(e => {
  console.error('Grandfathering failed:', e);
  process.exit(1);
});
