import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { request } from 'http';
import { config as dotenvConfig } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Load .env from parent Charon directory so API_KEY is available for proxy
dotenvConfig({ path: resolve(__dirname, '..', '.env') });

const PORT = Number(process.env.PORT || 4000);
const DB_PATH = resolve(process.env.CHARON_DB || join(__dirname, '..', 'charon.sqlite'));

if (!existsSync(DB_PATH)) {
  console.error(`[dashboard] DB not found: ${DB_PATH}`);
  console.error('[dashboard] Set CHARON_DB env or copy charon.sqlite to the parent directory.');
  process.exit(1);
}

const db = new Database(DB_PATH, { readonly: true });
db.pragma('journal_mode = WAL');

const app = express();
app.use(express.json());

// ── Helpers ──────────────────────────────────────────────────────────────────
function cleanupRow(row) {
  if (!row) return null;
  const cleaned = { ...row };
  for (const key of ['candidate_json', 'filter_result_json', 'payload_json', 'snapshot_json', 'guardrails_json', 'token_json', 'batch_json', 'execution_json', 'risks_json', 'raw_json', 'candidate_ids_json', 'summary_json', 'lessons_json', 'evidence_json', 'config_json', 'signals_json']) {
    if (typeof cleaned[key] === 'string') {
      try { cleaned[key] = JSON.parse(cleaned[key]); } catch {}
    }
  }
  return cleaned;
}

function firstPositive(...vals) {
  for (const v of vals) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function now() { return Date.now(); }

// ── API Routes ───────────────────────────────────────────────────────────────

// Stats summary
app.get('/api/stats', (req, res) => {
  try {
    const openPositions = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status = 'open'").get().c;
    const closedPositions = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status = 'closed'").get().c;
    const totalCandidates = db.prepare('SELECT COUNT(*) as c FROM candidates').get().c;
    const totalDecisions = db.prepare('SELECT COUNT(*) as c FROM llm_decisions').get().c;
    const totalBatches = db.prepare('SELECT COUNT(*) as c FROM llm_batches').get().c;
    const signalEvents = db.prepare('SELECT COUNT(*) as c FROM signal_events').get().c;
    const pendingIntents = db.prepare("SELECT COUNT(*) as c FROM trade_intents WHERE status = 'pending_confirmation'").get().c;

    // Get live wallet entries (positions with execution_mode = 'live')
    const livePositions = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE execution_mode = 'live' AND status = 'open'").get().c;

    // PnL stats for closed positions
    const pnlRow = db.prepare(`
      SELECT COUNT(*) as cnt, SUM(pnl_sol) as total_sol, AVG(pnl_percent) as avg_pct
      FROM dry_run_positions WHERE status = 'closed'
    `).get();
    const wins = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status = 'closed' AND pnl_sol > 0").get().c;
    const losses = db.prepare("SELECT COUNT(*) as c FROM dry_run_positions WHERE status = 'closed' AND pnl_sol <= 0").get().c;

    // Get current settings
    const tradingMode = db.prepare("SELECT value FROM settings WHERE key = 'trading_mode'").get()?.value || 'dry_run';
    const agentEnabled = db.prepare("SELECT value FROM settings WHERE key = 'agent_enabled'").get()?.value || 'true';

    // Active strategy
    const stratRow = db.prepare('SELECT * FROM strategies WHERE enabled = 1 LIMIT 1').get();
    const activeStrategy = stratRow
      ? { id: stratRow.id, name: stratRow.name, ...JSON.parse(stratRow.config_json) }
      : null;

    res.json({
      openPositions,
      closedPositions,
      livePositions,
      totalCandidates,
      totalDecisions,
      totalBatches,
      signalEvents,
      pendingIntents,
      pnl: {
        totalTrades: pnlRow.cnt || 0,
        totalSol: Number(pnlRow.total_sol || 0).toFixed(4),
        avgPct: Number(pnlRow.avg_pct || 0).toFixed(1),
        wins,
        losses,
      },
      settings: { tradingMode, agentEnabled },
      activeStrategy,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Open positions
app.get('/api/positions', (req, res) => {
  try {
    const rows = db.prepare("SELECT * FROM dry_run_positions WHERE status = 'open' ORDER BY opened_at_ms DESC LIMIT 50").all();
    res.json(rows.map(r => {
      const snap = r.snapshot_json ? (() => { try { return JSON.parse(r.snapshot_json); } catch { return {}; } })() : {};
      return cleanupRow({
        ...r,
        currentPrice: snap.candidate?.metrics?.priceUsd || null,
        currentMcap: snap.candidate?.metrics?.marketCapUsd || null,
      });
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Closed positions
app.get('/api/trades', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM dry_run_positions
      WHERE status = 'closed'
      ORDER BY closed_at_ms DESC LIMIT 100
    `).all();
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// All positions (open + closed, recent)
app.get('/api/positions/all', (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM dry_run_positions
      ORDER BY id DESC LIMIT 100
    `).all();
    res.json(rows.map(r => {
      const snap = r.snapshot_json ? (() => { try { return JSON.parse(r.snapshot_json); } catch { return {}; } })() : {};
      return cleanupRow({
        ...r,
        currentPrice: snap.candidate?.metrics?.priceUsd || null,
        currentMcap: snap.candidate?.metrics?.marketCapUsd || null,
      });
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Candidates
app.get('/api/candidates', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare('SELECT * FROM candidates ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LLM Decisions
app.get('/api/decisions', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare('SELECT * FROM llm_decisions ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// LLM Batches
app.get('/api/batches', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = db.prepare('SELECT * FROM llm_batches ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Decision logs
app.get('/api/decision-logs', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare('SELECT * FROM decision_logs ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Strategies
app.get('/api/strategies', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM strategies ORDER BY id').all();
    res.json(rows.map(row => ({ id: row.id, name: row.name, enabled: Boolean(row.enabled), ...JSON.parse(row.config_json) })));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Settings
app.get('/api/settings', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM settings ORDER BY key').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Wallets
app.get('/api/wallets', (req, res) => {
  try {
    const rows = db.prepare('SELECT * FROM saved_wallets ORDER BY label').all();
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Signal events
app.get('/api/signals', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const rows = db.prepare('SELECT * FROM signal_events ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Position trades
app.get('/api/position-trades', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const rows = db.prepare('SELECT * FROM dry_run_trades ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Trade intents
app.get('/api/intents', (req, res) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 30, 100);
    const rows = db.prepare('SELECT * FROM trade_intents ORDER BY id DESC LIMIT ?').all(limit);
    res.json(rows.map(cleanupRow));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Learning runs & lessons
app.get('/api/learning', (req, res) => {
  try {
    const runs = db.prepare('SELECT * FROM learning_runs ORDER BY id DESC LIMIT 10').all().map(cleanupRow);
    const lessons = db.prepare("SELECT * FROM learning_lessons WHERE status = 'active' ORDER BY id DESC LIMIT 20").all().map(cleanupRow);
    res.json({ runs, lessons });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Proxy to Charon API (trading endpoints) ─────────────────────────────────
const CHARON_API = process.env.CHARON_API || 'http://127.0.0.1:4001';

function proxyToCharon(req, res) {
  const url = new URL(req.originalUrl, CHARON_API);
  const bodyStr = req.body && Object.keys(req.body).length ? JSON.stringify(req.body) : '{}';
  const buf = Buffer.from(bodyStr, 'utf-8');
  const options = {
    hostname: url.hostname,
    port: url.port,
    path: url.pathname + url.search,
    method: req.method,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': buf.length,
      ...(process.env.API_KEY ? { 'x-api-key': process.env.API_KEY } : {}),
    },
  };
  const proxyReq = request(options, (proxyRes) => {
    let data = '';
    proxyRes.on('data', chunk => data += chunk);
    proxyRes.on('end', () => {
      try { res.status(proxyRes.statusCode).json(JSON.parse(data)); }
      catch { res.status(proxyRes.statusCode).send(data); }
    });
  });
  proxyReq.on('error', err => res.status(502).json({ error: `Charon API unreachable: ${err.message}` }));
  proxyReq.write(buf);
  proxyReq.end();
}

app.post('/api/close-position/:id', proxyToCharon);
app.post('/api/toggle-trailing/:id', proxyToCharon);
app.patch('/api/position/:id/rule', proxyToCharon);
app.post('/api/execute-buy/:candidateId', proxyToCharon);
app.patch('/api/settings', proxyToCharon);
app.patch('/api/strategy/:id', proxyToCharon);
app.post('/api/strategy/:id/activate', proxyToCharon);

// Serve static files
app.use(express.static(join(__dirname, 'public')));

// SPA fallback
app.get('*', (req, res) => {
  res.sendFile(join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[dashboard] Charon Dashboard running on http://0.0.0.0:${PORT}`);
  console.log(`[dashboard] DB: ${DB_PATH}`);
});
