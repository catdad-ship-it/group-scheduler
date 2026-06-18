const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'polls.json');

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'brady';
if (!process.env.ADMIN_PASSWORD) {
  console.warn('⚠️  WARNING: ADMIN_PASSWORD env var not set. Using insecure default password.');
}

const sessions = new Map(); // token → expiry timestamp

// ─── RATE LIMITING ────────────────────────────────────────────────────────────

const loginAttempts = new Map(); // ip → { count, resetAt }
const LOGIN_LIMIT  = 10;
const LOGIN_WINDOW = 15 * 60 * 1000; // 15 minutes

function checkLoginRateLimit(ip) {
  const now    = Date.now();
  const record = loginAttempts.get(ip) || { count: 0, resetAt: now + LOGIN_WINDOW };
  if (now > record.resetAt) { record.count = 0; record.resetAt = now + LOGIN_WINDOW; }
  record.count++;
  loginAttempts.set(ip, record);
  return record.count <= LOGIN_LIMIT;
}

function generateToken() {
  return crypto.randomBytes(16).toString('hex');
}

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const match = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return match ? match.slice(name.length + 1) : null;
}

function isAuthenticated(req) {
  const token = getCookie(req, 'admin_token');
  if (!token) return false;
  const expiry = sessions.get(token);
  if (!expiry || Date.now() > expiry) { sessions.delete(token); return false; }
  return true;
}

app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ─── DB HELPERS ──────────────────────────────────────────────────────────────

function loadDB() {
  if (!fs.existsSync(DB_PATH)) return {};
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveDB(data) {
  fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2));
}

function generateId() {
  return crypto.randomBytes(4).toString('hex');
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

// Login
app.post('/api/login', (req, res) => {
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  if (!checkLoginRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again later.' });
  }
  const { password } = req.body;
  if (typeof password !== 'string' || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  const token = generateToken();
  const sevenDays = 7 * 24 * 60 * 60;
  sessions.set(token, Date.now() + sevenDays * 1000);
  res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${sevenDays}`);
  res.json({ success: true });
});

// Logout
app.post('/api/logout', (req, res) => {
  const token = getCookie(req, 'admin_token');
  if (token) sessions.delete(token);
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ success: true });
});

// Auth status
app.get('/api/auth-status', (req, res) => {
  res.json({ authenticated: isAuthenticated(req) });
});

// Admin: list all polls
app.get('/api/admin/polls', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized.' });
  const db = loadDB();
  const polls = Object.values(db).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(polls);
});

// Create a new poll
app.post('/api/polls', (req, res) => {
  const { title, creatorName, slots, type } = req.body;
  const pollType = type === 'question' ? 'question' : 'schedule';

  if (!title || !creatorName || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }
  if (typeof title !== 'string' || title.trim().length > 200) {
    return res.status(400).json({ error: 'Title must be under 200 characters.' });
  }
  if (typeof creatorName !== 'string' || creatorName.trim().length > 100) {
    return res.status(400).json({ error: 'Name must be under 100 characters.' });
  }
  if (slots.length > 30) {
    return res.status(400).json({ error: 'Too many slots (max 30).' });
  }

  // Validate slot payloads
  if (pollType === 'schedule') {
    for (const s of slots) {
      if (!Number.isFinite(Number(s.datetime))) {
        return res.status(400).json({ error: 'Invalid slot datetime.' });
      }
    }
  } else {
    for (const s of slots) {
      if (typeof s.label !== 'string' || !s.label.trim() || s.label.length > 200) {
        return res.status(400).json({ error: 'Invalid option label.' });
      }
    }
  }

  const db = loadDB();
  const id = generateId();

  const poll = {
    id,
    type: pollType,
    title: title.trim(),
    creatorName: creatorName.trim(),
    createdAt: new Date().toISOString(),
    confirmedSlot: null,
    slots: pollType === 'question'
      ? slots.map((s, i) => ({ id: `s${i}`, label: String(s.label).trim() }))
      : slots.map((s, i) => ({ id: `s${i}`, datetime: Number(s.datetime) })),
    votes: []
  };

  db[id] = poll;
  saveDB(db);
  res.json({ id });
});

// Get a poll by ID
app.get('/api/polls/:id', (req, res) => {
  const db = loadDB();
  const poll = db[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });
  res.json(poll);
});

// Submit a vote
app.post('/api/polls/:id/vote', (req, res) => {
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

  const db = loadDB();
  const poll = db[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  // Sanitize responses: only accept valid slot IDs with valid values
  const validSlotIds   = new Set(poll.slots.map(s => s.id));
  const validSchedule  = new Set(['yes', 'maybe', 'no']);
  const sanitized = {};
  for (const [k, v] of Object.entries(responses)) {
    if (!validSlotIds.has(k)) continue;
    if (poll.type === 'schedule') {
      if (validSchedule.has(v)) sanitized[k] = v;
    } else {
      const rank = parseInt(v);
      if (Number.isInteger(rank) && rank >= 1 && rank <= poll.slots.length) sanitized[k] = String(rank);
    }
  }

  // Replace existing vote from the same name (case-insensitive)
  poll.votes = poll.votes.filter(v => v.name.toLowerCase() !== name.trim().toLowerCase());
  poll.votes.push({
    name: name.trim(),
    timezone: timezone.trim(),
    responses: sanitized,
    submittedAt: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true });
});

// Confirm a slot as the final time (admin only)
app.post('/api/polls/:id/confirm', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized.' });

  const { slotId } = req.body;
  if (!slotId || typeof slotId !== 'string') return res.status(400).json({ error: 'Missing slotId.' });

  const db = loadDB();
  const poll = db[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  const slotExists = poll.slots.some(s => s.id === slotId);
  if (!slotExists) return res.status(400).json({ error: 'Slot not found.' });

  poll.confirmedSlot = slotId;
  saveDB(db);
  res.json({ success: true });
});

// Unconfirm a slot (admin only)
app.post('/api/polls/:id/unconfirm', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized.' });

  const db = loadDB();
  const poll = db[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  poll.confirmedSlot = null;
  saveDB(db);
  res.json({ success: true });
});

// Fallback: serve index.html for all other routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── START ───────────────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Brady's Little Helper running at http://localhost:${PORT}`);
});
