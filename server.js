const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'polls.json');

// ─── AUTH ─────────────────────────────────────────────────────────────────────

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'brady';
const sessions = new Map(); // token → expiry timestamp

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

app.use(express.json());
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
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) {
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
  const { title, creatorName, slots } = req.body;

  if (!title || !creatorName || !Array.isArray(slots) || slots.length === 0) {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const db = loadDB();
  const id = generateId();

  const poll = {
    id,
    title: title.trim(),
    creatorName: creatorName.trim(),
    createdAt: new Date().toISOString(),
    confirmedSlot: null,
    slots: slots.map((s, i) => ({
      id: `s${i}`,
      datetime: s.datetime  // stored as UTC milliseconds
    })),
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

  if (!name || !timezone || !responses || typeof responses !== 'object') {
    return res.status(400).json({ error: 'Missing required fields.' });
  }

  const db = loadDB();
  const poll = db[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  // Replace existing vote from the same name (case-insensitive)
  poll.votes = poll.votes.filter(v => v.name.toLowerCase() !== name.trim().toLowerCase());
  poll.votes.push({
    name: name.trim(),
    timezone,
    responses,
    submittedAt: new Date().toISOString()
  });

  saveDB(db);
  res.json({ success: true });
});

// Confirm a slot as the final time
app.post('/api/polls/:id/confirm', (req, res) => {
  const { slotId } = req.body;
  if (!slotId) return res.status(400).json({ error: 'Missing slotId.' });

  const db = loadDB();
  const poll = db[req.params.id];
  if (!poll) return res.status(404).json({ error: 'Poll not found.' });

  const slotExists = poll.slots.some(s => s.id === slotId);
  if (!slotExists) return res.status(400).json({ error: 'Slot not found.' });

  poll.confirmedSlot = slotId;
  saveDB(db);
  res.json({ success: true });
});

// Unconfirm a slot
app.post('/api/polls/:id/unconfirm', (req, res) => {
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
  console.log(`Brady's Calendar Tool running at http://localhost:${PORT}`);
});
