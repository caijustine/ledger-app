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
  CREATE TABLE IF NOT EXISTS reports   (id INTEGER PRIMARY KEY AUTOINCREMENT, type TEXT NOT NULL, period_start TEXT NOT NULL, period_end TEXT NOT NULL, generated_at TEXT NOT NULL, updated_at TEXT NOT NULL, model TEXT NOT NULL, digest_json TEXT NOT NULL, text TEXT NOT NULL, edited INTEGER NOT NULL DEFAULT 0, UNIQUE(type, period_start, period_end));
  CREATE TABLE IF NOT EXISTS slack_events (event_id TEXT PRIMARY KEY, received_at TEXT NOT NULL);
`);

const EMPTY = { v: 3, settings: {}, log: [], queue: [], clients: [], waiting: [] };
const todayKey = () => {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const g = t => p.find(x => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
};
const getState = () => { const r = db.prepare('SELECT json, updated_at FROM state WHERE id = 1').get(); return r ? { state: JSON.parse(r.json), updatedAt: r.updated_at } : { state: EMPTY, updatedAt: null }; };

const app = express();
// keep the raw bytes too — the Slack webhook has to verify its signature over the exact body
app.use(express.json({ limit: '10mb', verify: (req, res, buf) => { req.rawBody = buf; } }));
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

// ===================== AI reports =====================
// Reads the live state and asks Claude for an honest, grounded report. Nothing here
// touches the client/queue/waiting/log schema — it's a read-only digest of existing
// data plus its own `reports` table. Degrades cleanly (503) if ANTHROPIC_API_KEY isn't
// set; the rest of the app is unaffected either way.

const addDays = (key, n) => {
  const [y, m, d] = key.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
};
const daysSince = iso => iso ? Math.floor((Date.now() - new Date(iso)) / 86400000) : null;

// Mirrors clientHealth() in public/index.html (kept minimal — just enough for the
// digest). If the health rules change there, update here too.
const lastContacted = (state, clientId) => {
  const ts = state.log.filter(x => x.clientId === clientId && (x.kind === 'contact' || x.kind === 'note')).map(x => x.ts).sort();
  return ts.length ? ts[ts.length - 1] : null;
};
const openRequests = (state, clientId) => state.queue.filter(q => q.clientId === clientId && q.source === 'client' && !q.done);
const openWaitingFor = (state, clientId) => state.waiting.filter(w => w.clientId === clientId && w.status === 'open');
function clientHealth(state, c, today) {
  if (c.status === 'archived' || c.status === 'paused') return { level: 'neutral', reasons: [] };
  const reasons = [];
  const since = daysSince(lastContacted(state, c.id));
  const overdueReq = openRequests(state, c.id).some(q => q.due && q.due < today);
  const overdueWait = openWaitingFor(state, c.id).some(w => w.due && w.due < today);
  if (overdueReq) reasons.push('overdue request');
  if (overdueWait) reasons.push('overdue waiting item');
  if (!(c.nextAction || '').trim()) reasons.push('no next action');
  if (since === null && daysSince(c.createdAt) >= 3) reasons.push('never contacted');
  else if (since !== null && since >= 8) reasons.push(`no contact in ${since} days`);
  const red = overdueReq || overdueWait || (since !== null && since >= 14);
  return { level: reasons.length === 0 ? 'green' : red ? 'red' : 'yellow', reasons };
}

function isStateEmpty(state) {
  return !(state.clients || []).length && !(state.log || []).length && !(state.queue || []).length && !(state.waiting || []).length;
}

function buildDigest(state, type, start, end, today) {
  const inPeriod = k => !!k && k >= start && k <= end;
  const clients = state.clients || [];
  const activeC = clients.filter(c => c.status !== 'archived');
  const nameOf = id => { const c = clients.find(x => x.id === id); return c ? c.name : null; };

  const notes = state.log.filter(x => (x.kind === 'note' || x.kind === 'contact') && inPeriod(x.day))
    .map(x => ({ text: x.text, client: nameOf(x.clientId) }));
  const actions = state.log.filter(x => x.kind === 'tap' && inPeriod(x.day)).length;
  const dutyPasses = state.log.filter(x => x.kind === 'duty' && inPeriod(x.day)).length;

  const queueLanded = state.queue.filter(q => inPeriod(q.day))
    .map(q => ({ title: q.title, category: q.cat, source: q.source, client: nameOf(q.clientId) || q.client || null, due: q.due || null }));
  const queueClosed = state.queue.filter(q => q.done && inPeriod(q.doneDay))
    .map(q => ({ title: q.title, category: q.cat, client: nameOf(q.clientId) || q.client || null }));

  const waitingCreated = state.waiting.filter(w => inPeriod((w.createdAt || '').slice(0, 10)))
    .map(w => ({ what: w.what, waitingOn: w.on, type: w.type, client: nameOf(w.clientId) }));
  const waitingResolved = state.waiting.filter(w => w.status === 'done' && inPeriod((w.doneAt || '').slice(0, 10)))
    .map(w => ({ what: w.what, client: nameOf(w.clientId) }));

  const onboardingCompleted = [];
  clients.forEach(c => (c.onboarding || []).forEach(o => {
    if (o.done && inPeriod((o.doneAt || '').slice(0, 10))) onboardingCompleted.push({ client: c.name, step: o.label });
  }));
  const newClients = clients.filter(c => inPeriod((c.createdAt || '').slice(0, 10))).map(c => ({ name: c.name, business: c.business }));

  // current status of every active client — not period-filtered, so "at risk"/"outstanding"
  // are accurate even on a quiet day
  const currentClients = activeC.map(c => {
    const h = clientHealth(state, c, today);
    return {
      name: c.name, business: c.business, status: c.status, health: h.level, healthReasons: h.reasons,
      nextAction: c.nextAction || null, daysSinceContact: daysSince(lastContacted(state, c.id)),
      openRequests: openRequests(state, c.id).length, openWaitingItems: openWaitingFor(state, c.id).length,
      onboardingProgress: c.onboarding && c.onboarding.length ? `${c.onboarding.filter(o => o.done).length}/${c.onboarding.length}` : null,
    };
  });
  const currentlyOverdue = {
    requests: state.queue.filter(q => !q.done && q.due && q.due < today)
      .map(q => ({ title: q.title, client: nameOf(q.clientId) || q.client || null, daysOverdue: daysSince(q.due) })),
    waiting: state.waiting.filter(w => w.status === 'open' && w.due && w.due < today)
      .map(w => ({ what: w.what, client: nameOf(w.clientId), daysOverdue: daysSince(w.due) })),
  };

  return {
    period: { type, start, end }, dutyPasses, actionsLogged: actions, notes, newClients,
    queueLanded, queueClosed, waitingCreated, waitingResolved, onboardingCompleted,
    currentClients, currentlyOverdue,
  };
}

const COMMON_RULES = `You are writing a short work update for a solo local-services growth/marketing operator who manages several small-business clients (Google Business Profile, websites, onboarding, payments, CRM entries). You're given a JSON "digest" of real, logged data for a period, plus the current status of every active client. Write from that data only — this update goes straight to their boss, so it needs to be professional, but written like a person, not a corporate report.

Rules:
- Write a few short, natural paragraphs — NOT a bulleted or dashed list, NOT section headers in all caps. Just plain connected prose, like a message someone would actually send.
- Cover, in roughly this order: what meaningfully got done, what's still outstanding (name real urgency plainly, e.g. "which is now a few days overdue" — only if the digest actually shows it's overdue), anything genuinely at risk of falling through the cracks (leave this out entirely if nothing stands out — never manufacture a risk), and close with what's planned next.
- Never invent an accomplishment, client detail, or number that isn't in the digest. If there's truly nothing to report for a period, say so plainly in one line instead of padding it.
- Distinguish meaningful work from trivial activity. Do not just restate counts ("sent 14 texts, logged 3 notes") — describe what the activity actually accomplished ("followed up with several clients on onboarding and outstanding account information").
- When the digest shows a pattern across multiple clients (several waiting on the same thing, several missing the same information, several requests overdue, the same operational problem recurring), name the pattern instead of listing each client separately.
- No generic AI corporate language — no "leveraged", "synergy", "circle back", "in today's fast-paced environment", etc.
- Reply with the update itself as plain text only. No JSON, no markdown formatting, no preamble like "Here's your report" — just the message, ready to send.`;

const TYPE_NOTE = {
  daily: 'This covers today only. Close by naming what you plan to focus on next — not a numbered list, just say it naturally.',
  weekly: 'This covers the trailing 7 days. Mention a couple of the week\'s real highlights and any problem that came up more than once, and close with what you\'re focusing on next week instead of tomorrow.',
};

async function callAnthropic(system, digest, maxTokens) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) { const e = new Error('ANTHROPIC_API_KEY not set'); e.code = 'not_configured'; throw e; }
  const model = process.env.REPORT_MODEL || 'claude-sonnet-5';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: JSON.stringify(digest) }] }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const e = new Error(`Anthropic API ${res.status}: ${body.slice(0, 300)}`); e.code = 'ai_failed'; throw e;
  }
  const json = await res.json();
  const text = (json.content || []).map(b => b.text || '').join('').trim();
  return { model, text };
}

function rowOut(r) {
  return { id: r.id, type: r.type, periodStart: r.period_start, periodEnd: r.period_end, generatedAt: r.generated_at, updatedAt: r.updated_at, model: r.model, edited: !!r.edited, text: r.text };
}
function findReport(type, start, end) {
  return db.prepare('SELECT * FROM reports WHERE type = ? AND period_start = ? AND period_end = ?').get(type, start, end);
}

// generate (or refresh) a report (owner only — spends API credits and reads full client detail).
// respectEdits: true is used by the client's background auto-update (fired when a task/request/
// onboarding step is completed) — if this period's draft has been hand-edited, it's skipped
// entirely (no API call, edits are never silently overwritten). A direct "Update" click always
// omits respectEdits and regenerates.
app.post('/api/reports/generate', requireEdit, async (req, res) => {
  const type = req.body && req.body.type;
  if (!['daily', 'weekly'].includes(type)) return res.status(400).json({ error: 'invalid_type' });
  const today = todayKey();
  const start = type === 'weekly' ? addDays(today, -6) : today;

  const existing = findReport(type, start, today);
  if (req.body.respectEdits && existing && existing.edited) {
    return res.json({ ...rowOut(existing), skipped: true });
  }

  const { state } = getState();
  const digest = buildDigest(state, type, start, today, today);
  const now = new Date().toISOString();

  const upsert = (model, text) => {
    db.prepare(`INSERT INTO reports (type, period_start, period_end, generated_at, updated_at, model, digest_json, text, edited)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
      ON CONFLICT(type, period_start, period_end) DO UPDATE SET
        generated_at = excluded.generated_at, updated_at = excluded.updated_at, model = excluded.model,
        digest_json = excluded.digest_json, text = excluded.text, edited = 0`)
      .run(type, start, today, now, now, model, JSON.stringify(digest), text);
    res.json(rowOut(findReport(type, start, today))); // re-read so the id is always correct, insert or update
  };

  if (isStateEmpty(state)) {
    return upsert('none', 'Nothing has been logged yet — add a client and some activity first.');
  }

  const system = COMMON_RULES + '\n\n' + TYPE_NOTE[type];
  const maxTokens = type === 'weekly' ? 900 : 500;
  try {
    const { model, text } = await callAnthropic(system, digest, maxTokens);
    upsert(model, text);
  } catch (e) {
    if (e.code === 'not_configured') return res.status(503).json({ error: 'ai_not_configured', message: 'Set ANTHROPIC_API_KEY on the server to enable AI reports.' });
    console.error('report generation failed:', e.message);
    res.status(502).json({ error: 'ai_failed', message: 'Could not generate the report — try again in a moment.' });
  }
});

// history list (light) and one full report
app.get('/api/reports', requireEdit, (req, res) => {
  const t = req.query.type;
  const rows = ['daily', 'weekly'].includes(t)
    ? db.prepare('SELECT * FROM reports WHERE type = ? ORDER BY period_start DESC').all(t)
    : db.prepare('SELECT * FROM reports ORDER BY period_start DESC').all();
  res.json({ reports: rows.map(rowOut) });
});
app.get('/api/reports/:id', requireEdit, (req, res) => {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json(rowOut(r));
});
// save a hand edit — marks it edited so auto-updates leave it alone from then on
app.put('/api/reports/:id', requireEdit, (req, res) => {
  const text = req.body && req.body.text;
  if (typeof text !== 'string') return res.status(400).json({ error: 'invalid_text' });
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(req.params.id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  const now = new Date().toISOString();
  db.prepare('UPDATE reports SET text = ?, edited = 1, updated_at = ? WHERE id = ?').run(text, now, r.id);
  res.json(rowOut({ ...r, text, edited: 1, updated_at: now }));
});

// ===================== integrations: Slack =====================
// Channel rules live in the state blob (S.settings.slackRules) — user-editable config,
// same reasoning as duties/taps: autosaved, snapshotted, Litestream-backed for free.
// Queue items themselves keep the client/queue/waiting schema untouched except for three
// new optional fields (detail, slackChannelId, slackChannelType) normalize()'d client-side.

async function slackApi(method, params) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) { const e = new Error('SLACK_BOT_TOKEN not set'); e.code = 'not_configured'; throw e; }
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(params || {}),
  });
  const j = await res.json();
  if (!j.ok) { const e = new Error(j.error || 'slack_error'); e.code = 'slack_error'; e.slackError = j.error; throw e; }
  return j;
}

// constant-time HMAC check on the exact bytes Slack signed — same idiom as keyMatches()
// above. This endpoint has no x-edit-key guard (Slack can't send one); this is its auth.
function verifySlackSignature(req) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  const ts = req.get('X-Slack-Request-Timestamp'), sig = req.get('X-Slack-Signature');
  if (!secret || !ts || !sig || !req.rawBody) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false; // reject anything older than 5 minutes (replay protection)
  const hmac = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${req.rawBody}`).digest('hex');
  const a = Buffer.from(hmac), b = Buffer.from(sig);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

let teamDomainCache = null;
async function getTeamDomain() {
  if (teamDomainCache) return teamDomainCache;
  try { const j = await slackApi('team.info', {}); teamDomainCache = (j.team && j.team.domain) || null; } catch (e) {}
  return teamDomainCache;
}
const slackPermalink = (domain, channel, ts) => domain ? `https://${domain}.slack.com/archives/${channel}/p${ts.replace('.', '')}` : null;

const userNameCache = new Map();
async function slackUserName(userId) {
  if (!userId) return 'someone';
  if (userNameCache.has(userId)) return userNameCache.get(userId);
  try {
    const j = await slackApi('users.info', { user: userId });
    const name = (j.user && (j.user.real_name || j.user.name)) || userId;
    userNameCache.set(userId, name);
    return name;
  } catch (e) { return userId; }
}

// server-side writer, independent of the browser's PUT /api/state — an open tab just sees
// this as "changed on another device" and the existing x-base-version 409 path handles it.
function writeState(mutateFn, auditText) {
  const current = getState();
  const next = mutateFn(JSON.parse(JSON.stringify(current.state)));
  const now = new Date().toISOString(), day = todayKey(), json = JSON.stringify(next);
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO state (id, json, updated_at) VALUES (1, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at').run(json, now);
    db.prepare('INSERT INTO snapshots (day, json, saved_at, saves) VALUES (?, ?, ?, 1) ON CONFLICT(day) DO UPDATE SET json = excluded.json, saved_at = excluded.saved_at, saves = saves + 1').run(day, json, now);
    if (auditText) db.prepare('INSERT INTO events (at, day, kind, detail) VALUES (?, ?, ?, ?)').run(now, day, 'slack', auditText);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return { state: next, updatedAt: now };
}

// connection status — confirms the bot token is real and shows which workspace it's for
app.get('/api/integrations/slack', requireEdit, async (req, res) => {
  try {
    const j = await slackApi('auth.test', {});
    res.json({ connected: true, team: j.team, user: j.user });
  } catch (e) {
    if (e.code === 'not_configured') return res.json({ connected: false, message: 'Set SLACK_BOT_TOKEN on the server to connect Slack.' });
    res.json({ connected: false, message: e.slackError ? `Slack rejected the token: ${e.slackError}.` : 'Could not reach Slack — try again in a moment.' });
  }
});

// turn a plain channel name into its Slack ID for the rule editor, and confirm the bot can see it
app.post('/api/integrations/slack/resolve-channel', requireEdit, async (req, res) => {
  const name = String((req.body && req.body.channelName) || '').trim().replace(/^#/, '');
  if (!name) return res.status(400).json({ ok: false, message: 'Enter a channel name.' });
  try {
    let cursor;
    for (let i = 0; i < 20; i++) {
      const j = await slackApi('conversations.list', { types: 'public_channel,private_channel', limit: 200, cursor });
      const hit = (j.channels || []).find(c => c.name === name);
      if (hit) return res.json({ ok: true, channelId: hit.id, isMember: !!hit.is_member });
      cursor = j.response_metadata && j.response_metadata.next_cursor;
      if (!cursor) break;
    }
    res.json({ ok: false, message: `No channel named "${name}" found — check the spelling, or the bot may need the channels:read scope.` });
  } catch (e) {
    if (e.code === 'not_configured') return res.status(503).json({ ok: false, message: 'Set SLACK_BOT_TOKEN first.' });
    res.status(502).json({ ok: false, message: e.slackError ? `Slack error: ${e.slackError}` : 'Could not reach Slack.' });
  }
});

// the actual webhook — Slack posts every message event here
app.post('/api/slack/events', async (req, res) => {
  const body = req.body || {};
  if (body.type === 'url_verification') {
    if (!verifySlackSignature(req)) return res.status(401).end();
    return res.json({ challenge: body.challenge });
  }
  if (!verifySlackSignature(req)) return res.status(401).end();
  res.status(200).end(); // ack within Slack's 3s window; everything below happens after

  try {
    const eventId = body.event_id;
    if (eventId) {
      if (db.prepare('SELECT 1 FROM slack_events WHERE event_id = ?').get(eventId)) return;
      db.prepare('INSERT INTO slack_events (event_id, received_at) VALUES (?, ?)').run(eventId, new Date().toISOString());
    }
    const event = body.event;
    // real new messages only — skip edits/deletes/joins and (once replies go out) the bot's own messages
    if (!event || event.type !== 'message' || event.subtype || event.bot_id) return;
    const text = (event.text || '').trim();
    if (!text) return;

    const state = getState().state;
    const senderName = await slackUserName(event.user);
    const now = new Date().toISOString(), today = todayKey();

    if (event.channel_type === 'im') {
      const item = { id: crypto.randomUUID(), title: `Reply to ${senderName} on Slack`, cat: 'slack', source: 'slack',
        by: senderName, client: '', clientId: null, due: '', day: today, ts: now, done: false,
        detail: text, slackChannelId: event.channel, slackChannelType: 'im' };
      writeState(s => { s.queue = s.queue || []; s.queue.push(item); return s; }, `Slack DM from ${senderName}: ${text.slice(0, 80)}`);
      return;
    }

    const rules = (state.settings && state.settings.slackRules) || [];
    const rule = rules.find(r => r.channelId === event.channel);
    if (!rule) return; // only the channels the owner has mapped create tasks
    const domain = await getTeamDomain();
    const permalink = slackPermalink(domain, event.channel, event.ts);
    const item = { id: crypto.randomUUID(), title: rule.title, cat: rule.cat || 'other', source: 'slack',
      by: senderName, client: '', clientId: null, due: '', day: today, ts: now, done: false,
      detail: `${text}${permalink ? '\n' + permalink : ''}`, slackChannelId: event.channel, slackChannelType: 'channel' };
    writeState(s => { s.queue = s.queue || []; s.queue.push(item); return s; }, `Slack #${rule.channelName}: ${rule.title}`);
  } catch (e) {
    console.error('slack event handling failed:', e.message);
  }
});

// reply to a Slack DM straight from the Ledger — also closes out the queue item
app.post('/api/slack/reply', requireEdit, async (req, res) => {
  const queueItemId = req.body && req.body.queueItemId, text = req.body && req.body.text;
  if (!queueItemId || !text || !String(text).trim()) return res.status(400).json({ error: 'invalid_input' });
  const { state } = getState();
  const item = (state.queue || []).find(q => q.id === queueItemId);
  if (!item || !item.slackChannelId) return res.status(404).json({ error: 'not_found' });
  try {
    await slackApi('chat.postMessage', { channel: item.slackChannelId, text: String(text) });
  } catch (e) {
    if (e.code === 'not_configured') return res.status(503).json({ error: 'not_configured', message: 'Set SLACK_BOT_TOKEN first.' });
    return res.status(502).json({ error: 'slack_failed', message: e.slackError ? `Slack rejected it: ${e.slackError}` : 'Could not reach Slack.' });
  }
  const now = new Date().toISOString();
  const written = writeState(s => {
    const q = (s.queue || []).find(x => x.id === queueItemId);
    if (q) { q.done = true; q.doneDay = todayKey(); q.doneTs = now; }
    return s;
  }, `Replied on Slack: ${String(text).slice(0, 80)}`);
  res.json({ ok: true, updatedAt: written.updatedAt });
});

app.use(express.static(path.join(__dirname, 'public')));
app.listen(PORT, () => console.log(`Daily Work Ledger on http://localhost:${PORT}  (data: ${DATA_DIR}, edit key ${EDIT_KEY ? 'set' : 'NOT set — anyone can edit'}, ai reports ${process.env.ANTHROPIC_API_KEY ? 'configured' : 'NOT configured'}, slack ${process.env.SLACK_BOT_TOKEN ? 'token set' : 'not configured'})`));
