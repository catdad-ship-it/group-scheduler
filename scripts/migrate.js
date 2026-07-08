// One-time migration: polls.json -> Postgres.
// Run locally only, against a tunneled DATABASE_URL and a fetched JSON snapshot.
// Safe to re-run any number of times — every insert is an upsert keyed on the
// same natural keys the app uses (poll id, poll_id+slot_key, poll_id+name_lower).
//
// Usage:
//   DATABASE_URL=postgres://localhost:5432/... OWNER_EMAIL=you@example.com \
//     node scripts/migrate.js ./polls-live-snapshot.json

const fs = require('fs');
const { Pool } = require('pg');

const SOURCE_JSON  = process.argv[2];
const OWNER_EMAIL  = process.env.OWNER_EMAIL;
const DATABASE_URL = process.env.DATABASE_URL;

if (!SOURCE_JSON) {
  console.error('Usage: DATABASE_URL=... OWNER_EMAIL=... node scripts/migrate.js <path-to-polls.json>');
  process.exit(1);
}
if (!OWNER_EMAIL) {
  console.error('OWNER_EMAIL env var is required — every existing poll is assigned to this account.');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL env var is required.');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

function defaultPoll(raw) {
  return {
    id: raw.id,
    type: raw.type || 'schedule',
    title: raw.title,
    creatorName: raw.creatorName || '',
    description: raw.description || '',
    createdAt: raw.createdAt ? new Date(raw.createdAt) : new Date(),
    deadline: raw.deadline ?? null,
    expectedVoters: Array.isArray(raw.expectedVoters) ? raw.expectedVoters : [],
    confirmedSlot: raw.confirmedSlot ?? null,
    slots: Array.isArray(raw.slots) ? raw.slots : [],
    votes: Array.isArray(raw.votes) ? raw.votes : []
  };
}

async function findOrCreateOwner(client, email) {
  const res = await client.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id`,
    [email.trim().toLowerCase()]
  );
  return res.rows[0].id;
}

async function migratePoll(client, poll, ownerId) {
  await client.query('BEGIN');
  try {
    await client.query(
      `INSERT INTO polls (id, owner_id, type, title, creator_name, description, created_at, deadline, expected_voters, confirmed_slot)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (id) DO UPDATE SET
         owner_id = EXCLUDED.owner_id, type = EXCLUDED.type, title = EXCLUDED.title,
         creator_name = EXCLUDED.creator_name, description = EXCLUDED.description,
         created_at = EXCLUDED.created_at, deadline = EXCLUDED.deadline,
         expected_voters = EXCLUDED.expected_voters, confirmed_slot = EXCLUDED.confirmed_slot`,
      [poll.id, ownerId, poll.type, poll.title, poll.creatorName, poll.description,
       poll.createdAt, poll.deadline, poll.expectedVoters, poll.confirmedSlot]
    );

    for (let i = 0; i < poll.slots.length; i++) {
      const s = poll.slots[i];
      await client.query(
        `INSERT INTO slots (poll_id, slot_key, datetime, end_datetime, label, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (poll_id, slot_key) DO UPDATE SET
           datetime = EXCLUDED.datetime, end_datetime = EXCLUDED.end_datetime,
           label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
        [poll.id, s.id, s.datetime ?? null, s.endDatetime ?? null, s.label ?? null, i]
      );
    }

    for (const v of poll.votes) {
      await client.query(
        `INSERT INTO votes (poll_id, name, timezone, responses, submitted_at)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (poll_id, name_lower) DO UPDATE SET
           name = EXCLUDED.name, timezone = EXCLUDED.timezone,
           responses = EXCLUDED.responses, submitted_at = EXCLUDED.submitted_at`,
        [poll.id, v.name, v.timezone, JSON.stringify(v.responses || {}), v.submittedAt ? new Date(v.submittedAt) : new Date()]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  }
}

async function main() {
  const raw = JSON.parse(fs.readFileSync(SOURCE_JSON, 'utf8'));
  const polls = Object.values(raw).map(defaultPoll);

  const jsonCounts = {
    polls: polls.length,
    slots: polls.reduce((n, p) => n + p.slots.length, 0),
    votes: polls.reduce((n, p) => n + p.votes.length, 0)
  };

  const client = await pool.connect();
  const ownerId = await findOrCreateOwner(client, OWNER_EMAIL);
  console.log(`Owner: ${OWNER_EMAIL} (id ${ownerId})`);
  console.log(`Source JSON: ${polls.length} polls, ${jsonCounts.slots} slots, ${jsonCounts.votes} votes\n`);

  let failures = 0;
  for (const poll of polls) {
    try {
      await migratePoll(client, poll, ownerId);
      console.log(`  ✓ ${poll.id} — "${poll.title}"`);
    } catch (e) {
      failures++;
      console.error(`  ✗ ${poll.id} — "${poll.title}": ${e.message}`);
    }
  }

  const dbCounts = await client.query(`
    SELECT
      (SELECT COUNT(*) FROM polls)::int AS polls,
      (SELECT COUNT(*) FROM slots)::int AS slots,
      (SELECT COUNT(*) FROM votes)::int AS votes
  `);

  console.log('\n── Verification ──');
  console.log('Source JSON counts:', jsonCounts);
  console.log('Database counts:   ', dbCounts.rows[0]);
  console.log(`Failures: ${failures}`);

  const sampleIds = [...new Set([
    polls[0]?.id,
    polls[polls.length - 1]?.id,
    [...polls].sort((a, b) => b.votes.length - a.votes.length)[0]?.id
  ].filter(Boolean))];

  for (const id of sampleIds) {
    const pollRes = await client.query('SELECT * FROM polls WHERE id = $1', [id]);
    const slotsRes = await client.query('SELECT * FROM slots WHERE poll_id = $1 ORDER BY sort_order', [id]);
    const votesRes = await client.query('SELECT * FROM votes WHERE poll_id = $1 ORDER BY submitted_at', [id]);
    console.log(`\n── Spot check: ${id} ──`);
    console.log(JSON.stringify({ poll: pollRes.rows[0], slots: slotsRes.rows, votes: votesRes.rows }, null, 2));
  }

  client.release();
  await pool.end();

  if (failures > 0) {
    console.error(`\n${failures} poll(s) failed to migrate — do not proceed to cutover until this is 0.`);
    process.exit(1);
  }
}

main().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
