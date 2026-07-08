const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');

const app = express();
app.set('trust proxy', true);
const PORT = process.env.PORT || 3000;

const DATABASE_URL = process.env.DATABASE_URL || 'postgres://localhost:5432/group_scheduler_dev';
if (!process.env.DATABASE_URL) {
  console.warn('⚠️  WARNING: DATABASE_URL env var not set. Using local dev default.');
}
const pool = new Pool({ connectionString: DATABASE_URL });

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'dev-insecure-secret-do-not-use-in-prod';
if (!process.env.JWT_SECRET) {
  console.warn('⚠️  WARNING: JWT_SECRET env var not set. Using an insecure default.');
}

const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAGIC_LINK_TTL_MS = 15 * 60 * 1000; // 15 minutes
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function getSessionUser(req) {
  const token = getCookie(req, 'session');
  if (!token) return null;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return { id: payload.uid, email: payload.email };
  } catch {
    return null;
  }
}

function setSessionCookie(res, user) {
  const token = jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: SESSION_MAX_AGE_SECONDS });
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  res.setHeader('Set-Cookie', `session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`);
}

function clearSessionCookie(res) {
  res.setHeader('Set-Cookie', 'session=; Path=/; HttpOnly; Max-Age=0');
}

async function sendMagicLinkEmail(email, link) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`\n🔗 Magic link for ${email}:\n${link}\n`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Huddle <onboarding@resend.dev>',
      to: email,
      subject: 'Your Huddle login link',
      html: `<p>Click the link below to log in to Huddle:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

const magicLinkAttempts = new Map(); // ip → { count, resetAt }
const RATE_LIMIT  = 10;
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkRateLimit(store, key, limit, windowMs) {
  const now    = Date.now();
  const record = store.get(key) || { count: 0, resetAt: now + windowMs };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + windowMs; }
  record.count++;
  store.set(key, record);
  return record.count <= limit;
}

function generateToken() {
  return crypto.randomBytes(32).toString('hex');
}

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

function clientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
}

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB HELPERS ──────────────────────────────────────────────────────────────

function serializePoll(poll, slots, votes) {
  return {
    id: poll.id,
    type: poll.type,
    title: poll.title,
    creatorName: poll.creator_name,
    description: poll.description,
    createdAt: poll.created_at.toISOString(),
    deadline: poll.deadline !== null ? Number(poll.deadline) : null,
    expectedVoters: poll.expected_voters,
    confirmedSlot: poll.confirmed_slot,
    slots: slots.map(s => {
      const slot = { id: s.slot_key };
      if (s.datetime !== null) slot.datetime = Number(s.datetime);
      if (s.end_datetime !== null) slot.endDatetime = Number(s.end_datetime);
      if (s.label !== null) slot.label = s.label;
      return slot;
    }),
    votes: votes.map(v => ({
      name: v.name,
      timezone: v.timezone,
      responses: v.responses,
      submittedAt: v.submitted_at.toISOString()
    }))
  };
}

async function loadPollById(id) {
  const pollRes = await pool.query('SELECT * FROM polls WHERE id = $1', [id]);
  const poll = pollRes.rows[0];
  if (!poll) return null;
  const [slotsRes, votesRes] = await Promise.all([
    pool.query('SELECT * FROM slots WHERE poll_id = $1 ORDER BY sort_order', [id]),
    pool.query('SELECT * FROM votes WHERE poll_id = $1 ORDER BY submitted_at', [id])
  ]);
  return serializePoll(poll, slotsRes.rows, votesRes.rows);
}

async function loadPollsByOwner(ownerId) {
  const pollsRes = await pool.query('SELECT * FROM polls WHERE owner_id = $1 ORDER BY created_at DESC', [ownerId]);
  const polls = [];
  for (const poll of pollsRes.rows) {
    const [slotsRes, votesRes] = await Promise.all([
      pool.query('SELECT * FROM slots WHERE poll_id = $1 ORDER BY sort_order', [poll.id]),
      pool.query('SELECT * FROM votes WHERE poll_id = $1 ORDER BY submitted_at', [poll.id])
    ]);
    polls.push(serializePoll(poll, slotsRes.rows, votesRes.rows));
  }
  return polls;
}

async function createPoll(poll, ownerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO polls (id, owner_id, type, title, creator_name, description, created_at, deadline, expected_voters)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [poll.id, ownerId, poll.type, poll.title, poll.creatorName, poll.description, new Date(poll.createdAt), poll.deadline, poll.expectedVoters]
    );
    for (let i = 0; i < poll.slots.length; i++) {
      const s = poll.slots[i];
      await client.query(
        `INSERT INTO slots (poll_id, slot_key, datetime, end_datetime, label, sort_order) VALUES ($1,$2,$3,$4,$5,$6)`,
        [poll.id, s.id, s.datetime ?? null, s.endDatetime ?? null, s.label ?? null, i]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Request a magic login link
app.post('/api/auth/magic-link', async (req, res) => {
  if (!checkRateLimit(magicLinkAttempts, clientIp(req), RATE_LIMIT, RATE_WINDOW)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  const { email } = req.body;
  if (typeof email !== 'string' || email.length > 254 || !EMAIL_RE.test(email.trim())) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  const normalizedEmail = email.trim().toLowerCase();
  const token = generateToken();
  const expiresAt = new Date(Date.now() + MAGIC_LINK_TTL_MS);
  await pool.query('INSERT INTO magic_link_tokens (token, email, expires_at) VALUES ($1,$2,$3)', [token, normalizedEmail, expiresAt]);

  const link = `${req.protocol}://${req.get('host')}/api/auth/verify?token=${token}`;
  try {
    await sendMagicLinkEmail(normalizedEmail, link);
  } catch (e) {
    console.error('Failed to send magic link email:', e);
    return res.status(502).json({ error: 'Could not send the login email. Try again in a moment.' });
  }
  res.json({ success: true });
});

// Verify a magic link and start a session
app.get('/api/auth/verify', async (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || !token) return res.redirect('/?authError=invalid');

  const tokenRes = await pool.query(
    `UPDATE magic_link_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [token]
  );
  const row = tokenRes.rows[0];
  if (!row) return res.redirect('/?authError=expired');

  const userRes = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [row.email]
  );
  setSessionCookie(res, userRes.rows[0]);
  res.redirect('/dashboard?loggedIn=1');
});

// Logout
app.post('/api/logout', (req, res) => {
  clearSessionCookie(res);
  res.json({ success: true });
});

// Auth status
app.get('/api/auth-status', (req, res) => {
  const user = getSessionUser(req);
  res.json({ authenticated: !!user, email: user ? user.email : null });
});

// Admin: list the current user's polls
app.get('/api/admin/polls', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const polls = await loadPollsByOwner(user.id);
  res.json(polls);
});

// Create a new poll (requires an account)
app.post('/api/polls', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to create a poll.' });

  const { title, creatorName, description, slots, type, deadline, expectedVoters } = req.body;
  const VALID_TYPES = ['schedule', 'question', 'rsvp', 'availability'];
  const pollType = VALID_TYPES.includes(type) ? type : 'schedule';

  // Which types use datetime slots vs. text-label slots
  const DATETIME_TYPES = ['schedule', 'availability'];
  const usesDatetime   = DATETIME_TYPES.includes(pollType);
  const maxSlots       = pollType === 'availability' ? 400 : 30;

  if (!title || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (typeof title !== 'string' || title.trim().length > 200) {
    return res.status(400).json({ error: 'Title must be under 200 characters.' });
  }
  if (creatorName !== undefined && creatorName !== null &&
      (typeof creatorName !== 'string' || creatorName.trim().length > 100)) {
    return res.status(400).json({ error: 'Name must be under 100 characters.' });
  }
  if (description !== undefined && description !== null &&
      (typeof description !== 'string' || description.length > 500)) {
    return res.status(400).json({ error: 'Description must be under 500 characters.' });
  }
  if (slots.length > maxSlots) {
    return res.status(400).json({ error: `Too many slots (max ${maxSlots}).` });
  }

  // Validate slot payloads
  if (usesDatetime) {
    for (const s of slots) {
      if (!Number.isFinite(Number(s.datetime))) {
        return res.status(400).json({ error: 'Invalid slot datetime.' });
      }
      if (s.endDatetime !== undefined && s.endDatetime !== null) {
        if (!Number.isFinite(Number(s.endDatetime)) || Number(s.endDatetime) <= Number(s.datetime)) {
          return res.status(400).json({ error: 'Invalid slot end time.' });
        }
      }
    }
  } else {
    for (const s of slots) {
      if (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 200) {
        return res.status(400).json({ error: 'Invalid option label.' });
      }
    }
  }

  let deadlineMs = null;
  if (deadline !== undefined && deadline !== null && deadline !== '') {
    deadlineMs = Number(deadline);
    if (!Number.isFinite(deadlineMs)) {
      return res.status(400).json({ error: 'Invalid deadline.' });
    }
  }

  let expectedVotersArr = [];
  if (expectedVoters !== undefined) {
    if (!Array.isArray(expectedVoters)) {
      return res.status(400).json({ error: 'expectedVoters must be an array.' });
    }
    if (expectedVoters.length > 50) {
      return res.status(400).json({ error: 'Too many expected voters (max 50).' });
    }
    expectedVotersArr = expectedVoters
      .filter(n => typeof n === 'string' && n.trim())
      .map(n => n.trim().slice(0, 100));
  }

  const poll = {
    id: generateId(),
    type: pollType,
    title: title.trim(),
    creatorName: typeof creatorName === 'string' ? creatorName.trim() : '',
    description: typeof description === 'string' ? description.trim() : '',
    createdAt: new Date().toISOString(),
    deadline: deadlineMs,
    expectedVoters: expectedVotersArr,
    slots: usesDatetime
      ? slots.map((s, i) => {
          const slot = { id: `s${i}`, datetime: Number(s.datetime) };
          if (s.endDatetime !== undefined && s.endDatetime !== null) slot.endDatetime = Number(s.endDatetime);
          return slot;
        })
      : slots.map((s, i) => ({ id: `s${i}`, label: String(s.label).trim() }))
  };

  await createPoll(poll, user.id);
  res.json({ id: poll.id });
});

// Get a poll by ID (public — voting page)
app.get('/api/polls/:id', async (req, res) => {
  const poll = await loadPollById(req.params.id);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  res.json(poll);
});

// Submit a vote (public — voting stays anonymous)
app.post('/api/polls/:id/vote', async (req, res) => {
  const { name, timezone, responses } = req.body;

  if (!name || !timezone || !responses || typeof responses !== 'object' || Array.isArray(responses)) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (typeof name !== 'string' || name.trim().length === 0 || name.length > 100) {
    return res.status(400).json({ error: 'Invalid name.' });
  }
  if (typeof timezone !== 'string' || timezone.length > 80) {
    return res.status(400).json({ error: 'Invalid timezone.' });
  }

  const pollRes = await pool.query('SELECT id, type, deadline FROM polls WHERE id = $1', [req.params.id]);
  const poll = pollRes.rows[0];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  if (poll.deadline !== null && Date.now() > Number(poll.deadline)) {
    return res.status(403).json({ error: 'This poll is closed — voting has ended.' });
  }

  const slotsRes = await pool.query('SELECT slot_key FROM slots WHERE poll_id = $1', [req.params.id]);
  const validSlotIds = new Set(slotsRes.rows.map(r => r.slot_key));

  // Sanitize responses: only accept valid slot IDs with valid values
  const yesMaybeNo = new Set(['yes', 'maybe', 'no']);
  const yesNo       = new Set(['yes', 'no']);
  const sanitized = {};
  for (const [k, v] of Object.entries(responses)) {
    if (!validSlotIds.has(k)) continue;
    if (poll.type === 'schedule' || poll.type === 'rsvp') {
      if (yesMaybeNo.has(v)) sanitized[k] = v;
    } else if (poll.type === 'availability') {
      if (yesNo.has(v)) sanitized[k] = v;
    } else {
      const rank = parseInt(v);
      if (Number.isInteger(rank) && rank >= 1 && rank <= validSlotIds.size) sanitized[k] = String(rank);
    }
  }

  await pool.query(
    `INSERT INTO votes (poll_id, name, timezone, responses, submitted_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (poll_id, name_lower) DO UPDATE
     SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, responses = EXCLUDED.responses, submitted_at = EXCLUDED.submitted_at`,
    [req.params.id, name.trim(), timezone.trim(), JSON.stringify(sanitized), new Date()]
  );

  res.json({ success: true });
});

// Confirm a slot as the final time (owner only)
app.post('/api/polls/:id/confirm', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const { slotId } = req.body;
  if (!slotId || typeof slotId !== 'string') return res.status(400).json({ error: 'Missing slotId.' });

  const pollRes = await pool.query('SELECT id FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (!pollRes.rows[0]) return res.status(404).json({ error: 'Poll not found.' });

  const slotRes = await pool.query('SELECT 1 FROM slots WHERE poll_id = $1 AND slot_key = $2', [req.params.id, slotId]);
  if (!slotRes.rows[0]) return res.status(400).json({ error: 'Slot not found.' });

  await pool.query('UPDATE polls SET confirmed_slot = $1 WHERE id = $2', [slotId, req.params.id]);
  res.json({ success: true });
});

// Unconfirm a slot (owner only)
app.post('/api/polls/:id/unconfirm', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const pollRes = await pool.query('SELECT id FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (!pollRes.rows[0]) return res.status(404).json({ error: 'Poll not found.' });

  await pool.query('UPDATE polls SET confirmed_slot = NULL WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// Update poll title (owner only)
app.patch('/api/polls/:id', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const pollRes = await pool.query('SELECT id FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (!pollRes.rows[0]) return res.status(404).json({ error: 'Poll not found.' });

  const { title } = req.body;
  if (title !== undefined) {
    if (typeof title !== 'string' || !title.trim() || title.length > 200) {
      return res.status(400).json({ error: 'Invalid title.' });
    }
    await pool.query('UPDATE polls SET title = $1 WHERE id = $2', [title.trim(), req.params.id]);
  }
  res.json({ success: true });
});

// Delete a poll (owner only)
app.delete('/api/polls/:id', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const result = await pool.query('DELETE FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Poll not found.' });
  res.json({ success: true });
});

// Delete a specific vote (owner only)
app.delete('/api/polls/:id/votes/:voterName', async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const pollRes = await pool.query('SELECT id FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (!pollRes.rows[0]) return res.status(404).json({ error: 'Poll not found.' });

  const name = decodeURIComponent(req.params.voterName);
  const result = await pool.query('DELETE FROM votes WHERE poll_id = $1 AND name = $2', [req.params.id, name]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Vote not found.' });
  res.json({ success: true });
});

// Fallback: serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Huddle running at http://localhost:${PORT}`);
});
