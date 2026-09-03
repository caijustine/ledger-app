// Daily Work Ledger — backend
// Node 22+, no native modules. SQLite file lives in DATA_DIR (mount a volume there on Railway/Render).
import express from 'express';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const EDIT_KEY = process.env.EDIT_KEY || '';        // required to write; empty = anyone can write (local use only)
const TZ = process.env.TZ || 'America/Denver';       // day boundaries for snapshots
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'ledger.db'));
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS state     (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS snapshots (day TEXT PRIMARY KEY, json TEXT NOT NULL, saved_at TEXT NOT NULL, saves INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS events    (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, detail TEXT NOT NULL);
`);

const EMPTY = { v: 3, settings: {}, log: [], queue: [], clients: [], waiting: [] };
const todayKey = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const getState = () => { const r = db.prepare('SELECT json, updated_at FROM state WHERE id = 1').get(); return r ? { state: JSON.parse(r.json), updatedAt: r.updated_at } : { state: EMPTY, updatedAt: null }; };

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// constant-time key comparison so a leaked link can't be brute-forced by timing
const keyMatches = supplied => {
  const a = Buffer.from(String(supplied || '')), b = Buffer.from(EDIT_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const canEdit = req => !EDIT_KEY || keyMatches(req.get('x-edit-key'));
const requireEdit = (req, res, next) => canEdit(req) ? next() : res.status(403).json({ error: 'read_only', message: 'This link is read-only.' });

// who am I — the page uses this to decide whether to show controls
app.get('/api/me', (req, res) => res.json({ canEdit: canEdit(req), today: todayKey(), tz: TZ }));

// current state
app.get('/api/state', (req, res) => res.json(getState()));

// save the whole state; also freezes today's snapshot and appends an audit event
app.put('/api/state', requireEdit, (req, res) => {
  const s = req.body;
  if (!s || typeof s !== 'object' || !Array.isArray(s.log) || !Array.isArray(s.queue)
      || (s.clients !== undefined && !Array.isArray(s.clients))
      || (s.waiting !== undefined && !Array.isArray(s.waiting))) {
    return res.status(400).json({ error: 'invalid_state' });
  }
  const current = getState();
  // optimistic concurrency: reject a save built on a stale copy instead of clobbering a newer one (phone vs laptop)
  const base = req.get('x-base-version');
  if (base && current.updatedAt && base !== current.updatedAt) {
    return res.status(409).json({ error: 'conflict', message: 'The ledger was changed on another device.', state: current.state, updatedAt: current.updatedAt });
  }
  const now = new Date().toISOString(), day = todayKey(), json = JSON.stringify(s);
  const prev = current.state;
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO state (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(json, now);
    db.prepare('INSERT INTO snapshots (day, json, saved_at, saves) VALUES (?, ?, ?, 1) ON CONFLICT(day) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at, saves = saves + 1').run(day, json, now);
    const detail = summarizeChange(prev, s);
    if (detail) db.prepare('INSERT INTO events (at, day, kind, detail) VALUES (?, ?, ?, ?)').run(now, day, detail.kind, detail.text);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  res.json({ ok: true, updatedAt: now, day });
});

// history: which days have a frozen snapshot, and one day's snapshot
app.get('/api/days', (req, res) => {
  const rows = db.prepare('SELECT day, saved_at, saves FROM snapshots ORDER BY day DESC').all();
  res.json({ days: rows.map(r => ({ day: r.day, savedAt: r.saved_at, saves: r.saves })) });
});
app.get('/api/days/:day', requireEdit, (req, res) => {
  const r = db.prepare('SELECT json, saved_at, saves FROM snapshots WHERE day = ?').get(req.params.day);
  if (!r) return res.status(404).json({ error: 'no_snapshot' });
  res.json({ day: req.params.day, savedAt: r.saved_at, saves: r.saves, state: JSON.parse(r.json) });
});
// audit trail: every change, newest first
app.get('/api/events', requireEdit, (req, res) => {
  const limit = Math.min(500, parseInt(req.query.limit, 10) || 200);
  res.json({ events: db.prepare('SELECT at, day, kind, detail FROM events ORDER BY id DESC LIMIT ?').all(limit) });
});
// backups: the whole ledger + every snapshot as one JSON bundle (owner only — this is the "take everything" endpoint)
app.get('/api/export', requireEdit, (req, res) => res.json({ exportedAt: new Date().toISOString(), ...getState(), snapshots: db.prepare('SELECT day, json, saved_at FROM snapshots ORDER BY day').all().map(r => ({ day: r.day, savedAt: r.saved_at, state: JSON.parse(r.json) })) }));

function summarizeChange(a, b) {
  const dl = b.log.length - a.log.length, dq = b.queue.length - a.queue.length;
  const closedA = a.queue.filter(q => q.done).length, closedB = b.queue.filter(q => q.done).length;
  if (dl > 0) { const x = b.log[b.log.length - 1]; const name = x.kind === 'note' ? 'note: ' + x.text : (x.kind || 'log') + ' ' + (x.ref || ''); return { kind: 'log', text: `logged ${name}` }; }
  if (dl < 0) return { kind: 'log', text: `removed ${-dl} log entr${dl === -1 ? 'y' : 'ies'}` };
  if (dq > 0) { const q = b.queue[b.queue.length - 1]; return { kind: 'queue', text: `queued "${q.title}" (${q.source}${q.by ? ', by ' + q.by : ''})` }; }
  if (dq < 0) return { kind: 'queue', text: `removed ${-dq} queue item(s)` };
  if (closedB > closedA) { const q = b.queue.find(q => q.done && !a.queue.find(p => p.id === q.id && p.done)); return { kind: 'queue', text: `closed "${q ? q.title : 'item'}"` }; }
  if (closedB < closedA) return { kind: 'queue', text: 'reopened a queue item' };
  if (JSON.stringify(a.queue) !== JSON.stringify(b.queue)) return { kind: 'queue', text: 'edited a queue item' };

  // clients
  const ac = a.clients || [], bc = b.clients || [];
  if (bc.length > ac.length) { const c = bc[bc.length - 1]; return { kind: 'client', text: `added client ${c.name || 'unnamed'}${c.business ? ' (' + c.business + ')' : ''}` }; }
  if (bc.length < ac.length) return { kind: 'client', text: `removed ${ac.length - bc.length} client(s)` };
  const archA = ac.filter(c => c.status === 'archived').length, archB = bc.filter(c => c.status === 'archived').length;
  if (archB > archA) { const c = bc.find(c => c.status === 'archived' && !ac.find(p => p.id === c.id && p.status === 'archived')); return { kind: 'client', text: `archived "${c ? c.name : 'client'}"` }; }
  const obDone = list => list.reduce((n, c) => n + (c.onboarding || []).filter(o => o.done).length, 0);
  const oa = obDone(ac), ob = obDone(bc);
  if (ob > oa) {
    for (const c of bc) {
      const pc = ac.find(p => p.id === c.id); if (!pc) continue;
      const step = (c.onboarding || []).find(o => o.done && !(pc.onboarding || []).find(p => p.key === o.key && p.done));
      if (step) return { kind: 'client', text: `${c.name}: onboarding — ${step.label}` };
    }
  }
  if (ob < oa) return { kind: 'client', text: 'unchecked an onboarding step' };
  for (const c of bc) {
    const pc = ac.find(p => p.id === c.id); if (!pc) continue;
    const was = (pc.nextAction || '').trim(), now = (c.nextAction || '').trim();
    if (now && now !== was) return { kind: 'client', text: `${c.name}: next action — ${now}` };
    if (!now && was) return { kind: 'client', text: `${c.name}: cleared next action` };
  }

  // waiting
  const aw = a.waiting || [], bw = b.waiting || [];
  if (bw.length > aw.length) { const w = bw[bw.length - 1]; return { kind: 'waiting', text: `waiting on ${w.on || '?'}: ${w.what || ''}`.trim() }; }
  if (bw.length < aw.length) return { kind: 'waiting', text: `removed ${aw.length - bw.length} waiting item(s)` };
  const wDoneA = aw.filter(w => w.status === 'done').length, wDoneB = bw.filter(w => w.status === 'done').length;
  if (wDoneB > wDoneA) { const w = bw.find(w => w.status === 'done' && !aw.find(p => p.id === w.id && p.status === 'done')); return { kind: 'waiting', text: `resolved waiting: ${w ? w.what : 'item'}` }; }
  if (wDoneB < wDoneA) return { kind: 'waiting', text: 'reopened a waiting item' };

  if (JSON.stringify(a.settings) !== JSON.stringify(b.settings)) return { kind: 'settings', text: 'changed duties or actions' };
  return null;
}

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Daily Work Ledger on http://localhost:${PORT}  (data: ${DATA_DIR}, edit key ${EDIT_KEY ? 'set' : 'NOT set — anyone can edit'})`));
