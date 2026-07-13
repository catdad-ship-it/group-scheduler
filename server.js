const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');

const app = express();
app.set('trust proxy', true);
// CSP is left off for now: the page loads Tailwind/lucide from a CDN and
// relies on inline <script>/onclick handlers, so a real policy needs a
// broader frontend pass (tracked in CODE_REVIEW_PLAN.md 1.3/4.7) rather than
// a same-session bolt-on. The rest of helmet's defaults (nosniff, frame
// denial, referrer policy, HSTS, etc.) still apply.
app.use(helmet({ contentSecurityPolicy: false }));
const PORT = process.env.PORT || 3000;

const IS_PRODUCTION = process.env.NODE_ENV === 'production' || !!process.env.FLY_APP_NAME;

function requireProdEnv(name) {
  if (IS_PRODUCTION && !process.env[name]) {
    console.error(`FATAL: ${name} env var must be set in production.`);
    process.exit(1);
  }
}
requireProdEnv('DATABASE_URL');
requireProdEnv('JWT_SECRET');
requireProdEnv('APP_BASE_URL');

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

const SESSION_MAX_AGE_SECONDS = 90 * 24 * 60 * 60; // 90 days
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

async function sendEmail({ to, subject, html, from }) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.log(`\n✉️  Email to ${to} — ${subject}\n${html}\n`);
    return;
  }
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ from: from || 'Huddle <notifications@huddlr.co>', to, subject, html })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Resend API error ${res.status}: ${body}`);
  }
}

async function sendMagicLinkEmail(email, link) {
  await sendEmail({
    to: email,
    from: 'Huddle <login@huddlr.co>',
    subject: 'Your Huddle login link',
    html: `<p>Click the link below to log in to Huddle:</p><p><a href="${link}">${link}</a></p><p>This link expires in 15 minutes. If you didn't request it, you can ignore this email.</p>`
  });
}

function escHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const APP_BASE_URL = process.env.APP_BASE_URL || `http://localhost:${PORT}`;

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

const magicLinkAttempts = new Map(); // ip → { count, resetAt }
const RATE_LIMIT  = 10;
const RATE_WINDOW = 15 * 60 * 1000; // 15 minutes

const voteAttempts = new Map(); // ip → { count, resetAt }
const VOTE_RATE_LIMIT  = 30;
const VOTE_RATE_WINDOW = 15 * 60 * 1000; // 15 minutes
const MAX_VOTES_PER_POLL = 500;

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

// Magic-link tokens are stored hashed — a DB leak alone shouldn't hand out
// working login tokens for anyone with a pending link.
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateId() {
  return crypto.randomBytes(8).toString('hex');
}

// Fly's edge always sets fly-client-ip to the real connecting IP (clients
// can't override it, unlike X-Forwarded-For, which they can prepend to).
// Fall back to the last XFF hop for non-Fly environments.
function clientIp(req) {
  const flyIp = req.headers['fly-client-ip'];
  if (flyIp) return flyIp;
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const hops = xff.split(',').map(s => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

function generateSlotKey() {
  return 's' + crypto.randomBytes(4).toString('hex');
}

// Express 4 doesn't catch rejected promises from async route handlers —
// an unhandled rejection would otherwise crash the whole process.
function asyncHandler(fn) {
  return (req, res, next) => fn(req, res, next).catch(next);
}

process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection:', reason);
});

// Most endpoints take tiny JSON bodies, kept at a tight 16kb. The branding
// PATCH is the exception — it carries a base64 logo — so it gets a larger cap
// (still bounded; the route validates the logo size itself).
const jsonSmall = express.json({ limit: '16kb' });
const jsonLarge = express.json({ limit: '512kb' });
app.use((req, res, next) => {
  if (req.method === 'PATCH' && req.path === '/api/branding') return jsonLarge(req, res, next);
  return jsonSmall(req, res, next);
});
app.use(express.static(path.join(__dirname, 'public')));

// ─── FIELD VALIDATORS (shared by create + edit) ───────────────────────────────

function validateTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 200) {
    return { error: 'Title must be under 200 characters.' };
  }
  return { value: title.trim() };
}

function validateDescription(description) {
  if (description === undefined || description === null) return { value: '' };
  if (typeof description !== 'string' || description.length > 500) {
    return { error: 'Description must be under 500 characters.' };
  }
  return { value: description.trim() };
}

const DEADLINE_MAX_FUTURE_MS = 5 * 365 * 24 * 60 * 60 * 1000; // +5 years

// isCreate gates the "not absurdly in the past" check: edits re-submit the
// poll's existing deadline verbatim (see index.html's PATCH body), which for
// an already-closed poll is legitimately long past — only a brand-new
// deadline needs to look like a real near-future date.
function validateDeadline(deadline, isCreate) {
  if (deadline === undefined || deadline === null || deadline === '') return { value: null };
  const ms = Number(deadline);
  if (!Number.isFinite(ms)) return { error: 'Invalid deadline.' };
  if (isCreate && ms < Date.now() - 24 * 60 * 60 * 1000) return { error: 'Deadline can\'t be in the past.' };
  if (ms > Date.now() + DEADLINE_MAX_FUTURE_MS) return { error: 'Deadline is too far in the future.' };
  return { value: ms };
}

// Normalize a phone number to a compact "+digits" (or "digits") form for
// storage and for building `sms:` links on the client. Returns null if it
// doesn't look like a real phone number. Deliberately lenient about the
// entered format (spaces, dashes, parens) — we only keep a leading + and
// the digits, and require a plausible length.
function normalizePhone(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  const hasPlus = trimmed.startsWith('+');
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return (hasPlus ? '+' : '') + digits;
}

function validateExpectedVoters(expectedVoters) {
  if (expectedVoters === undefined) return { value: [] };
  if (!Array.isArray(expectedVoters)) return { error: 'expectedVoters must be an array.' };
  if (expectedVoters.length > 50) return { error: 'Too many expected voters (max 50).' };
  const value = [];
  for (const entry of expectedVoters) {
    // Accept a bare name string (legacy shape) or a {name, email?, phone?} object.
    const raw = typeof entry === 'string' ? { name: entry } : (entry && typeof entry === 'object' ? entry : null);
    if (!raw || typeof raw.name !== 'string' || !raw.name.trim()) continue;
    const voter = { name: raw.name.trim().slice(0, 100) };
    if (raw.email !== undefined && raw.email !== null && raw.email !== '') {
      if (typeof raw.email !== 'string' || raw.email.length > 254 || !EMAIL_RE.test(raw.email.trim())) {
        return { error: `Invalid email for ${voter.name}.` };
      }
      voter.email = raw.email.trim().toLowerCase();
    }
    if (raw.phone !== undefined && raw.phone !== null && raw.phone !== '') {
      const phone = normalizePhone(raw.phone);
      if (!phone) return { error: `Invalid phone number for ${voter.name}.` };
      voter.phone = phone;
    }
    value.push(voter);
  }
  return { value };
}

function validateSlots(pollType, slots) {
  const DATETIME_TYPES = ['schedule', 'availability'];
  const usesDatetime   = DATETIME_TYPES.includes(pollType);
  const maxSlots       = pollType === 'availability' ? 400 : 30;

  if (!Array.isArray(slots) || slots.length === 0) {
    return { error: 'Missing required fields.' };
  }
  if (slots.length > maxSlots) {
    return { error: `Too many slots (max ${maxSlots}).` };
  }

  if (usesDatetime) {
    for (const s of slots) {
      if (!Number.isFinite(Number(s.datetime))) {
        return { error: 'Invalid slot datetime.' };
      }
      if (s.endDatetime !== undefined && s.endDatetime !== null) {
        if (!Number.isFinite(Number(s.endDatetime)) || Number(s.endDatetime) <= Number(s.datetime)) {
          return { error: 'Invalid slot end time.' };
        }
      }
    }
    return {
      value: slots.map(s => {
        const slot = { datetime: Number(s.datetime) };
        if (s.endDatetime !== undefined && s.endDatetime !== null) slot.endDatetime = Number(s.endDatetime);
        return slot;
      })
    };
  }

  for (const s of slots) {
    if (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 200) {
      return { error: 'Invalid option label.' };
    }
  }
  return { value: slots.map(s => ({ label: String(s.label).trim() })) };
}

// ─── EMAIL: SMART-SUGGESTED SLOT ──────────────────────────────────────────────
// Mirrors the "best match" scoring already used client-side for schedule/
// availability results, so notification emails can name a slot without the
// organizer having to open the poll and read the grid.

function computeBestSlot(pollType, slotRows, voteRows) {
  if (!['schedule', 'availability'].includes(pollType) || voteRows.length === 0) return null;
  const total = voteRows.length;
  const scores = {};
  slotRows.forEach(s => { scores[s.slot_key] = { yes: 0, maybe: 0 }; });
  voteRows.forEach(v => {
    slotRows.forEach(s => {
      const r = (v.responses || {})[s.slot_key];
      if (r === 'yes') scores[s.slot_key].yes++;
      if (r === 'maybe') scores[s.slot_key].maybe++;
    });
  });
  // Schedule: availability (yes+maybe) first, tiebreak on definite yes. Availability grid: yes only.
  const scoreOf = key => pollType === 'availability'
    ? scores[key].yes
    : (scores[key].yes + scores[key].maybe) * 1000 + scores[key].yes;

  let best = null;
  for (const s of slotRows) {
    const sc = scoreOf(s.slot_key);
    if (sc > 0 && (!best || sc > best.score)) {
      best = { slot: s, score: sc, yes: scores[s.slot_key].yes, maybe: scores[s.slot_key].maybe };
    }
  }
  if (!best) return null;
  return { label: formatSlotForEmail(best.slot), yes: best.yes, maybe: best.maybe, total };
}

function formatSlotForEmail(slot) {
  if (slot.datetime === null || slot.datetime === undefined) return slot.label || 'an option';
  const dt = new Date(Number(slot.datetime));
  return dt.toLocaleString('en-US', {
    timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
  }) + ' UTC';
}

// ─── DB HELPERS ──────────────────────────────────────────────────────────────

function serializePoll(poll, slots, votes, isOwner) {
  return {
    id: poll.id,
    type: poll.type,
    title: poll.title,
    creatorName: poll.creator_name,
    description: poll.description,
    createdAt: poll.created_at.toISOString(),
    deadline: poll.deadline !== null ? Number(poll.deadline) : null,
    expectedVoters: isOwner
      ? poll.expected_voters
      : (poll.expected_voters || []).map(v => ({ name: v.name })),
    confirmedSlot: poll.confirmed_slot,
    isOwner: !!isOwner,
    // Client grouping (Phase 7). client_id is on the poll row; client_name is
    // joined in by the owner-facing loaders (null/absent for public views).
    clientId: poll.client_id != null ? Number(poll.client_id) : null,
    clientName: poll.client_name || null,
    // Owner's account-level branding (Phase 6), shown on the voting page.
    // Joined in by the loaders; absent on polls whose owner set no branding.
    branding: (poll.brand_logo || poll.brand_color)
      ? { logo: poll.brand_logo || null, color: poll.brand_color || null }
      : null,
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

async function loadPollById(id, viewerUserId) {
  const pollRes = await pool.query(
    `SELECT p.*, u.brand_logo, u.brand_color
     FROM polls p JOIN users u ON u.id = p.owner_id
     WHERE p.id = $1`,
    [id]
  );
  const poll = pollRes.rows[0];
  if (!poll) return null;
  const [slotsRes, votesRes] = await Promise.all([
    pool.query('SELECT * FROM slots WHERE poll_id = $1 ORDER BY sort_order', [id]),
    pool.query('SELECT * FROM votes WHERE poll_id = $1 ORDER BY submitted_at', [id])
  ]);
  const isOwner = viewerUserId != null && String(poll.owner_id) === String(viewerUserId);
  return serializePoll(poll, slotsRes.rows, votesRes.rows, isOwner);
}

// Summary shape for list views (dashboard, client hub) — neither renders
// slots/votes/branding/expectedVoters, just a title/type/date/vote count per
// card, so this skips fetching (and shipping over the wire) full poll detail
// for every row. Full detail is a separate GET /api/polls/:id fetch on open.
function serializePollSummary(row) {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    createdAt: row.created_at.toISOString(),
    deadline: row.deadline !== null ? Number(row.deadline) : null,
    confirmedSlot: row.confirmed_slot,
    clientId: row.client_id != null ? Number(row.client_id) : null,
    clientName: row.client_name || null,
    voteCount: row.vote_count
  };
}

async function loadPollsByOwner(ownerId, { clientId } = {}) {
  const params = [ownerId];
  let where = 'p.owner_id = $1';
  if (clientId !== undefined) { params.push(clientId); where += ` AND p.client_id = $${params.length}`; }
  const pollsRes = await pool.query(
    `SELECT p.id, p.type, p.title, p.created_at, p.deadline, p.confirmed_slot, p.client_id, c.name AS client_name,
            (SELECT COUNT(*) FROM votes v WHERE v.poll_id = p.id)::int AS vote_count
     FROM polls p LEFT JOIN clients c ON c.id = p.client_id
     WHERE ${where} ORDER BY p.created_at DESC`,
    params
  );
  return pollsRes.rows.map(serializePollSummary);
}

// Builds a "($1,$2,...),($n+1,...)..." VALUES clause + flat params array for
// a multi-row INSERT, so writing N slots is one round trip instead of N.
function buildBulkValues(rows) {
  const width = rows[0].length;
  const params = [];
  const valuesSql = rows.map((row, i) => {
    const placeholders = row.map((_, j) => `$${i * width + j + 1}`);
    params.push(...row);
    return `(${placeholders.join(',')})`;
  }).join(',');
  return { valuesSql, params };
}

async function createPoll(poll, ownerId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO polls (id, owner_id, type, title, creator_name, description, created_at, deadline, expected_voters, client_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [poll.id, ownerId, poll.type, poll.title, poll.creatorName, poll.description, new Date(poll.createdAt), poll.deadline, JSON.stringify(poll.expectedVoters), poll.clientId ?? null]
    );
    if (poll.slots.length) {
      const rows = poll.slots.map((s, i) => [poll.id, s.id, s.datetime ?? null, s.endDatetime ?? null, s.label ?? null, i]);
      const { valuesSql, params } = buildBulkValues(rows);
      await client.query(
        `INSERT INTO slots (poll_id, slot_key, datetime, end_datetime, label, sort_order) VALUES ${valuesSql}`,
        params
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

// Resolve a client_id for a poll write: empty → null (no client); otherwise the
// client must exist AND belong to this owner. Returns { value } or { error }.
async function resolveClientId(clientId, ownerId) {
  if (clientId === undefined || clientId === null || clientId === '') return { value: null };
  const id = Number(clientId);
  if (!Number.isInteger(id)) return { error: 'Invalid client.' };
  const r = await pool.query('SELECT 1 FROM clients WHERE id = $1 AND owner_id = $2', [id, ownerId]);
  if (!r.rows[0]) return { error: 'Client not found.' };
  return { value: id };
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Request a magic login link
app.post('/api/auth/magic-link', asyncHandler(async (req, res) => {
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
  // A fresh link supersedes any older unused ones for this email.
  await pool.query('UPDATE magic_link_tokens SET used_at = now() WHERE email = $1 AND used_at IS NULL', [normalizedEmail]);
  await pool.query('INSERT INTO magic_link_tokens (token, email, expires_at) VALUES ($1,$2,$3)', [hashToken(token), normalizedEmail, expiresAt]);

  const link = `${APP_BASE_URL}/api/auth/verify?token=${token}`;
  try {
    await sendMagicLinkEmail(normalizedEmail, link);
  } catch (e) {
    console.error('Failed to send magic link email:', e);
    return res.status(502).json({ error: 'Could not send the login email. Try again in a moment.' });
  }
  res.json({ success: true });
}));

const TOKEN_RE = /^[0-9a-f]{64}$/;

// Serve an interstitial instead of consuming the token on GET — email
// scanners (Outlook SafeLinks etc.) prefetch links and would otherwise burn
// the token, log the scanner in, and lock the real user out before they ever
// click.
app.get('/api/auth/verify', (req, res) => {
  const token = req.query.token;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return res.redirect('/?authError=invalid');
  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Log in to Huddle</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f8fafc}
.card{background:#fff;border-radius:12px;box-shadow:0 1px 3px rgba(0,0,0,.1);padding:2rem;text-align:center;max-width:360px}
button{background:#2563eb;color:#fff;border:none;border-radius:8px;padding:.75rem 1.5rem;font-size:1rem;cursor:pointer;margin-top:1rem}
button:disabled{opacity:.6;cursor:default}
p{color:#475569}</style></head>
<body><div class="card">
<h1 style="font-size:1.25rem;margin:0 0 .5rem">Log in to Huddle</h1>
<p>Click below to finish logging in.</p>
<button id="go">Continue to Huddle</button>
<p id="err" style="color:#dc2626;display:none"></p>
</div>
<script>
document.getElementById('go').addEventListener('click', async function () {
  var btn = this;
  btn.disabled = true;
  btn.textContent = 'Logging in…';
  try {
    var res = await fetch('/api/auth/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: ${JSON.stringify(token)} })
    });
    if (!res.ok) throw new Error();
    window.location.href = '/dashboard?loggedIn=1';
  } catch (e) {
    document.getElementById('err').textContent = 'This link has expired or already been used.';
    document.getElementById('err').style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Continue to Huddle';
  }
});
</script>
</body></html>`);
});

// Consume the token and start a session (called by the interstitial above).
app.post('/api/auth/verify', asyncHandler(async (req, res) => {
  const token = req.body && req.body.token;
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) return res.status(400).json({ error: 'Invalid token.' });

  const tokenRes = await pool.query(
    `UPDATE magic_link_tokens SET used_at = now()
     WHERE token = $1 AND used_at IS NULL AND expires_at > now()
     RETURNING email`,
    [hashToken(token)]
  );
  const row = tokenRes.rows[0];
  if (!row) return res.status(400).json({ error: 'This link has expired or already been used.' });

  const userRes = await pool.query(
    `INSERT INTO users (email) VALUES ($1)
     ON CONFLICT (email) DO UPDATE SET email = EXCLUDED.email
     RETURNING id, email`,
    [row.email]
  );
  setSessionCookie(res, userRes.rows[0]);
  res.json({ success: true });
}));

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
app.get('/api/admin/polls', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const polls = await loadPollsByOwner(user.id);
  res.json(polls);
}));

// ─── BRANDING (Phase 6) ────────────────────────────────────────────────────
// Account-level logo + accent color shown on the voting page a client sees.
// Not plan-gated on the mainline — the Pro gate is added with billing at Phase 9.

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;
// data:image/<type>;base64,<payload> — the only shape we accept for a logo.
// svg+xml is allowed here on the assumption the frontend only ever renders
// this value via <img src="...">, which doesn't execute embedded <script>/
// event-handler content — never via innerHTML or <object>. If that ever
// changes, drop svg+xml from this list first.
const LOGO_DATA_URI_RE = /^data:image\/(png|jpeg|jpg|gif|webp|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_LOGO_CHARS = 200 * 1024; // ~200KB of base64 (~150KB raw) — plenty for a logo

function validateBrandColor(color) {
  if (color === undefined || color === null || color === '') return { value: null };
  if (typeof color !== 'string' || !HEX_COLOR_RE.test(color.trim())) {
    return { error: 'Color must be a hex value like #2563eb.' };
  }
  return { value: color.trim().toLowerCase() };
}

function validateBrandLogo(logo) {
  if (logo === undefined || logo === null || logo === '') return { value: null };
  if (typeof logo !== 'string') return { error: 'Invalid logo.' };
  if (logo.length > MAX_LOGO_CHARS) return { error: 'Logo is too large — keep it under ~150KB.' };
  if (!LOGO_DATA_URI_RE.test(logo)) return { error: 'Logo must be a PNG, JPG, GIF, WEBP, or SVG image.' };
  return { value: logo };
}

// Get the current user's branding (for the settings page)
app.get('/api/branding', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const r = await pool.query('SELECT brand_logo, brand_color FROM users WHERE id = $1', [user.id]);
  const row = r.rows[0] || {};
  res.json({ logo: row.brand_logo || null, color: row.brand_color || null });
}));

// Update the current user's branding
app.patch('/api/branding', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const { logo, color } = req.body;
  const fields = [];
  if (logo !== undefined) {
    const r = validateBrandLogo(logo);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['brand_logo', r.value]);
  }
  if (color !== undefined) {
    const r = validateBrandColor(color);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['brand_color', r.value]);
  }
  if (!fields.length) return res.json({ success: true });

  const setClauses = fields.map(([col], i) => `${col} = $${i + 1}`);
  const values = fields.map(([, val]) => val);
  values.push(user.id);
  await pool.query(`UPDATE users SET ${setClauses.join(', ')} WHERE id = $${values.length}`, values);
  res.json({ success: true });
}));

// ─── CLIENTS (Phase 7) ─────────────────────────────────────────────────────
// Owner-only grouping of polls by client. No public exposure.

function validateClientName(name) {
  if (typeof name !== 'string' || !name.trim()) return { error: 'Client name is required.' };
  if (name.trim().length > 100) return { error: 'Client name must be under 100 characters.' };
  return { value: name.trim() };
}

// List the current user's clients, each with a live poll count.
app.get('/api/clients', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const r = await pool.query(
    `SELECT c.id, c.name, COUNT(p.id)::int AS poll_count
     FROM clients c LEFT JOIN polls p ON p.client_id = c.id
     WHERE c.owner_id = $1
     GROUP BY c.id ORDER BY c.name`,
    [user.id]
  );
  res.json(r.rows.map(row => ({ id: Number(row.id), name: row.name, pollCount: row.poll_count })));
}));

// Create a client.
app.post('/api/clients', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const nameR = validateClientName(req.body && req.body.name);
  if (nameR.error) return res.status(400).json({ error: nameR.error });
  const r = await pool.query(
    'INSERT INTO clients (owner_id, name) VALUES ($1,$2) RETURNING id, name',
    [user.id, nameR.value]
  );
  res.json({ id: Number(r.rows[0].id), name: r.rows[0].name, pollCount: 0 });
}));

// The client hub: the client plus all of the owner's polls for it.
app.get('/api/clients/:id', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const cRes = await pool.query('SELECT id, name FROM clients WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  const client = cRes.rows[0];
  if (!client) return res.status(404).json({ error: 'Client not found.' });
  const polls = await loadPollsByOwner(user.id, { clientId: Number(client.id) });
  res.json({ id: Number(client.id), name: client.name, polls });
}));

// Rename a client.
app.patch('/api/clients/:id', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const nameR = validateClientName(req.body && req.body.name);
  if (nameR.error) return res.status(400).json({ error: nameR.error });
  const r = await pool.query(
    'UPDATE clients SET name = $1 WHERE id = $2 AND owner_id = $3 RETURNING id',
    [nameR.value, req.params.id, user.id]
  );
  if (!r.rows[0]) return res.status(404).json({ error: 'Client not found.' });
  res.json({ success: true });
}));

// Delete a client. Its polls are preserved (client_id set to null by the FK).
app.delete('/api/clients/:id', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });
  const r = await pool.query('DELETE FROM clients WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Client not found.' });
  res.json({ success: true });
}));

// Create a new poll (requires an account)
app.post('/api/polls', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Log in to create a poll.' });

  const { title, creatorName, description, slots, type, deadline, expectedVoters, clientId } = req.body;
  const VALID_TYPES = ['schedule', 'question', 'rsvp', 'availability'];
  if (type !== undefined && !VALID_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Invalid poll type.' });
  }
  const pollType = VALID_TYPES.includes(type) ? type : 'schedule';

  if (creatorName !== undefined && creatorName !== null &&
      (typeof creatorName !== 'string' || creatorName.trim().length > 100)) {
    return res.status(400).json({ error: 'Name must be under 100 characters.' });
  }

  const titleR = validateTitle(title);
  if (titleR.error) return res.status(400).json({ error: titleR.error });
  const descR = validateDescription(description);
  if (descR.error) return res.status(400).json({ error: descR.error });
  const deadlineR = validateDeadline(deadline, true);
  if (deadlineR.error) return res.status(400).json({ error: deadlineR.error });
  const votersR = validateExpectedVoters(expectedVoters);
  if (votersR.error) return res.status(400).json({ error: votersR.error });
  const slotsR = validateSlots(pollType, slots);
  if (slotsR.error) return res.status(400).json({ error: slotsR.error });
  const clientR = await resolveClientId(clientId, user.id);
  if (clientR.error) return res.status(400).json({ error: clientR.error });

  const poll = {
    id: generateId(),
    type: pollType,
    title: titleR.value,
    creatorName: typeof creatorName === 'string' ? creatorName.trim() : '',
    description: descR.value,
    createdAt: new Date().toISOString(),
    deadline: deadlineR.value,
    expectedVoters: votersR.value,
    clientId: clientR.value,
    slots: slotsR.value.map((s, i) => ({ id: `s${i}`, ...s }))
  };

  try {
    await createPoll(poll, user.id);
  } catch (e) {
    if (e.code !== '23505') throw e; // unique_violation — anything else is a real failure
    poll.id = generateId(); // id collision: astronomically unlikely, but cheap to retry once
    await createPoll(poll, user.id);
  }
  res.json({ id: poll.id });
}));

// Get a poll by ID (public — voting page)
app.get('/api/polls/:id', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  const poll = await loadPollById(req.params.id, user ? user.id : null);
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  res.json(poll);
}));

// Submit a vote (public — voting stays anonymous)
app.post('/api/polls/:id/vote', asyncHandler(async (req, res) => {
  if (!checkRateLimit(voteAttempts, clientIp(req), VOTE_RATE_LIMIT, VOTE_RATE_WINDOW)) {
    return res.status(429).json({ error: 'Too many votes submitted. Try again later.' });
  }

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

  const pollRes = await pool.query(
    `SELECT p.id, p.type, p.deadline, p.title, u.email AS owner_email
     FROM polls p JOIN users u ON u.id = p.owner_id WHERE p.id = $1`,
    [req.params.id]
  );
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
  const RANK_RE     = /^\d+$/; // strict — parseInt would accept junk like "2abc"
  const sanitized = {};
  for (const [k, v] of Object.entries(responses)) {
    if (!validSlotIds.has(k)) continue;
    if (poll.type === 'schedule' || poll.type === 'rsvp') {
      if (yesMaybeNo.has(v)) sanitized[k] = v;
    } else if (poll.type === 'availability') {
      if (yesNo.has(v)) sanitized[k] = v;
    } else if (typeof v === 'string' && RANK_RE.test(v)) {
      const rank = Number(v);
      if (rank >= 1 && rank <= validSlotIds.size) sanitized[k] = String(rank);
    }
  }

  if (poll.type === 'question') {
    const ranks = Object.values(sanitized);
    if (new Set(ranks).size !== ranks.length) {
      return res.status(400).json({ error: 'Each option must have a unique rank.' });
    }
  }

  const trimmedName = name.trim();
  const existingRes = await pool.query(
    'SELECT 1 FROM votes WHERE poll_id = $1 AND name_lower = lower($2)',
    [req.params.id, trimmedName]
  );
  const isNewVoter = existingRes.rowCount === 0;

  if (isNewVoter) {
    const countRes = await pool.query('SELECT COUNT(*)::int AS c FROM votes WHERE poll_id = $1', [req.params.id]);
    if (countRes.rows[0].c >= MAX_VOTES_PER_POLL) {
      return res.status(403).json({ error: 'This poll has reached its maximum number of responses.' });
    }
  }

  await pool.query(
    `INSERT INTO votes (poll_id, name, timezone, responses, submitted_at)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (poll_id, name_lower) DO UPDATE
     SET name = EXCLUDED.name, timezone = EXCLUDED.timezone, responses = EXCLUDED.responses, submitted_at = EXCLUDED.submitted_at`,
    [req.params.id, trimmedName, timezone.trim(), JSON.stringify(sanitized), new Date()]
  );

  res.json({ success: true });

  if (isNewVoter) {
    notifyNewResponse(poll, trimmedName).catch(e => console.error('notifyNewResponse failed:', e));
  }
}));

// Email the poll owner that a new response came in — fire-and-forget, never
// allowed to affect the vote response itself.
async function notifyNewResponse(poll, voterName) {
  if (!poll.owner_email) return;
  const [slotsRes, votesRes] = await Promise.all([
    pool.query('SELECT slot_key, datetime, end_datetime, label FROM slots WHERE poll_id = $1', [poll.id]),
    pool.query('SELECT name, responses FROM votes WHERE poll_id = $1', [poll.id])
  ]);
  const best = computeBestSlot(poll.type, slotsRes.rows, votesRes.rows);
  const bestLine = best
    ? `<p>Best time so far: <strong>${escHtml(best.label)}</strong> (${best.yes} yes${best.maybe ? `, ${best.maybe} maybe` : ''} of ${best.total}).</p>`
    : '';
  const pollUrl = `${APP_BASE_URL}/?poll=${poll.id}`;
  await sendEmail({
    to: poll.owner_email,
    subject: `New response on "${poll.title}"`,
    html: `<p><strong>${escHtml(voterName)}</strong> just responded to your poll "${escHtml(poll.title)}".</p>${bestLine}<p><a href="${pollUrl}">View responses</a></p>`
  });
}

// One-click nudge: email a specific expected voter who hasn't responded yet (owner only)
const nudgeAttempts = new Map(); // `${pollId}:${nameLower}` -> last-sent timestamp
const NUDGE_COOLDOWN_MS = 15 * 60 * 1000;

app.post('/api/polls/:id/nudge', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const { voterName } = req.body;
  if (typeof voterName !== 'string' || !voterName.trim()) {
    return res.status(400).json({ error: 'Missing voterName.' });
  }

  const pollRes = await pool.query(
    'SELECT id, title, type, expected_voters FROM polls WHERE id = $1 AND owner_id = $2',
    [req.params.id, user.id]
  );
  const poll = pollRes.rows[0];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  const trimmed = voterName.trim();
  const voter = (poll.expected_voters || []).find(v => v.name.toLowerCase() === trimmed.toLowerCase());
  if (!voter || !voter.email) {
    return res.status(400).json({ error: 'No email on file for this person.' });
  }

  const key = `${poll.id}:${voter.name.toLowerCase()}`;
  const last = nudgeAttempts.get(key);
  if (last && Date.now() - last < NUDGE_COOLDOWN_MS) {
    return res.status(429).json({ error: 'Already nudged recently — try again in a few minutes.' });
  }
  nudgeAttempts.set(key, Date.now());

  try {
    const [slotsRes, votesRes] = await Promise.all([
      pool.query('SELECT slot_key, datetime, end_datetime, label FROM slots WHERE poll_id = $1', [poll.id]),
      pool.query('SELECT name, responses FROM votes WHERE poll_id = $1', [poll.id])
    ]);
    const best = computeBestSlot(poll.type, slotsRes.rows, votesRes.rows);
    const bestLine = best
      ? `<p>Right now the best-fitting time is <strong>${escHtml(best.label)}</strong>.</p>`
      : '';
    const pollUrl = `${APP_BASE_URL}/?poll=${poll.id}`;
    await sendEmail({
      to: voter.email,
      subject: `Reminder: ${poll.title}`,
      html: `<p>Hi ${escHtml(voter.name)}, just a friendly nudge — you haven't responded to "${escHtml(poll.title)}" yet.</p>${bestLine}<p><a href="${pollUrl}">Respond here</a></p><p style="color:#888;font-size:12px">You're receiving this because the organizer invited you to respond to a scheduling poll on Huddle.</p>`
    });
    res.json({ success: true });
  } catch (e) {
    console.error('Failed to send nudge email:', e);
    res.status(502).json({ error: 'Could not send the nudge email. Try again in a moment.' });
  }
}));

// Confirm a slot as the final time (owner only)
app.post('/api/polls/:id/confirm', asyncHandler(async (req, res) => {
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
}));

// Unconfirm a slot (owner only)
app.post('/api/polls/:id/unconfirm', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const pollRes = await pool.query('SELECT id FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (!pollRes.rows[0]) return res.status(404).json({ error: 'Poll not found.' });

  await pool.query('UPDATE polls SET confirmed_slot = NULL WHERE id = $1', [req.params.id]);
  res.json({ success: true });
}));

// Replace a poll's slots in place, preserving slot_key identity for values
// that didn't change (so existing votes stay attached to the right option).
// Slots whose value changed are treated as old-removed + new-added.
async function updatePollSlots(client, pollId, newSlots) {
  const existingRes = await client.query(
    'SELECT slot_key, datetime, end_datetime, label FROM slots WHERE poll_id = $1',
    [pollId]
  );
  const existing = existingRes.rows.map(r => ({
    slot_key: r.slot_key,
    datetime: r.datetime !== null ? Number(r.datetime) : null,
    end_datetime: r.end_datetime !== null ? Number(r.end_datetime) : null,
    label: r.label
  }));
  const consumed = new Set();

  const sameValue = (e, s) =>
    e.datetime === (s.datetime ?? null) &&
    e.end_datetime === (s.endDatetime ?? null) &&
    e.label === (s.label ?? null);

  const resolved = newSlots.map(s => {
    const match = existing.find(e => !consumed.has(e.slot_key) && sameValue(e, s));
    if (match) { consumed.add(match.slot_key); return { slot_key: match.slot_key, ...s }; }
    return { slot_key: generateSlotKey(), ...s };
  });

  const keysToKeep = new Set(resolved.map(s => s.slot_key));
  const keysToDelete = existing.filter(e => !keysToKeep.has(e.slot_key)).map(e => e.slot_key);
  if (keysToDelete.length) {
    await client.query('DELETE FROM slots WHERE poll_id = $1 AND slot_key = ANY($2)', [pollId, keysToDelete]);
  }

  if (resolved.length) {
    const rows = resolved.map((s, i) => [pollId, s.slot_key, s.datetime ?? null, s.endDatetime ?? null, s.label ?? null, i]);
    const { valuesSql, params } = buildBulkValues(rows);
    await client.query(
      `INSERT INTO slots (poll_id, slot_key, datetime, end_datetime, label, sort_order)
       VALUES ${valuesSql}
       ON CONFLICT (poll_id, slot_key) DO UPDATE SET
         datetime = EXCLUDED.datetime, end_datetime = EXCLUDED.end_datetime,
         label = EXCLUDED.label, sort_order = EXCLUDED.sort_order`,
      params
    );
  }

  // Clear confirmed_slot if it no longer exists among the surviving slots.
  await client.query(
    `UPDATE polls SET confirmed_slot = NULL
     WHERE id = $1 AND confirmed_slot IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM slots WHERE poll_id = $1 AND slot_key = polls.confirmed_slot)`,
    [pollId]
  );
}

// Update a poll's title/description/deadline/expectedVoters/slots (owner only)
app.patch('/api/polls/:id', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const pollRes = await pool.query('SELECT id, type FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  const poll = pollRes.rows[0];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  const { title, description, deadline, expectedVoters, slots, clientId } = req.body;
  const fields = [];

  if (title !== undefined) {
    const r = validateTitle(title);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['title', r.value]);
  }
  if (description !== undefined) {
    const r = validateDescription(description);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['description', r.value]);
  }
  if (deadline !== undefined) {
    const r = validateDeadline(deadline);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['deadline', r.value]);
    // A deliberate deadline edit gets its own fresh reminder window.
    fields.push(['deadline_reminder_sent_at', null]);
  }
  if (expectedVoters !== undefined) {
    const r = validateExpectedVoters(expectedVoters);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['expected_voters', JSON.stringify(r.value)]);
  }
  if (clientId !== undefined) {
    const r = await resolveClientId(clientId, user.id);
    if (r.error) return res.status(400).json({ error: r.error });
    fields.push(['client_id', r.value]);
  }
  let resolvedSlots = null;
  if (slots !== undefined) {
    const r = validateSlots(poll.type, slots);
    if (r.error) return res.status(400).json({ error: r.error });
    resolvedSlots = r.value;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (fields.length) {
      const setClauses = fields.map(([col], i) => `${col} = $${i + 1}`);
      const values = fields.map(([, val]) => val);
      values.push(req.params.id);
      await client.query(`UPDATE polls SET ${setClauses.join(', ')} WHERE id = $${values.length}`, values);
    }
    if (resolvedSlots) {
      await updatePollSlots(client, req.params.id, resolvedSlots);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  res.json({ success: true });
}));

// Delete a poll (owner only)
app.delete('/api/polls/:id', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const result = await pool.query('DELETE FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Poll not found.' });
  res.json({ success: true });
}));

// Delete a specific vote (owner only)
app.delete('/api/polls/:id/votes/:voterName', asyncHandler(async (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: 'Unauthorized.' });

  const pollRes = await pool.query('SELECT id FROM polls WHERE id = $1 AND owner_id = $2', [req.params.id, user.id]);
  if (!pollRes.rows[0]) return res.status(404).json({ error: 'Poll not found.' });

  // Express already decodes route params — decoding again mangles names
  // with a literal '%' (e.g. "100% Bob" throws URIError) and double-decodes
  // legitimately-encoded ones. Match by name_lower for the same
  // case-insensitive identity the (poll_id, name_lower) uniqueness uses.
  const result = await pool.query('DELETE FROM votes WHERE poll_id = $1 AND name_lower = lower($2)', [req.params.id, req.params.voterName]);
  if (result.rowCount === 0) return res.status(404).json({ error: 'Vote not found.' });
  res.json({ success: true });
}));

// A typo'd/unknown API path should 404 as JSON, not fall through to the
// index.html catch-all below (which breaks client res.json() parsing).
app.all('/api/*', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Fallback: serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Final error handler — catches anything asyncHandler forwards (or thrown
// synchronously by a route) so one bad request/DB hiccup can't take the
// whole process down.
app.use((err, req, res, next) => {
  console.error('Unhandled route error:', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error.' });
});

// ─── DEADLINE REMINDERS (organizer-only, per Phase 5) ─────────────────────────
// In-process sweep — no cron infra needed at this scale. The atomic
// UPDATE...RETURNING claims each poll exactly once even if this ever runs on
// more than one machine, so it's safe without any distributed lock.

const DEADLINE_REMINDER_WINDOW_MS = 24 * 60 * 60 * 1000; // remind once deadline is within 24h
const REMINDER_SWEEP_INTERVAL_MS  = 30 * 60 * 1000;      // check every 30 min

async function sendDeadlineReminder(poll) {
  try {
    const ownerRes = await pool.query('SELECT email FROM users WHERE id = $1', [poll.owner_id]);
    const ownerEmail = ownerRes.rows[0]?.email;
    if (!ownerEmail) return;

    const [slotsRes, votesRes] = await Promise.all([
      pool.query('SELECT slot_key, datetime, end_datetime, label FROM slots WHERE poll_id = $1', [poll.id]),
      pool.query('SELECT name, responses FROM votes WHERE poll_id = $1', [poll.id])
    ]);
    const votedNames = new Set(votesRes.rows.map(v => v.name.toLowerCase()));
    const missing = (poll.expected_voters || []).filter(v => !votedNames.has(v.name.toLowerCase())).map(v => v.name);
    const best = computeBestSlot(poll.type, slotsRes.rows, votesRes.rows);

    const missingLine = missing.length ? `<p>Still waiting on: ${missing.map(escHtml).join(', ')}.</p>` : '';
    const bestLine = best
      ? `<p>Best time so far: <strong>${escHtml(best.label)}</strong> (${best.yes} yes${best.maybe ? `, ${best.maybe} maybe` : ''} of ${best.total}).</p>`
      : '';
    const pollUrl = `${APP_BASE_URL}/?poll=${poll.id}`;
    await sendEmail({
      to: ownerEmail,
      subject: `"${poll.title}" closes soon`,
      html: `<p>Your poll "${escHtml(poll.title)}" closes within 24 hours.</p>${missingLine}${bestLine}<p><a href="${pollUrl}">View poll</a></p>`
    });
  } catch (e) {
    console.error(`Failed to send deadline reminder for poll ${poll.id}:`, e);
  }
}

async function runDeadlineReminderSweep() {
  try {
    const now = Date.now();
    const pollsRes = await pool.query(
      `UPDATE polls SET deadline_reminder_sent_at = now()
       WHERE confirmed_slot IS NULL
         AND deadline IS NOT NULL
         AND deadline > $1
         AND deadline <= $2
         AND deadline_reminder_sent_at IS NULL
       RETURNING id, owner_id, title, type, expected_voters`,
      [now, now + DEADLINE_REMINDER_WINDOW_MS]
    );
    for (const poll of pollsRes.rows) {
      await sendDeadlineReminder(poll);
    }
  } catch (e) {
    console.error('Deadline reminder sweep failed:', e);
  }
}

async function cleanupMagicLinkTokens() {
  try {
    await pool.query(`DELETE FROM magic_link_tokens WHERE expires_at < now() - interval '1 day'`);
  } catch (e) {
    console.error('Magic link token cleanup failed:', e);
  }
}

// The in-memory rate-limit/cooldown maps (magicLinkAttempts, voteAttempts:
// { count, resetAt }; nudgeAttempts: raw last-sent timestamp) are never
// evicted otherwise — a long-lived process would leak memory, and an
// attacker spoofing IPs could inflate them faster still.
function purgeStaleRateLimitEntries() {
  const now = Date.now();
  for (const [key, record] of magicLinkAttempts) {
    if (record.resetAt < now) magicLinkAttempts.delete(key);
  }
  for (const [key, record] of voteAttempts) {
    if (record.resetAt < now) voteAttempts.delete(key);
  }
  for (const [key, lastSent] of nudgeAttempts) {
    if (now - lastSent > NUDGE_COOLDOWN_MS) nudgeAttempts.delete(key);
  }
}

async function runMaintenanceSweep() {
  await runDeadlineReminderSweep();
  await cleanupMagicLinkTokens();
  purgeStaleRateLimitEntries();
}

setInterval(runMaintenanceSweep, REMINDER_SWEEP_INTERVAL_MS);
runMaintenanceSweep();

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Huddle running at http://localhost:${PORT}`);
});
